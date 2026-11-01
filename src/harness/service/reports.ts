import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { log, logError } from "../../common/log.ts";
import { type KeyPairPem, reportBody, signJson } from "../../core/commands.ts";
import { isRigCheck } from "../../core/ids.ts";
import { liveGroups } from "../../core/link/live.ts";
import { type LiveEntry, liveBody } from "../../core/live.ts";
import { writeExport } from "../outbox.ts";
import type { HarnessService } from "./index.ts";

/**
 * What the harness reports through its supervisor: the live log and the snapshot of events and
 * summary, each signed with the rig's own key (`rigKeys`, when it has one), and its exports.
 */

/**
 * Lines of the live log after `after`, as the message bus's messages: the lines of each run's
 * source in a batch of their own (core/link/live.ts), each signed like a whole batch.
 */
export function liveMessages(
  svc: HarnessService,
  rigKeys: KeyPairPem | undefined,
  after: number,
  limit: number,
): unknown {
  const { entries, next } = svc.live.since(after, limit);
  const batch = { rig: svc.rig, log_id: svc.live.id, from: after, next };
  return {
    log_id: svc.live.id,
    next,
    messages: liveGroups(entries).map((group) =>
      signedLines(rigKeys, { ...batch, entries: group }),
    ),
  };
}

/** A batch of live lines, signed with the rig's key when it has one. */
function signedLines(
  rigKeys: KeyPairPem | undefined,
  batch: { rig: string; log_id: string; from: number; next: number; entries: LiveEntry[] },
): unknown {
  return rigKeys
    ? {
        ...batch,
        rig_pubkey: rigKeys.publicKeyPem,
        signature: signJson(liveBody(batch), rigKeys.privateKeyPem),
      }
    : batch;
}

/**
 * A page of events with the current summary, signed with the rig's own key so that control
 * can tell the harness's report from anything the supervisor (which relays it) might invent.
 */
export function snapshot(
  svc: HarnessService,
  rigKeys: KeyPairPem | undefined,
  cursor: number,
  limit: number,
): unknown {
  const page = svc.ledger.eventsAfter(cursor, limit);
  const report = {
    rig: svc.rig,
    ledger_id: svc.ledger.ledgerId(),
    cursor,
    next: page.next,
    events: page.events,
    summary: {
      ...(svc.ledger.summary() as Record<string, unknown>),
      ...(svc.hardware ? { hardware: svc.hardware } : {}),
      ...(svc.build ? { build: svc.build } : {}),
      // Which model route the agents use (its name and the key's hint, never the key).
      ...(svc.models ? { model: svc.models.info() } : {}),
      // What runs on this rig and how (Edit rig).
      settings: svc.settings.get(),
      ...(svc.settings.unreadable ? { settings_unreadable: svc.settings.unreadable } : {}),
      // What still runs, and whether the rig drains (goal 079): control restarts a draining
      // rig once nothing runs.
      work: svc.work(),
      // The rig's free disk against its floor, as last read, and its loops' ages (goal 173).
      ...(svc.disk ? { disk: svc.disk.summary() } : {}),
      loops: svc.loops.health().loops,
      ...(svc.gpuSplit ? { gpu_split: svc.gpuSplit } : {}),
      ...(svc.subscriptionUsage && svc.models?.info().source !== "none"
        ? {
            subscription_usage: {
              ...svc.subscriptionUsage,
              provider: svc.models?.info().name ?? null,
            },
          }
        : {}),
    },
    generated_at: svc.clock().toISOString(),
    latest_event: svc.ledger.latestEventId(),
  };
  return rigKeys
    ? {
        ...report,
        rig_pubkey: rigKeys.publicKeyPem,
        signature: signJson(reportBody(report), rigKeys.privateKeyPem),
      }
    : report;
}

/** An export's name, as the harness makes them: the outbox holds nothing else it removes. */
const EXPORT_FOLDER = /^[0-9TZ]+-[0-9a-f]{8}$/;

/** What an outbox folder's manifest says of a run's export; nothing for one it can't read. */
function manifestOf(dir: string): { run?: unknown; end?: unknown; through_event?: unknown } {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    // A manifest that can't be read names no run: the folder stays, for the owner to look at.
    return {};
  }
}

/** Whether an export folder holds a run's export (outside the chain, so the ledger records none). */
const runExport = (dir: string) => typeof manifestOf(dir).run === "string";

/**
 * Exports the supervisor has pushed (or committed, without a remote) leave the outbox, so it
 * does not grow forever: those the ledger records, and runs' exports, which it does not.
 */
export function removeExports(svc: HarnessService, names: string[]): number {
  let removed = 0;
  for (const name of names) {
    if (!EXPORT_FOLDER.test(name)) continue;
    const dir = join(svc.paths.outboxDir, name);
    if (!existsSync(dir)) continue;
    if (!svc.ledger.exports.at(name) && !runExport(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * An export for the supervisor: normal, full or one run's (outbox.ts says what each holds). At the
 * disk floor it is refused with the reason (goal 173): an export copies the whole ledger.
 */
export async function exportForSupervisor(
  svc: HarnessService,
  actor: string,
  o: { full?: boolean; run?: string | undefined; end?: boolean },
) {
  svc.disk?.check();
  svc.disk?.refuseAtFloor(o.full ? "a full export" : o.run ? `an export of ${o.run}` : "an export");
  return writeExport({
    ledger: svc.ledger,
    mirrorFor: (repo) => svc.mirrorFor(repo),
    outboxDir: svc.paths.outboxDir,
    rig: svc.rig,
    actor,
    ...o,
    researchDir: o.full || o.run ? join(svc.paths.stateDir, "research") : undefined,
    researchFolder: svc.researchFolder,
  });
}

/** How long a run's export at its end waits after it failed before it is tried again. */
const END_EXPORT_RETRY_MS = 10 * 60_000;
/** When each run's export at its end last failed, for each service: kept in memory only. */
const END_EXPORT_FAILED = new WeakMap<HarnessService, Map<string, number>>();

/**
 * Each run's export at its end, for the supervisor to push or send, while the rig's setting
 * `exports` is on (the exports loop calls this). Once a run is closed and its closing work is done
 * (every trial of it ended, the judge's job under way for it ended, and a research run's final
 * report written, or failed in this process: `closingFailed`), the harness writes that run's
 * export, whose manifest says `"end": true`, with the run's champion when it is not published yet
 * (outbox.ts), and records `run_end_exported` in the ledger. That
 * record makes it once: a restart exports a run that closed without one, and never one that has
 * one. A run that closed while the setting was off exports once it is on again. The rig's own
 * checks are runs too, and export nothing. At the disk floor it waits: the rig says why, once
 * (disk.ts). An export that fails is logged and tried again after END_EXPORT_RETRY_MS. Returns
 * the names of the exports written.
 */
export async function exportRunEnds(
  svc: HarnessService,
  actor: string,
  closingFailed: (run: string) => boolean,
): Promise<string[]> {
  if (!svc.settings.get().exports) return [];
  const failed = END_EXPORT_FAILED.get(svc) ?? new Map<string, number>();
  END_EXPORT_FAILED.set(svc, failed);
  const written: string[] = [];
  for (const r of svc.ledger.runs.endsToExport()) {
    if (isRigCheck(r.campaign)) continue;
    const finalDue =
      r.mode === "research" &&
      svc.ledger.events.count("research_final", { subject: r.id }) === 0 &&
      !closingFailed(r.id);
    if (finalDue) continue;
    const now = svc.clock().getTime();
    const failedAt = failed.get(r.id);
    if (failedAt !== undefined && now - failedAt < END_EXPORT_RETRY_MS) continue;
    if (svc.disk?.held) break;
    try {
      const out = await exportForSupervisor(svc, actor, { run: r.id, end: true });
      svc.ledger.appendEvent(actor, "run_end_exported", r.id, {
        export: out.name,
        through_event: out.through_event,
      });
      failed.delete(r.id);
      written.push(out.name);
      log("harness", "the run's export at its end is written", { run: r.id, export: out.name });
    } catch (err) {
      // The disk reached its floor as it was read again: the export waits, and is no failure.
      if (svc.disk?.held) break;
      failed.set(r.id, now);
      logError("harness", "the run's export at its end failed: it is tried again in 10 minutes", {
        run: r.id,
        error: errorText(err),
      });
    }
  }
  return written;
}

/**
 * At the harness's start, before its API answers: a run's export at its end that a crash left
 * unrecorded (in the outbox, with no `run_end_exported` for its run) is recorded now, so the run's
 * end is not exported twice. Nothing takes an export from the outbox but the harness itself, so
 * one written before the crash is still there. Returns how many it recorded.
 */
export function recordRunEndsInOutbox(svc: HarnessService): number {
  const outbox = svc.paths.outboxDir;
  if (!existsSync(outbox)) return 0;
  let recorded = 0;
  for (const name of readdirSync(outbox)
    .filter((n) => EXPORT_FOLDER.test(n))
    .sort()) {
    const m = manifestOf(join(outbox, name));
    if (typeof m.run !== "string" || m.end !== true) continue;
    if (svc.ledger.events.count("run_end_exported", { subject: m.run })) continue;
    svc.ledger.appendEvent("harness", "run_end_exported", m.run, {
      export: name,
      through_event: Number(m.through_event ?? 0),
    });
    log("harness", "a run's export at its end, written before a restart, is recorded", {
      run: m.run,
      export: name,
    });
    recorded++;
  }
  return recorded;
}

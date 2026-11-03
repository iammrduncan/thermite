import { statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { errorText, Refusal } from "../common/errors.ts";
import { folderBytes } from "../common/fs.ts";
import { log } from "../common/log.ts";
import type { CommandPayloads } from "../core/commands.ts";
import {
  kindOf,
  packItems,
  type RetentionItem,
  type RetentionRemoved,
  removedBody,
  type SpaceInventory,
  wouldRemove,
} from "../core/retention/index.ts";
import { BUILD_KEY, removeBuild } from "./judge/index.ts";
import type { Ledger } from "./ledger/index.ts";
import { removeSessions, sessionItems } from "./sessions.ts";

/**
 * The owner's retention policies on the rig (core/retention/): what the harness keeps of the
 * kinds a policy may remove here, for control's preview, and a policy run on a signed command.
 * The harness removes the judge's builds and the trials' session logs (sessions.ts); the advisors' records are its supervisor's, which
 * removes them once the harness took the command, and tells the harness what went. Every removal
 * is a `retention_removed` event, which reaches control as any event does.
 */

/** Where the judge's builds are kept, under the harness's state (judge/builds.ts). */
export const buildsDir = (stateDir: string): string => join(stateDir, "builds");

/** Each build's bytes, by its folder and time: a build never changes once stored. */
const SIZES = new Map<string, { at: number; bytes: number }>();

/** A build's folder's time and bytes; undefined when it is gone. */
function sizeOf(dir: string): { at: number; bytes: number } | undefined {
  let at: number;
  try {
    at = statSync(join(dir, "manifest.json")).mtimeMs;
  } catch {
    return undefined;
  }
  const kept = SIZES.get(dir);
  if (kept?.at === at) return kept;
  const size = { at, bytes: folderBytes(dir) };
  SIZES.set(dir, size);
  return size;
}

/**
 * The judge's stored builds as a policy reads them: each with when it was made (its folder's, so a
 * build made again is new), its run, whether that run is open and whether it is a champion's.
 * `busy`: a judge's job of its commit is queued or under way, so no policy removes it now.
 */
function buildItems(
  ledger: Ledger,
  stateDir: string,
): { items: RetentionItem[]; busy: Set<string> } {
  const dir = buildsDir(stateDir);
  const items: RetentionItem[] = [];
  const busy = new Set<string>();
  for (const f of ledger.builds.retentionFacts()) {
    if (!BUILD_KEY.test(f.key)) continue;
    const size = sizeOf(join(dir, f.key));
    if (!size) continue;
    if (f.busy) busy.add(f.key);
    items.push({
      id: f.key,
      rig: null,
      run: f.run,
      at: new Date(size.at).toISOString(),
      bytes: size.bytes,
      count: 1,
      open: f.open,
      champion: f.champion,
    });
  }
  return { items, busy };
}

/** The rig's runs still open: their builds and logs a policy may keep. */
const openRunsOf = (ledger: Ledger) =>
  ledger.runs
    .list()
    .filter((r) => r.status !== "closed")
    .map((r) => r.id);

/** A kind's items packed for control, or its read's failure in words and no items. */
function packed(what: string, items: () => RetentionItem[]): SpaceInventory {
  try {
    return packItems(items());
  } catch (err) {
    const error = errorText(err).slice(0, 500);
    log("harness", `the ${what} could not be read for control's Space table`, { error }, "warn");
    return { bytes: 0, runs: [], items: [], error };
  }
}

/**
 * What the rig keeps of the judge's builds and of the trials' session logs, packed for control
 * (GET /v1/space), and its open runs.
 */
export function spaceOf(
  ledger: Ledger,
  stateDir: string,
): { builds: SpaceInventory; trial_logs: SpaceInventory; open_runs: string[] } {
  const open_runs = openRunsOf(ledger);
  const open = new Set(open_runs);
  return {
    builds: packed("builds", () => buildItems(ledger, stateDir).items),
    trial_logs: packed("trials' session logs", () => sessionItems(stateDir, open)),
    open_runs,
  };
}

type RetentionRun = z.output<(typeof CommandPayloads)["retention_run"]>;

/** What went, as the event's body says it. */
function removal(p: RetentionRun, gone: RetentionItem[], error: string | undefined) {
  const ats = gone.map((x) => x.at).sort();
  return removedBody(
    { policy: p.policy, name: p.name, kind: p.rule.kind, by: p.by },
    {
      count: gone.length,
      bytes: gone.reduce((n, x) => n + x.bytes, 0),
      rigs: 0,
      oldest: ats[0] ?? null,
      newest: ats.at(-1) ?? null,
    },
    error,
  );
}

/**
 * A policy run on the rig, on control's signed command, recorded as one `retention_removed`
 * event: the judge's builds it covers are removed now, but a build a judge's job needs now; or the
 * trials' session logs it covers. The advisors' records are left to the supervisor, which acts
 * once this command is taken. A kind kept on control is refused: control removes it.
 */
export function runRetention(
  o: { ledger: Ledger; stateDir: string; clock: () => Date },
  p: RetentionRun,
  by: string,
): unknown {
  const kind = p.rule.kind;
  if (kind === "advisor_records") return { kind, left_to: "the supervisor" };
  if (kind === "trial_logs") {
    const r = wouldRemove(
      p.rule,
      sessionItems(o.stateDir, new Set(openRunsOf(o.ledger))),
      o.clock(),
    );
    let error: string | undefined;
    let gone: RetentionItem[] = [];
    try {
      removeSessions(
        o.stateDir,
        r.items.map((x) => x.id),
      );
      gone = r.items;
    } catch (err) {
      error = `a session log could not be removed: ${errorText(err)}`;
    }
    const removed = removal(p, gone, error);
    o.ledger.appendEvent(by, "retention_removed", null, removed);
    log("harness", "a retention policy removed trials' session logs", {
      policy: p.policy,
      removed: removed.count,
      bytes: removed.bytes,
      ...(error ? { error } : {}),
    });
    return removed;
  }
  if (kind !== "builds")
    throw new Refusal(`${kindOf(kind).label} is kept on control, which removes it: not on a rig`);
  const { items, busy } = buildItems(o.ledger, o.stateDir);
  const r = wouldRemove(p.rule, items, o.clock());
  const dir = buildsDir(o.stateDir);
  const gone: RetentionItem[] = [];
  let error: string | undefined;
  for (const x of r.items) {
    if (busy.has(x.id)) continue;
    try {
      if (removeBuild(dir, x.id)) gone.push(x);
      SIZES.delete(join(dir, x.id));
    } catch (err) {
      error ??= `a build could not be removed: ${errorText(err)}`;
    }
  }
  const removed = removal(p, gone, error);
  o.ledger.appendEvent(by, "retention_removed", null, removed);
  const kept = r.items.length - gone.length;
  log("harness", "a retention policy removed builds", {
    policy: p.policy,
    removed: gone.length,
    bytes: removed.bytes,
    ...(kept ? { kept_busy: kept } : {}),
    ...(error ? { error } : {}),
  });
  return removed;
}

/**
 * What the supervisor removed for a policy (the advisors' records), recorded as the rig's
 * `retention_removed` event, so it reaches control as the harness's own removals do.
 */
export function recordRemoved(ledger: Ledger, body: RetentionRemoved): void {
  ledger.appendEvent("supervisor", "retention_removed", null, body);
}

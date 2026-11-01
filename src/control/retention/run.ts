import { rmSync } from "node:fs";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  dueNow,
  kindOf,
  onRigs,
  type RetentionPolicy,
  type RetentionRemoved,
  RetentionRemoved as RetentionRemovedSchema,
  removedBody,
  removeWords,
  ruleOf,
  wouldRemove,
} from "../../core/retention/index.ts";
import { listText } from "../../core/words.ts";
import { issueCommand } from "../issue/index.ts";
import { type ControlStore, RETENTION_REMOVED_ACTION } from "../store/index.ts";
import { itemsOf, rigsOf } from "./items.ts";
import { policyOf } from "./policies.ts";

/**
 * A policy's run: at its time, as control's schedule finds it due (retentionTick), or when the
 * owner presses Run now. Control removes its own kinds at once (the older versions of the
 * knowledge base's items, the copies of its store, its audit log) and records what went; for a
 * rig's kind it sends each rig the policy covers a signed `retention_run`, and each rig says what
 * it removed as a `retention_removed` event (takeRigRemoval). Each removal is in the history and
 * the audit log; the audit log's entry of a removal is never removed by a policy.
 */

/** What runPolicy needs: control's store, and its key to sign the rigs' commands. */
interface RetentionDeps {
  store: ControlStore;
  privateKeyPem: string;
}

/** How long a policy's command waits for its rig: a day, then it expires, as the next run comes. */
const RETENTION_COMMAND_TTL_MINUTES = 24 * 60;

/** What a run did: removed on control, or sent to rigs, in words and figures. */
interface PolicyRun {
  said: string;
  removed?: RetentionRemoved;
  sent?: { rig: string; command: string }[];
  failed?: { rig: string; error: string }[];
}

/** Who started a removal, as the history shows it. */
const startedBy = (how: "schedule" | "hand") => (how === "schedule" ? "schedule" : "Run now");

/** Removes what a policy of a kind kept on control covers now, and records it. */
function removeOnControl(
  store: ControlStore,
  p: RetentionPolicy,
  how: "schedule" | "hand",
  by: string,
  now: Date,
): PolicyRun {
  const r = wouldRemove(p, itemsOf(store, p).items, now);
  let error: string | undefined;
  let gone = r.items;
  try {
    if (p.kind === "kb_versions") {
      const versions = r.items.map((x) => {
        const [item, version] = x.id.split(":").map(Number) as [number, number];
        return { item, version };
      });
      store.kb().removeOlderVersions(versions);
    } else if (p.kind === "audit") {
      store.auditLog.removeEntries(r.items.map((x) => Number(x.id)));
    } else if (p.kind === "store_copies") {
      gone = [];
      for (const x of r.items) {
        try {
          rmSync(x.id, { force: true });
          gone.push(x);
        } catch (err) {
          error ??= `a copy could not be removed: ${errorText(err)}`;
        }
      }
    }
  } catch (err) {
    gone = [];
    error = errorText(err);
  }
  const ats = gone.map((x) => x.at).sort();
  const removed = removedBody(
    { policy: p.id, name: p.name, kind: p.kind, by: how },
    {
      count: gone.reduce((n, x) => n + x.count, 0),
      bytes: gone.reduce((n, x) => n + x.bytes, 0),
      rigs: 0,
      oldest: ats[0] ?? null,
      newest: ats.at(-1) ?? null,
    },
    error,
  );
  store.tx(() => {
    store.retention.addRemoval({
      at: now.toISOString(),
      policy: p.id,
      name: p.name,
      kind: p.kind,
      rig: null,
      by: startedBy(how),
      count: removed.count,
      bytes: removed.bytes,
      oldest: removed.oldest,
      newest: removed.newest,
      error: removed.error ?? null,
    });
    store.auditLog.add(by, RETENTION_REMOVED_ACTION, { ...removed, on: "control" });
  });
  const said = removed.count
    ? `“${p.name}” removed ${removeWords(p.kind, removed)} from control.`
    : `“${p.name}” removed nothing: everything it covers is inside the rule.`;
  log("control", "a retention policy ran on control", {
    policy: p.id,
    kind: p.kind,
    how,
    removed: removed.count,
    bytes: removed.bytes,
    ...(error ? { error } : {}),
  });
  return { said: error ? `${said} ${error}` : said, removed };
}

/** Sends each rig a policy covers its signed command, and says which got it. */
function sendToRigs(
  d: RetentionDeps,
  p: RetentionPolicy,
  how: "schedule" | "hand",
  by: string,
): PolicyRun {
  const rigs = rigsOf(d.store, p);
  const sent: { rig: string; command: string }[] = [];
  const failed: { rig: string; error: string }[] = [];
  const issuedBy = how === "schedule" ? "owner:retention" : by;
  for (const rig of rigs) {
    try {
      const { id } = issueCommand(d.store, d.privateKeyPem, {
        rig,
        kind: "retention_run",
        payload: { policy: p.id, name: p.name, rule: ruleOf(p), by: how },
        ttlMinutes: RETENTION_COMMAND_TTL_MINUTES,
        issuedBy,
      });
      sent.push({ rig, command: id });
    } catch (err) {
      failed.push({ rig, error: errorText(err) });
    }
  }
  d.store.auditLog.add(by, "retention_run_sent", {
    policy: p.id,
    name: p.name,
    kind: p.kind,
    how,
    sent,
    failed,
  });
  log("control", "a retention policy sent to its rigs", {
    policy: p.id,
    how,
    sent: sent.length,
    failed: failed.length,
  });
  const where = kindOf(p.kind).on === "supervisors" ? "its supervisor removes" : "it removes";
  const said = !rigs.length
    ? `“${p.name}” covers no rig now: nothing was sent.`
    : `${sent.length ? `Sent “${p.name}” to ${listText(sent.map((s) => s.rig))}: on each, ${where} what the policy covers there, and says what went under What policies removed.` : ""}${failed.length ? ` Not sent to ${failed.map((f) => `${f.rig} (${f.error})`).join("; ")}.` : ""}`.trim();
  return { said, sent, failed };
}

/**
 * Runs a policy now, whether on or off: by hand (Run now), or for the schedule. Control's kinds
 * are removed at once; a rig's kind is sent to each rig it covers.
 */
export function runPolicy(
  d: RetentionDeps,
  id: number,
  how: "schedule" | "hand",
  by: string,
  now = new Date(),
): PolicyRun {
  const p = policyOf(d.store, id);
  return onRigs(p.kind) ? sendToRigs(d, p, how, by) : removeOnControl(d.store, p, how, by, now);
}

/** Policies running now on control, so one never runs twice at once. */
const RUNNING = new Set<number>();

/**
 * Control's schedule (main.ts runs it every RETENTION_LOOK_MS): each policy that is on and due
 * runs once for its due time. The due time is kept before it runs, so a restart while it runs
 * never runs it again for that time; after control was away, a policy runs once for the latest
 * time it missed. Never throws: a run that fails is logged.
 */
export function retentionTick(d: RetentionDeps, now = new Date()): number {
  let ran = 0;
  for (const p of d.store.retention.list()) {
    const due = dueNow(p, now);
    if (!due || RUNNING.has(p.id)) continue;
    RUNNING.add(p.id);
    try {
      d.store.retention.setLastDue(p.id, due.toISOString());
      runPolicy(d, p.id, "schedule", "control:retention", now);
      ran++;
    } catch (err) {
      const what = { policy: p.id, due: due.toISOString(), error: errorText(err) };
      log("control", "a retention policy's run failed", what, "error");
    } finally {
      RUNNING.delete(p.id);
    }
  }
  return ran;
}

/** How often control looks for policies that are due, in milliseconds. */
export const RETENTION_LOOK_MS = 60_000;

/**
 * A rig's `retention_removed` event, as the apply of the events stream takes it (control/events):
 * what a policy removed there, in the history and the audit log. A body this build does not read
 * is left out, in control's log.
 */
export function takeRigRemoval(
  store: ControlStore,
  rig: string,
  e: { id: number; at: string; actor: string; body: unknown },
): void {
  const read = RetentionRemovedSchema.safeParse(e.body);
  if (!read.success) {
    const what = { rig, event: e.id, error: read.error.message.slice(0, 300) };
    log("control", "a rig's retention removal not read", what, "warn");
    return;
  }
  const b = read.data;
  store.retention.addRemoval({
    at: e.at,
    policy: b.policy,
    name: b.name,
    kind: b.kind,
    rig,
    by: startedBy(b.by),
    count: b.count,
    bytes: b.bytes,
    oldest: b.oldest,
    newest: b.newest,
    error: b.error ?? null,
  });
  store.auditLog.add(`rig:${rig}`, RETENTION_REMOVED_ACTION, { ...b, on: rig, actor: e.actor });
}

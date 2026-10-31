import { BUS_RETRY_MS, type Bus, type BusMessage } from "../common/bus/index.ts";
import { log } from "../common/env.ts";
import {
  REPORT_CONSUMER_CONFIG,
  REPORT_STREAM_CONFIG,
  type ReportPlace,
  readReport,
  reportSignedBy,
  rigOfSubject,
  type SignedReport,
} from "../core/link/report.ts";
import { currentEvent } from "../core/names.ts";
import { type BuildInfo, buildFromHeaders, readBuild } from "../core/version.ts";
import { notForBus, writerOf } from "./events/index.ts";
import type { ControlStore, IngestReport } from "./store/index.ts";
import { checkRig } from "./versions.ts";

/**
 * How control takes a rig's signed report: read from the reports stream on the message bus (goal
 * 168), the only way a rig reports. Each goes through takeReport, with its checks, refusals and
 * records, in the turn of the writer of the events stream (events/writer.ts), one report at a
 * time: its events go on the stream first, and control acks it once it has applied them.
 */

/** What taking a report needs: the store, control's build, and whether keys wait for the owner. */
export interface Intake {
  store: ControlStore;
  control: BuildInfo;
  /** Hold every rig's first report key for the owner's acceptance (no trust on first use). */
  requireKeyAcceptance: boolean;
}

/** A refusal: its words, and control's cursor after a gap. */
type Refused = { error: string; expected_cursor?: number | undefined };

/** What taking a report came to: the status and the answer; 503 refuses it for now. */
export type TakeAnswer = [200, { added: number }] | [400 | 403 | 409 | 503, Refused];

/** The words for a store control made without its bus, as a test's may be. */
const NO_BUS = "control keeps its rigs' events on its message bus, and has none";

/**
 * Takes a report for `rig`, read by readReport, in the turn of the writer of the events stream:
 * its signature against the rig's pinned key (pinned or held here at first contact), its events'
 * sizes and names for the bus, its place in the rig's events (the held cursor of its ledger), its
 * time, and the harness's build. Then the events after the held cursor go on the events stream,
 * and control answers once it has applied them. The bus away, its store full, or too many reports
 * waiting: 503, refused for now, and the rig sends it again.
 */
export async function takeReport(
  t: Intake,
  rig: string,
  read: { report: SignedReport; unknown: number },
): Promise<TakeAnswer> {
  const writer = writerOf(t.store);
  if (!writer) return [503, { error: NO_BUS }];
  const busy = writer.tooMany();
  if (busy) return [503, { error: busy }];
  return await writer.turn(() => takeNow(t, rig, read));
}

/** takeReport in the writer's turn. */
async function takeNow(
  t: Intake,
  rig: string,
  read: { report: SignedReport; unknown: number },
): Promise<TakeAnswer> {
  const { store, control } = t;
  const body = read.report;
  if (body.rig !== rig) return [403, { error: "rig mismatch" }];
  // Reports are signed by the harness: the supervisor relays them but cannot forge them.
  if (!body.signature || !body.rig_pubkey) return [400, { error: "unsigned report" }];
  const key = store.reportedRigs.key(rig);
  const offered = body.rig_pubkey.trim();
  // A key is pinned or held only if the report it came with verifies under it.
  if (!reportSignedBy(body, offered)) {
    store.auditLog.add(`rig:${rig}`, "report_rejected", { reason: "bad signature" });
    return [403, { error: "bad report signature" }];
  }
  // Every event control keeps goes on the message bus (control/events): a page with one the bus
  // can't carry is refused before anything of it is kept, the rig's key too.
  const refusedByBus = notForBus(body);
  if (refusedByBus) {
    store.auditLog.refusal(`rig:${rig}`, "report_refused", { reason: refusedByBus });
    return [409, { error: refusedByBus }];
  }
  if (!key.pubkey) {
    // First contact: pinned, unless the owner must accept every rig's first key.
    if (t.requireKeyAcceptance) {
      if (key.pending?.trim() !== offered) store.reportedRigs.holdKey(rig, offered);
      return [409, { error: "the rig's key waits for the owner's acceptance" }];
    }
    store.reportedRigs.pinKey(rig, offered);
  } else if (key.pubkey.trim() !== offered) {
    if (key.pending?.trim() !== offered) store.reportedRigs.holdKey(rig, offered);
    return [409, { error: "rig key changed: the owner must accept the new key" }];
  }
  // Freshness and completeness: no report from a ledger this rig has left, no gap after the events
  // control holds of its ledger, and nothing older than the newest report already taken.
  const fresh = store.reportedRigs.reportCheck(rig, {
    ledgerId: body.ledger_id,
    cursor: body.cursor,
    generatedAt: body.generated_at,
  });
  if (!fresh.ok) {
    store.auditLog.refusal(`rig:${rig}`, "report_refused", { reason: fresh.reason });
    return [409, { error: fresh.reason, expected_cursor: fresh.expectedCursor }];
  }
  if (Date.parse(body.generated_at) > Date.now() + 5 * 60_000)
    return [409, { error: "report from the future" }];
  // The harness's build, from the signed summary of a fresh report (none from a harness before
  // version checks): recorded, and the report refused while its protocol and control's do not
  // meet. A replayed old report never gets this far, so it cannot change the recorded build.
  store.builds.setRig(rig, "harness", readBuild((body.summary as { build?: unknown })?.build));
  const refused = checkRig(store, rig, control);
  if (refused) {
    store.refusals.countCall(rig);
    return [409, { error: refused }];
  }
  if (read.unknown) {
    const leftOut = { rig, left_out: read.unknown };
    log("control", "a report with fields control does not know", leftOut, "debug");
  }
  const kept = await keepReport(store, body);
  if ("later" in kept) return [503, { error: kept.later }];
  return [200, kept];
}

/**
 * A report that passed control's checks, in the writer's turn: its ledger becomes the rig's
 * current one and the runs its events create join the run registry, in one transaction, before
 * the events go on the stream (the registry chooses their subjects); a run whose name control
 * assigned another rig is not registered, and the audit log says so (`run_refused`). Then the
 * events after the held cursor are published and applied; then the rig's row notes the report,
 * its summary and its time. A report refused for now keeps none of the row's note: the rig sends
 * it again.
 */
export async function keepReport(
  store: ControlStore,
  report: IngestReport,
): Promise<{ added: number } | { later: string }> {
  const writer = writerOf(store);
  if (!writer) return { later: NO_BUS };
  const now = new Date().toISOString();
  const refused: string[] = [];
  store.tx(() => {
    store.reportedRigs.enterLedger(report.rig, report.ledger_id, now);
    for (const e of report.events) {
      const event = currentEvent(e);
      const taken = store.runRegistry.registerRunCreated(report.rig, report.ledger_id, event);
      if (taken === "refused" && event.subject) refused.push(event.subject);
    }
  });
  for (const run of refused) {
    const what = { rig: report.rig, run, why: "control assigned this run's name to another rig" };
    log("control", "a run control did not assign this rig is not registered", what, "warn");
    store.auditLog.add("control", "run_refused", what);
  }
  const written = await writer.publish(report);
  if ("later" in written) return written;
  store.reportedRigs.noteReport(report, new Date().toISOString());
  noteReportAfterWait(store, report.rig);
  return written;
}

/**
 * A rig control marked failed (its update or start waited too long) that reports again works: say
 * so, and show it as running.
 */
function noteReportAfterWait(store: ControlStore, rig: string): void {
  if (store.clusters.rig(rig)?.status !== "failed") return;
  store.clusters.setRigStatus(rig, "running");
  // Named for the wait that ended: its first report, one after new images, or after a start.
  const failed = store.rigHistory
    .list(rig)
    .filter((x) => !x.ok)
    .at(-1)?.step;
  const step =
    failed === "first_report"
      ? "first_report"
      : failed === "pods_running" || failed === "report_after_start"
        ? "report_after_start"
        : failed === "resources" ||
            failed === "resources_running" ||
            failed === "report_after_resources"
          ? "report_after_resources"
          : "report_after_images";
  store.rigHistory.add(rig, step, true, "it reported after the wait ended");
}

/** What one message from the reports stream came to; `later`: handed again after a while. */
export type Folded =
  | { folded: number }
  | { skipped: string }
  | { refused: string }
  | { later: string };

/**
 * Control's place in a rig's events (ReportPlace), for its answer to the supervisor's figures: a
 * supervisor on the message bus goes back there after a page control refused. The cursor is the
 * held cursor of the rig's current ledger: the events control holds of it.
 */
export function reportPlace(store: ControlStore, rig: string): ReportPlace {
  const u = store.reportedRigs.reportRow(rig);
  return u?.ledger_id
    ? { ledger_id: u.ledger_id, cursor: u.cursor }
    : { ledger_id: null, cursor: 0 };
}

/**
 * Whether control holds this report already: from the rig's current ledger, every event in it
 * held, and a report at least as new taken too. It brings nothing new, such as a page the bus
 * hands again after control folded it but before its ack arrived.
 */
function alreadyTaken(store: ControlStore, rig: string, r: SignedReport): boolean {
  const u = store.reportedRigs.reportRow(rig);
  return (
    u !== undefined &&
    u.ledger_id === r.ledger_id &&
    r.next <= u.cursor &&
    u.report_at !== null &&
    r.generated_at <= u.report_at
  );
}

/**
 * One message from the reports stream, through the checks of a rig's call to control (its rig
 * known, not retired, its builds met) and then takeReport. The subject's rig must be the report's
 * signed rig. A page control has already is skipped; a refusal, a gap among them, is recorded and
 * logged, since no answer goes back to the supervisor (its regular call learns control's place,
 * core/link/asks.ts); a page refused for now is handed again.
 */
export async function foldReport(t: Intake, m: BusMessage): Promise<Folded> {
  const { store, control } = t;
  const rig = rigOfSubject(m.subject);
  const refuse = (error: string, fields: Record<string, unknown> = {}): Folded => {
    log("control", "report from the bus refused", { rig, seq: m.seq, error, ...fields }, "warn");
    return { refused: error };
  };
  if (!rig) return refuse("not a rig's report subject", { subject: m.subject.slice(0, 200) });
  // A retired rig's token has ended too: it is told it is retired, before control knows it not.
  if (store.retired.get(rig)) return refuse("this rig is retired in control");
  if (!store.enrollments.knownRig(rig)) return refuse("no such rig: control has no token for it");
  let read: { report: SignedReport; unknown: number };
  try {
    read = readReport(JSON.parse(new TextDecoder().decode(m.data)));
  } catch {
    return refuse("not a report");
  }
  const r = read.report;
  const at = { ledger: r.ledger_id, cursor: r.cursor, next: r.next };
  if (alreadyTaken(store, rig, r)) {
    log("control", "report from the bus taken already", { rig, seq: m.seq, ...at }, "debug");
    return { skipped: "taken already" };
  }
  // The supervisor's build from the message's headers: only the rig's own user may publish on its
  // report subject (core/link/users.ts), so they are its own, as a call with its token was.
  store.builds.setRig(rig, "supervisor", buildFromHeaders(m.header));
  // Refused while the rig's recorded builds and control's do not meet.
  const early = checkRig(store, rig, control, { harness: null, endRefusal: false });
  if (early) {
    store.refusals.countCall(rig);
    return refuse(early, at);
  }
  const [status, answer] = await takeReport(t, rig, read);
  if (status === 503) {
    const later = (answer as Refused).error;
    log("control", "report from the bus taken later", { rig, seq: m.seq, ...at, later }, "debug");
    return { later };
  }
  if (status !== 200) {
    const why = answer as Refused;
    return refuse(why.error, { ...at, expected_cursor: why.expected_cursor });
  }
  return { folded: (answer as { added: number }).added };
}

/**
 * Folds the reports stream as it grows (goal 168): makes sure the stream and control's consumer
 * exist, then takes each message in order and acks it once folded, skipped or refused, and the
 * stream, an inbox, keeps it no more; a page refused for now is handed again after BUS_RETRY_MS,
 * before any later one. A stream made before as one kept for good is made again as an inbox once
 * this consumer has taken every page it held (Bus.follow). Runs until the bus is closed.
 */
export async function followReports(bus: Pick<Bus, "follow">, t: Intake): Promise<void> {
  await bus.follow(REPORT_STREAM_CONFIG, REPORT_CONSUMER_CONFIG, async (m) => {
    const folded = await foldReport(t, m);
    return "later" in folded ? { againInMs: BUS_RETRY_MS } : undefined;
  });
}

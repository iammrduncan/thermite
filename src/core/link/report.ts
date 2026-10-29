import type { ConsumerConfig, StreamConfig } from "@nats-io/jetstream";
import { z } from "zod";
import { reportBody, verifyJson } from "../commands.ts";
import { RIG_ID } from "../ids.ts";

/**
 * The link's first contract (goal 168, step 0): a rig's reports on the message bus. A message is
 * one report exactly as the rig's harness made and signed it, a page of its ledger's events with
 * the rig's summary. The supervisor publishes it and cannot change it; control reads it with the
 * same checks as a report posted to `POST /v1/rigs/<rig>/ingest`.
 */

/** The stream that holds each rig's reports until control has taken or refused them. */
export const REPORT_STREAM = "REPORTS";
/** Every rig's report subject: the stream takes these. */
export const REPORT_SUBJECTS = "thermite.rig.*.report";
/** The durable consumer control folds the stream with. */
export const REPORT_CONSUMER = "control-reports";

const SUBJECT = /^thermite\.rig\.([^.*>\s]+)\.report$/;

/** The subject a rig's reports go on. A rig whose name is not a rig's name has none. */
export function reportSubject(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a report subject: ${rig}`);
  return `thermite.rig.${rig}.report`;
}

/** The rig a report subject names, or null for a subject that is not a report subject. */
export function rigOfSubject(subject: string): string | null {
  const rig = SUBJECT.exec(subject)?.[1];
  return rig !== undefined && RIG_ID.test(rig) ? rig : null;
}

/**
 * The largest report message, its headers included: the NATS server's largest payload
 * (`max_payload` in compose.yaml's `nats` service) is this number.
 */
export const REPORT_MAX_BYTES = 8 * 1024 * 1024;
/** Room kept under the limit for a message's headers: its id and the supervisor's build. */
const HEADER_ROOM = 4096;

/** Whether a report of this many bytes fits in one message. If not, the supervisor halves it. */
export function reportFits(bytes: number): boolean {
  return bytes + HEADER_ROOM <= REPORT_MAX_BYTES;
}

/**
 * A report's message id: its ledger and the events it carries, so that a page published twice is
 * kept once. A report with no events adds its time: each one still reaches control, to say that
 * the rig is alive and what its summary is now.
 */
export function reportMessageId(r: {
  ledger_id: string;
  cursor: number;
  next: number;
  events: readonly unknown[];
  generated_at: string;
}): string {
  const page = `${r.ledger_id}:${r.cursor}-${r.next}`;
  return r.events.length ? page : `${page}@${r.generated_at}`;
}

/** How long the bus remembers a message id, in nanoseconds: two minutes. */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1e9;

/**
 * How many of one rig's reports the stream holds waiting for control, at most: 32, so at most
 * 32 × REPORT_MAX_BYTES (256 MiB) of one rig's. While a rig has as many waiting, its next report
 * is refused, and its supervisor sends it again at its next round; other rigs' reports go on.
 */
export const REPORTS_WAITING_PER_RIG = 32;

/**
 * The stream's settings: an inbox, a work queue, so a report is gone once control acks it, taken
 * or refused for good. Control keeps the events in the `EVENTS` stream (events.ts), and the rig's
 * summary in its store; a supervisor reports every round, events or not, and those pages kept for
 * good would outgrow the events. Each rig's subject holds at most REPORTS_WAITING_PER_RIG reports,
 * each at most REPORT_MAX_BYTES: a full one refuses that rig's next report, and never drops one
 * control has yet to take. No limit on their age. A stream made before as one kept for good
 * (`limits`) can't become a work queue in place: control's follow empties it first, through its
 * consumer, then makes it again (common/work-queue.ts).
 */
export const REPORT_STREAM_CONFIG = {
  name: REPORT_STREAM,
  subjects: [REPORT_SUBJECTS],
  description: "Each rig's signed reports, until control has taken or refused them",
  retention: "workqueue",
  storage: "file",
  max_msgs: -1,
  max_bytes: -1,
  max_age: 0,
  max_msgs_per_subject: REPORTS_WAITING_PER_RIG,
  max_msg_size: REPORT_MAX_BYTES,
  discard: "new",
  discard_new_per_subject: true,
  duplicate_window: DUPLICATE_WINDOW_NS,
  num_replicas: 1,
} satisfies Partial<StreamConfig> & { name: string };

/** How long control may take over one message before the stream hands it again, in nanoseconds. */
const ACK_WAIT_NS = 30 * 1e9;

/**
 * Control's consumer: every message from the stream's start, each acked once taken or refused for
 * good, one at a time, so that each rig's pages fold in the order they were published. A page
 * refused for now is not acked, and is handed again before any later one.
 */
export const REPORT_CONSUMER_CONFIG = {
  durable_name: REPORT_CONSUMER,
  ack_policy: "explicit",
  deliver_policy: "all",
  max_ack_pending: 1,
  ack_wait: ACK_WAIT_NS,
  max_deliver: -1,
} satisfies Partial<ConsumerConfig> & { durable_name: string };

/**
 * Control's place in a rig's events, in its answer to the supervisor's figures
 * (`POST /v1/rigs/<rig>/supervisor`): the ledger it holds the rig's events of, null before the
 * first report it took, and the cursor after the last event it holds. No answer to a report on the
 * bus comes back, so a supervisor ahead of this in the same ledger goes back to it.
 */
export const ReportPlace = z.object({
  ledger_id: z.string().nullable(),
  cursor: z.number().int().min(0),
});
export type ReportPlace = z.infer<typeof ReportPlace>;

/** One event of a rig's ledger, as a report carries it and control reads it. */
export const ReportEvent = z.object({
  id: z.number().int().positive(),
  at: z.iso.datetime(),
  actor: z.string(),
  kind: z.string(),
  subject: z.string().nullable(),
  body: z.unknown(),
  run: z.string().nullable().optional(),
});
export type ReportEvent = z.infer<typeof ReportEvent>;

/**
 * The harness's signed report, as control reads it. A field this control does not know is
 * dropped, in the report or in an event, and the signature (over reportBody) is checked on what is
 * left. So the signed part stays exact: a field a newer harness signs there fails the check. New
 * data goes in an event's `body` or the `summary`, which are kept as they came (goal 012).
 */
export const SignedReport = z.object({
  rig: z.string().min(1),
  ledger_id: z.string().min(1),
  cursor: z.number().int().min(0),
  next: z.number().int().min(0),
  events: z.array(ReportEvent),
  summary: z.unknown(),
  generated_at: z.iso.datetime(),
  latest_event: z.number().int().min(0),
  rig_pubkey: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});
export type SignedReport = z.infer<typeof SignedReport>;

const REPORT_FIELDS = new Set(Object.keys(SignedReport.shape));
const EVENT_FIELDS = new Set(Object.keys(ReportEvent.shape));

/** How many fields of an object a reader does not know. */
function unknownIn(x: unknown, known: Set<string>): number {
  return x && typeof x === "object" ? Object.keys(x).filter((k) => !known.has(k)).length : 0;
}

/**
 * A report as every reader of a signed batch reads it (owner's decision 6): it keeps the fields it
 * knows and counts the rest, in the report and in its events. Throws a ZodError when it is not a
 * report at all.
 */
export function readReport(raw: unknown): { report: SignedReport; unknown: number } {
  const report = SignedReport.parse(raw);
  let unknown = unknownIn(raw, REPORT_FIELDS);
  for (const e of (raw as { events: unknown[] }).events) unknown += unknownIn(e, EVENT_FIELDS);
  return { report, unknown };
}

/**
 * One event as every reader reads it (owner's decision 6), as readReport reads a report's: it
 * keeps the fields it knows and counts the rest. Throws a ZodError when it is not an event at all.
 */
export function readReportEvent(raw: unknown): { event: ReportEvent; unknown: number } {
  return { event: ReportEvent.parse(raw), unknown: unknownIn(raw, EVENT_FIELDS) };
}

/**
 * Whether the key a report carries signed it. The signer is the rig's report key, which only its
 * harness holds; control also checks that the key is the one it pinned for the rig.
 */
export function reportSignedBy(r: SignedReport, publicKeyPem: string): boolean {
  return Boolean(r.signature) && verifyJson(reportBody(r), r.signature ?? "", publicKeyPem);
}

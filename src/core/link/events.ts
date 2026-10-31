import type { StreamConfig } from "@nats-io/jetstream";
import { canonicalJson } from "../canonical.ts";
import { NAME_PATTERN, RIG_ID } from "../ids.ts";
import { LIVE_RIG_HEADER } from "./live.ts";
import { REPORT_MAX_BYTES, type ReportEvent, readReportEvent } from "./report.ts";

/**
 * The link's fifth contract (goal 168, step 4): every rig's events on the message bus, the
 * `EVENTS` stream, kept for good. A message is one event of a rig's ledger, as the rig recorded
 * it, in canonical JSON. A run's event goes on the run's subject by its kind, with the attempt's
 * and the trial's ids in the event, not in the subject (the owner's decision of 2026-10-29: a
 * subject costs the server memory for as long as the stream lives); a change to a run's queue of
 * experiments goes on the run's queue subject, by what it did; a rig's own event, on the rig's
 * subject by its kind. The rig and its ledger travel in headers, never in a run's subject.
 * Control alone publishes here, after its checks of the report the events came in; a rig's user
 * has nothing on this stream.
 */

/** The stream that keeps every rig's events. */
export const EVENT_STREAM = "EVENTS";
/** The subjects the stream takes: each run's events and queue changes, and each rig's own. */
export const EVENT_SUBJECTS = [
  "thermite.run.*.ev.*",
  "thermite.run.*.queue.*",
  "thermite.rig.*.ev.*",
];

/**
 * What a change to a run's queue of experiments did: the last token of its subject. Its event's
 * kind is `experiment_<op>`.
 */
export const QUEUE_OPS = [
  "added",
  "accepted",
  "moved",
  "edited",
  "dropped",
  "assigned",
  "finished",
  "returned",
] as const;
type QueueOp = (typeof QUEUE_OPS)[number];
const QUEUE_KIND_PREFIX = "experiment_";

/** The queue's op an event's kind names, or undefined for a kind that is not a queue change. */
function queueOp(kind: string): QueueOp | undefined {
  if (!kind.startsWith(QUEUE_KIND_PREFIX)) return undefined;
  const op = kind.slice(QUEUE_KIND_PREFIX.length);
  return (QUEUE_OPS as readonly string[]).includes(op) ? (op as QueueOp) : undefined;
}

/** An event's kind as a subject's last token: a word of a-z, 0-9 and _. */
const EVENT_KIND = /^[a-z0-9][a-z0-9_]{0,63}$/;
const EVENT_KIND_WORDS = "a kind is up to 64 of a-z, 0-9 and _, starting with a letter or digit";

/**
 * The subject an event goes on. A run's event goes on its run's subject when control's run
 * registry gives the run to the rig, or to no rig yet (`runIsTheRigs`, which the caller looks up):
 * by its kind, or a queue change by what it did. Every other event goes on the rig's own subject by its kind: one
 * with no run, one of a run the registry gives another rig, and one of a run whose name a subject
 * can't hold (a run named before goal 170), as a live line does. Throws, in words, on a rig's name
 * or a kind a subject can't hold.
 */
export function eventSubject(
  rig: string,
  e: { kind: string; run?: string | null | undefined },
  runIsTheRigs: boolean,
): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for an event subject: ${rig}`);
  if (!EVENT_KIND.test(e.kind))
    throw new Error(
      `not an event kind a subject can hold: ${JSON.stringify(e.kind)} (${EVENT_KIND_WORDS})`,
    );
  const run = e.run ?? undefined;
  if (run === undefined || !runIsTheRigs || !NAME_PATTERN.test(run))
    return `thermite.rig.${rig}.ev.${e.kind}`;
  const op = queueOp(e.kind);
  return op ? `thermite.run.${run}.queue.${op}` : `thermite.run.${run}.ev.${e.kind}`;
}

/**
 * The subjects a rig's events are on: its own, and those of the runs they name (`runs`), each by
 * any kind; a run whose name a subject can't hold has none. A run's subjects hold every rig's
 * events of a run of that name, so a reader keeps those with the rig's header. Exact runs, not
 * every run's (`thermite.run.*.ev.*`): the server reads a few runs' subjects in a fraction of the
 * time it takes to read every run's. Throws, in words, on a rig's name a subject can't hold.
 */
export function rigEventSubjects(rig: string, runs: Iterable<string>): string[] {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for an event subject: ${rig}`);
  const named = [...new Set(runs)].filter((run) => NAME_PATTERN.test(run)).sort();
  return [
    `thermite.rig.${rig}.ev.*`,
    ...named.flatMap((run) => [`thermite.run.${run}.ev.*`, `thermite.run.${run}.queue.*`]),
  ];
}

/**
 * The subjects the events of one kind are on, on every rig and run: a run's, by the kind or, for
 * a queue change, by what it did; and a rig's own. Throws, in words, on a kind a subject can't
 * hold.
 */
export function kindSubjects(kind: string): string[] {
  if (!EVENT_KIND.test(kind))
    throw new Error(
      `not an event kind a subject can hold: ${JSON.stringify(kind)} (${EVENT_KIND_WORDS})`,
    );
  const op = queueOp(kind);
  const run = op ? `thermite.run.*.queue.${op}` : `thermite.run.*.ev.${kind}`;
  return [run, `thermite.rig.*.ev.${kind}`];
}

/**
 * The headers of an event's message. The rig's is the one a live message names its rig in; the
 * report's names the page the event came in (its message id, reportMessageId); the seq's is the
 * event's place in control's own table of events, for a row control copied from it.
 */
export const EVENT_HEADERS = {
  rig: LIVE_RIG_HEADER,
  ledger: "Thermite-Ledger",
  report: "Thermite-Report",
  seq: "Thermite-Seq",
} as const;
/** NATS's own header for a message's id, which the stream keeps one message for. */
const MSG_ID_HEADER = "Nats-Msg-Id";

/** A ledger's id as a header and a message id hold it: no space, no colon, at most 128. */
const LEDGER_ID = /^[\x21-\x39\x3b-\x7e]{1,128}$/;

/**
 * An event's message id: its rig, its ledger and its id there, so that an event published twice
 * is kept once while the stream remembers the id. A row control copies from its own table carries
 * its place there instead, and no id: the copy's one writer goes on after the place of the
 * stream's last message, and each batch it publishes names the stream's last place it expects,
 * so an id would guard nothing more; and the server keeps every id for the duplicate window, in
 * memory, which a copy at full speed fills with every row's (the server, at 256 MiB, was stopped
 * at about 950,000 ids).
 */
export function eventMessageId(rig: string, ledger: string, id: number): string {
  return `${rig}:${ledger}:${id}`;
}

/**
 * The largest event message, its headers included: the largest report's (REPORT_MAX_BYTES), the
 * NATS server's largest payload. An event a report on the bus carried fits, since the report held
 * it and more.
 */
export const EVENT_MAX_BYTES = REPORT_MAX_BYTES;
/** Room kept under the limit for a message's headers: its id, its rig, ledger, page and seq. */
const HEADER_ROOM = 4096;

/** Whether a message whose data is this many bytes fits, its headers with it. */
export function eventFits(bytes: number): boolean {
  return bytes + HEADER_ROOM <= EVENT_MAX_BYTES;
}

/** An event's message, ready for the bus: its subject, its data, its id (or none) and headers. */
export interface EventMessage {
  subject: string;
  data: string;
  id: string | undefined;
  headers: Record<string, string>;
}

/** The event's data: the event as the rig recorded it, in canonical JSON. */
function eventData(e: ReportEvent): string {
  const { id, at, actor, kind, subject, body, run } = e;
  return canonicalJson({ id, at, actor, kind, subject, run: run ?? null, body: body ?? {} });
}

/**
 * An event's message: on its subject (eventSubject, with `runIsTheRigs`), its data the event, its
 * id, and its headers. `report` names the page it came in; `seq` is its place in control's own
 * table, for a row control copies from it, which then has no id (eventMessageId). Throws, in
 * words, on a name a subject or a header can't hold.
 */
export function eventMessage(o: {
  rig: string;
  ledger: string;
  event: ReportEvent;
  runIsTheRigs: boolean;
  report?: string | undefined;
  seq?: number | undefined;
}): EventMessage {
  const subject = eventSubject(o.rig, o.event, o.runIsTheRigs);
  if (!LEDGER_ID.test(o.ledger))
    throw new Error(`not a ledger's id for an event message: ${JSON.stringify(o.ledger)}`);
  const headers: Record<string, string> = {
    [EVENT_HEADERS.rig]: o.rig,
    [EVENT_HEADERS.ledger]: o.ledger,
  };
  if (o.report !== undefined) {
    if (!o.report || /[\r\n]/.test(o.report))
      throw new Error(`not a report's id for an event message: ${JSON.stringify(o.report)}`);
    headers[EVENT_HEADERS.report] = o.report;
  }
  if (o.seq !== undefined) {
    if (!Number.isSafeInteger(o.seq) || o.seq < 1)
      throw new Error(`not a place in control's events for an event message: ${o.seq}`);
    headers[EVENT_HEADERS.seq] = String(o.seq);
  }
  return {
    subject,
    data: eventData(o.event),
    id: o.seq === undefined ? eventMessageId(o.rig, o.ledger, o.event.id) : undefined,
    headers,
  };
}

/** An event read from the bus: its rig and ledger, the page or row it came from, and the event. */
export interface EventRead {
  rig: string;
  ledger: string;
  report: string | undefined;
  seq: number | undefined;
  event: ReportEvent;
  /** Fields of the event this build does not know, dropped and counted (owner's decision 6). */
  unknown: number;
}

/**
 * An event message as a reader reads it: the event from its data, and its rig and ledger from its
 * headers. Refused, in words, when the headers and the data disagree: no rig or ledger, an id that
 * names another event, neither an id nor a seq, a subject that is not the event's, or a seq that
 * is not a place. Throws when the data is not an event at all (a SyntaxError or a ZodError).
 */
export function readEventMessage(m: {
  subject: string;
  data: Uint8Array;
  header(name: string): string | undefined;
}): EventRead {
  const refuse = (why: string) => new Error(`an event message on ${m.subject} refused: ${why}`);
  const rig = m.header(EVENT_HEADERS.rig) ?? "";
  const ledger = m.header(EVENT_HEADERS.ledger) ?? "";
  if (!RIG_ID.test(rig)) throw refuse(`its ${EVENT_HEADERS.rig} names no rig`);
  if (!LEDGER_ID.test(ledger)) throw refuse(`its ${EVENT_HEADERS.ledger} names no ledger`);
  const { event, unknown } = readReportEvent(JSON.parse(new TextDecoder().decode(m.data)));
  const id = m.header(MSG_ID_HEADER);
  const seqHeader = m.header(EVENT_HEADERS.seq);
  if (id === undefined && seqHeader === undefined) throw refuse("it has neither an id nor a seq");
  if (id !== undefined && id !== eventMessageId(rig, ledger, event.id))
    throw refuse(`its id ${JSON.stringify(id)} is not that of event ${event.id}`);
  const subjects = [eventSubject(rig, event, true), eventSubject(rig, event, false)];
  if (!subjects.includes(m.subject))
    throw refuse(`it is not the subject of a ${event.kind} event of rig ${rig}`);
  const seq = seqHeader === undefined ? undefined : Number(seqHeader);
  if (seq !== undefined && !(Number.isSafeInteger(seq) && seq >= 1 && String(seq) === seqHeader))
    throw refuse(`its ${EVENT_HEADERS.seq} is not a place: ${JSON.stringify(seqHeader)}`);
  return { rig, ledger, report: m.header(EVENT_HEADERS.report), seq, event, unknown };
}

/** How long the bus remembers a message id, in nanoseconds: two minutes. */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1e9;

/**
 * The stream's settings. Events are kept for good, as the ledgers they come from are: no limit on
 * their count, bytes or age, and no message may be deleted or purged. A full disk refuses new
 * messages and never drops old ones. A page of a report goes in as one atomic batch, stored whole
 * or not at all; any message may be read by its place directly. Compressed (s2): about six times
 * smaller on disk, for a little more time to read (the owner's decision of 2026-10-29).
 */
export const EVENT_STREAM_CONFIG = {
  name: EVENT_STREAM,
  subjects: EVENT_SUBJECTS,
  description: "Every rig's events, by run and kind, kept for good",
  retention: "limits",
  storage: "file",
  max_msgs: -1,
  max_bytes: -1,
  max_age: 0,
  max_msgs_per_subject: -1,
  max_msg_size: EVENT_MAX_BYTES,
  discard: "new",
  deny_delete: true,
  deny_purge: true,
  duplicate_window: DUPLICATE_WINDOW_NS,
  num_replicas: 1,
  allow_atomic: true,
  allow_direct: true,
  compression: "s2",
} satisfies Partial<StreamConfig> & { name: string };

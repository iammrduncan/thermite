import type { ConsumerConfig, StreamConfig } from "@nats-io/jetstream";
import { NAME_PATTERN, RIG_ID } from "../ids.ts";
import { LiveBatchWire, LiveEntry, readLiveEntries } from "../live.ts";

/**
 * The link's third contract (goal 168, step 2): the live view on the message bus. A message is
 * the lines of one source of one run: the planner's, the judge's, one trial's or the supervisor's.
 * It goes on the run's subject; a line that names no run (the judge's or the advisors' own) goes
 * on the rig's. The harness signs the lines of each message as a batch (core/live.ts), so the
 * supervisor that publishes them can't change them; the supervisor's own lines go
 * unsigned, as they always have. The live view is a view, never a record: the stream keeps the
 * newest messages by count and age, and control keeps what it folds in its own live view.
 */

/** The stream that keeps the newest live lines of every run and rig. */
export const LIVE_STREAM = "LIVE";
/** The subjects the stream takes: each run's live lines, and each rig's own. */
export const LIVE_SUBJECTS = ["thermite.run.*.live.*", "thermite.rig.*.live.*"];
/** The durable consumer control folds the stream into its live view with. */
export const LIVE_CONSUMER = "control-live";
/**
 * The header that names the rig a message comes from. A run's subject names no rig (the rig is a
 * fact about the run, not part of its address), so the rig travels here.
 */
export const LIVE_RIG_HEADER = "Thermite-Rig";

/** A source as a subject's last token: a trial's `trial:<id>` becomes `trial-<id>`. */
function sourceToken(source: string): string {
  if (!LiveEntry.shape.source.safeParse(source).success)
    throw new Error(`not a live source for a subject: ${source}`);
  return source.startsWith("trial:") ? `trial-${source.slice(6)}` : source;
}

/** The source a subject's last token names, or null. */
function tokenSource(token: string): string | null {
  const source = token.startsWith("trial-") ? `trial:${token.slice(6)}` : token;
  return LiveEntry.shape.source.safeParse(source).success ? source : null;
}

/** The rig's own subject for a source's lines: a line that names no run goes here. */
export function rigLiveSubject(rig: string, source: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a live subject: ${rig}`);
  return `thermite.rig.${rig}.live.${sourceToken(source)}`;
}

/**
 * The subject a line goes on: its run's, or the rig's when it names no run, or a run whose name a
 * subject can't hold (a run named before goal 170 may have a dot or capitals).
 */
export function liveSubject(
  rig: string,
  line: { run?: string | undefined; source: string },
): string {
  if (line.run === undefined || !NAME_PATTERN.test(line.run))
    return rigLiveSubject(rig, line.source);
  return `thermite.run.${line.run}.live.${sourceToken(line.source)}`;
}

/** What a live subject names: a run's or a rig's, and the source of its lines. */
export type LiveSubject = { run: string; source: string } | { rig: string; source: string };

const SUBJECT = /^thermite\.(run|rig)\.([^.*>\s]+)\.live\.([^.*>\s]+)$/;

/** What a subject names, or null for a subject that is not a live subject. */
export function readLiveSubject(subject: string): LiveSubject | null {
  const m = SUBJECT.exec(subject);
  const [, of, name = "", token = ""] = m ?? [];
  const source = tokenSource(token);
  if (!m || !source) return null;
  if (of === "run") return NAME_PATTERN.test(name) ? { run: name, source } : null;
  return RIG_ID.test(name) ? { rig: name, source } : null;
}

/**
 * The largest live message, its headers included. A message holds one source's lines of one
 * round of the supervisor's relay, a few seconds' work; a megabyte holds about a hundred of the
 * longest lines (core/live.ts's LIVE_TEXT_MAX) and thousands of the usual ones. Smaller messages
 * keep the stream's count by subject meaningful, and control's work for each one short.
 */
export const LIVE_MAX_BYTES = 1024 * 1024;
/** Room kept under the limit for a message's headers: its id and its rig. */
const HEADER_ROOM = 4096;
/** Room kept for a batch's own fields beside its lines: its rig, log id, key and signature. */
const BATCH_ROOM = 12 * 1024;

/** Whether a message whose data is this many bytes fits, its headers with it. */
export function liveFits(bytes: number): boolean {
  return bytes + HEADER_ROOM <= LIVE_MAX_BYTES;
}

/** How many bytes a line takes in a message's JSON, with the comma after it. */
const lineBytes = (e: unknown) => new TextEncoder().encode(JSON.stringify(e)).length + 1;

/**
 * A page of live lines as the link's messages: the lines of each run's source together, in the
 * order of their first line, each message cut so that it fits. A line is never cut: the longest
 * line fits many times over. The harness signs each message's lines; the supervisor groups its
 * own lines the same way.
 */
export function liveGroups<T extends { run?: string | undefined; source: string }>(
  entries: readonly T[],
): T[][] {
  const room = LIVE_MAX_BYTES - HEADER_ROOM - BATCH_ROOM;
  const open = new Map<string, { lines: T[]; bytes: number }>();
  const out: T[][] = [];
  for (const e of entries) {
    const key = `${e.run ?? ""}\n${e.source}`;
    const bytes = lineBytes(e);
    let group = open.get(key);
    if (!group || group.bytes + bytes > room) {
      group = { lines: [], bytes: 0 };
      open.set(key, group);
      out.push(group.lines);
    }
    group.lines.push(e);
    group.bytes += bytes;
  }
  return out;
}

/**
 * A message's id: its log and the first and last of its lines, so a message published twice is
 * kept once. The log id changes when the harness's controller (or the supervisor) restarts.
 */
export function liveMessageId(b: { log_id: string; entries: readonly { seq: number }[] }): string {
  return `${b.log_id}:${b.entries[0]?.seq ?? 0}-${b.entries.at(-1)?.seq ?? 0}`;
}

/**
 * A live message as control reads it (owner's decision 6): its batch, the lines it knows, and a
 * count of the rest by the kind or source it does not know. Throws
 * a ZodError when it is not a batch of live lines at all.
 */
export function readLiveMessage(raw: unknown): {
  batch: ReturnType<typeof LiveBatchWire.parse>;
  entries: LiveEntry[];
  unknown: Record<string, number>;
} {
  const batch = LiveBatchWire.parse(raw);
  const read = readLiveEntries(batch.entries);
  return { batch, entries: read.entries, unknown: read.unknown };
}

/**
 * How long the stream keeps a message: an hour. Lines older than that are history, not live;
 * control has folded them long before, unless it was away for that long.
 */
export const LIVE_KEPT_SECONDS = 3600;
/**
 * How many messages the stream keeps of each subject: one a relay round (3 seconds by default)
 * for about the hour it keeps them. One busy source can't hold more than that.
 */
export const LIVE_KEPT_PER_SUBJECT = 1000;
/**
 * How many bytes the stream keeps in all: 256 MiB, so that long lines from many rigs can never
 * fill the bus's disk, which the events, kept for good, need. The oldest go first.
 */
export const LIVE_KEPT_BYTES = 256 * 1024 * 1024;
/** How long the bus remembers a message id, in nanoseconds: two minutes. */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1e9;

/**
 * The stream's settings: a view, kept by count and age, and by bytes; the oldest messages go
 * when a limit is reached, so a publish is never refused for room.
 */
export const LIVE_STREAM_CONFIG = {
  name: LIVE_STREAM,
  subjects: LIVE_SUBJECTS,
  description: "Each run's and rig's live lines: a view, the newest kept by count and age",
  retention: "limits",
  storage: "file",
  max_msgs: -1,
  max_bytes: LIVE_KEPT_BYTES,
  max_age: LIVE_KEPT_SECONDS * 1e9,
  max_msgs_per_subject: LIVE_KEPT_PER_SUBJECT,
  max_msg_size: LIVE_MAX_BYTES,
  discard: "old",
  duplicate_window: DUPLICATE_WINDOW_NS,
  num_replicas: 1,
} satisfies Partial<StreamConfig> & { name: string };

/** How long control may take over one message before the stream hands it again, in nanoseconds. */
const ACK_WAIT_NS = 30 * 1e9;

/**
 * Control's consumer: every message the stream still keeps, one at a time, each acked once folded,
 * so that the lines reach control's live view in the order they were published.
 */
export const LIVE_CONSUMER_CONFIG = {
  durable_name: LIVE_CONSUMER,
  ack_policy: "explicit",
  deliver_policy: "all",
  max_ack_pending: 1,
  ack_wait: ACK_WAIT_NS,
  max_deliver: -1,
} satisfies Partial<ConsumerConfig> & { durable_name: string };

/**
 * How many subjects the supervisor's figures count the live lines of, by name: the most recently
 * used. A trial is a source of its own, so a rig's subjects grow without end; the totals count them
 * all.
 */
export const LIVE_FIGURE_SUBJECTS = 100;

/**
 * How many runs of a rig its user on the bus may publish the live lines of: the newest. A run
 * past them, or one control has not seen yet, has its lines go on the rig's own subject.
 */
export const LIVE_RUNS_PER_RIG = 1000;

import { BUS_BATCH_MAX, BUS_RETRY_MS, type Bus, type BusMessage } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { EVENT_HEADERS, EVENT_STREAM, EVENT_STREAM_CONFIG } from "../../core/link/events.ts";
import type { ReportEvent } from "../../core/link/report.ts";
import type { ControlStore, StoredEvent } from "../store/index.ts";
import {
  inBatches,
  isTheRigsRun,
  type OnBus,
  onBus,
  outgoing,
  publishAfter,
  publishFailed,
} from "./batch.ts";

/**
 * The move of a store's events table to the `EVENTS` stream (goal 168, step 4). A store from
 * before control published each report's events first (from v0.1.0, or from before step 4's
 * publish) holds them in its events table, and part of them, or all, in the stream. At control's
 * start, before it takes a report, the move publishes the rows the stream lacks, in the table's
 * order, each on its subject as the rig recorded it, with its place in the table (`Thermite-Seq`)
 * and no message id: it goes on after the last row the stream holds, and each batch names the
 * stream's last place it expects, so a stop part way, a lost ack or a batch stored late never
 * makes a copy twice. It then checks that the stream holds the table whole: as many moved events
 * as rows, the last at the table's last seq, and a sample of them the same as their rows. Then the
 * store migration that drops the table runs (store/schema.ts), with a copy of the store kept
 * outside the copies' rotation. A row whose kind a subject can't hold, or too large for a message,
 * goes on the rig's own subject under the kind `legacy`, its own kind kept in its body, and the
 * move says so in control's log and its audit log (legacyOf). A stream it can't go on in, a row
 * whose rig or ledger the bus can't name, or a stream that lacks rows stops the move, in words,
 * and control does not start: the table stays.
 */

/** How many of the moved events the check compares with their rows, spread over the table. */
export const MOVE_CHECK_SAMPLE = 64;
/** While the move publishes many rows, it logs how far it got every this many. */
const MOVE_LOG_ROWS = 100_000;

/**
 * Why the move stopped: a row whose rig or ledger the bus can't name, or a stream it can't go on
 * in.
 */
export interface MoveStopped {
  /** The row's rig, ledger and place in the table; null for a stream it can't go on in. */
  rig: string | null;
  ledger: string | null;
  seq: number | null;
  /** The row's event as a message's data, in bytes; null when its size is not what stopped it. */
  bytes: number | null;
  error: string;
}

export interface EventsMoveOptions {
  store: ControlStore;
  bus: Pick<Bus, "makeStream" | "publishBatch" | "lastSeq" | "message">;
  /** How long it waits after a failure: BUS_RETRY_MS unless a test gives a shorter one. */
  retryMs?: number | undefined;
  /** Told after each batch the stream stored: the apply of the stream reads it then. */
  published?: (() => void) | undefined;
}

/**
 * A row the move put under the kind `legacy`: its place, rig, ledger and event id, its own kind,
 * why the bus can't carry it as it was, and whether its body went with it.
 */
interface Legacy {
  seq: number;
  rig: string;
  ledger: string;
  event: number;
  kind: string;
  why: string;
  with_body: boolean;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Thermite-Seq of a message, or null for one with none, or no message. */
async function seqAt(bus: Pick<Bus, "message">, place: number): Promise<number | null> {
  const header = (await bus.message(EVENT_STREAM, place))?.header(EVENT_HEADERS.seq);
  const seq = Number(header);
  return header !== undefined && Number.isSafeInteger(seq) && seq >= 1 ? seq : null;
}

/**
 * Where the rows moved to the stream end: the place of the last message with a Thermite-Seq, and
 * that seq; 0 and 0 for a stream with none. The moved rows come first in the stream, from its
 * first place, and the events published first after them: so a stream whose last message has no
 * Thermite-Seq is looked at by halves.
 */
export async function movedEnd(
  bus: Pick<Bus, "lastSeq" | "message">,
): Promise<{ place: number; seq: number }> {
  const last = await bus.lastSeq(EVENT_STREAM);
  if (last === 0) return { place: 0, seq: 0 };
  const top = await seqAt(bus, last);
  if (top !== null) return { place: last, seq: top };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await seqAt(bus, mid)) !== null) lo = mid;
    else hi = mid;
  }
  const seq = lo === 0 ? null : await seqAt(bus, lo);
  return seq === null ? { place: 0, seq: 0 } : { place: lo, seq };
}

/** The places the check looks at: up to MOVE_CHECK_SAMPLE, spread from the first to `rows`. */
function samplePlaces(rows: number): number[] {
  if (rows <= MOVE_CHECK_SAMPLE) return Array.from({ length: rows }, (_, i) => i + 1);
  const step = (rows - 1) / (MOVE_CHECK_SAMPLE - 1);
  return [
    ...new Set(Array.from({ length: MOVE_CHECK_SAMPLE }, (_, i) => 1 + Math.round(i * step))),
  ];
}

/** A row's event as the rig recorded it, its body parsed. */
const rowEvent = (row: StoredEvent) => ({ ...row.event, body: JSON.parse(row.body), run: row.run });

/**
 * The most characters of a row's own kind, actor and subject that its `legacy` event keeps when it
 * is too large for a message even under that kind.
 */
const LEGACY_TEXT_MAX = 1000;

/**
 * A row's event under the kind `legacy`: as the rig recorded it, with its own kind and body in its
 * body. With `bytes` (too large even so), its kind, actor and subject cut to LEGACY_TEXT_MAX and
 * no body, only its size: the copy of the store kept before the table goes holds it whole.
 */
function legacyOf(e: ReportEvent, bytes?: number): ReportEvent {
  if (bytes === undefined) return { ...e, kind: "legacy", body: { kind: e.kind, body: e.body } };
  const cut = (t: string) => t.slice(0, LEGACY_TEXT_MAX);
  return {
    ...e,
    kind: "legacy",
    actor: cut(e.actor),
    subject: e.subject === null ? null : cut(e.subject),
    body: { kind: cut(e.kind), bytes },
  };
}

/**
 * A row's event as the move publishes it, as a message: as the rig recorded it, or else under the
 * kind `legacy` on the rig's own subject (legacyOf), with why the bus can't carry it as it was and
 * whether its body went with it. An error when the bus can't carry it either way: a rig or a
 * ledger a subject or a header can't name.
 */
function rowOnBus(
  row: StoredEvent,
  runIsTheRigs: boolean,
): OnBus & { legacy?: { why: string; with_body: boolean } } {
  const at = { rig: row.rig, ledger: row.ledger_id, seq: row.seq };
  const event = rowEvent(row);
  const as = onBus({ ...at, event, runIsTheRigs });
  if (!("error" in as)) return as;
  const why = as.error.slice(0, LEGACY_TEXT_MAX);
  const whole = onBus({ ...at, event: legacyOf(event), runIsTheRigs: false });
  if (!("error" in whole)) return { ...whole, legacy: { why, with_body: true } };
  if (whole.bytes === null) return whole;
  const cut = onBus({ ...at, event: legacyOf(event, whole.bytes), runIsTheRigs: false });
  return "error" in cut ? cut : { ...cut, legacy: { why, with_body: false } };
}

/** Whether a message is the row's event, as the move publishes it: its rig, ledger and data. */
function holdsRow(m: BusMessage, row: StoredEvent): boolean {
  if (m.header(EVENT_HEADERS.rig) !== row.rig || m.header(EVENT_HEADERS.ledger) !== row.ledger_id)
    return false;
  try {
    const expected = rowOnBus(row, false);
    return !("error" in expected) && new TextDecoder().decode(m.data) === expected.message.data;
  } catch {
    return false;
  }
}

/**
 * The move of the store's events table. run() moves what the stream lacks, checks the stream,
 * and has the table dropped; it waits while the bus is away or its store is full.
 */
export class EventsMove {
  private readonly o: EventsMoveOptions;
  /** Rows it published since control started. */
  published = 0;
  /** Why it waits now (the bus away, its store full); null while it moves, or is done. */
  waiting: string | null = null;
  /** Why it stopped, until control starts again; null while it goes on, or is done. */
  stopped: MoveStopped | null = null;
  /** The copy of the store kept before the table went, outside the copies' rotation. */
  copy: string | undefined;
  private closed = false;

  constructor(o: EventsMoveOptions) {
    this.o = o;
  }

  /**
   * Moves the table's rows, checks the stream, and has the table dropped. Resolves once the table
   * is gone (or was not there), or the move stopped: `stopped` says why.
   */
  async run(): Promise<void> {
    if (!this.o.store.eventsTable.exists()) return;
    while (!this.stopped && !this.closed) {
      try {
        await this.turn();
        if (this.waiting)
          log("control", "control's events go to the bus again", { after: this.waiting });
        this.waiting = null;
        return;
      } catch (err) {
        // Gone, refused or not acked: the next turn reads where the stream ends again.
        const error = publishFailed(err);
        if (this.waiting !== error)
          log("control", "control's events table not moved yet; trying again", { error }, "warn");
        this.waiting = error;
        await pause(this.o.retryMs ?? BUS_RETRY_MS);
      }
    }
  }

  close(): void {
    this.closed = true;
  }

  /** Stops the move, with its words in control's log: control does not start. */
  private stop(s: MoveStopped): void {
    this.stopped = s;
    log("control", "control's events table can't go to the events stream", { ...s }, "error");
  }

  /** Stops the move at the stream, which it can't go on in. */
  private stopAtStream(error: string): void {
    this.stop({ rig: null, ledger: null, seq: null, bytes: null, error });
  }

  private async turn(): Promise<void> {
    const { store, bus } = this.o;
    await bus.makeStream(EVENT_STREAM_CONFIG);
    const { rows, lastSeq } = store.eventsTable.size();
    const end = await movedEnd(bus);
    if (end.seq > lastSeq)
      return this.stopAtStream(
        `the stream holds rows to seq ${end.seq}, past the table's last, ${lastSeq}: control's store is older than the stream`,
      );
    const behind = store.eventsTable.countAfter(end.seq);
    if (behind > 0) {
      const last = await bus.lastSeq(EVENT_STREAM);
      if (end.place < last)
        return this.stopAtStream(
          `the stream holds events published first after place ${end.place}, where the table's rows after seq ${end.seq} would go: control's store is older than the stream`,
        );
      const moved = await this.publishAfter(end, behind);
      if (!moved) return;
    }
    const wrong = await this.check(rows, lastSeq);
    if (wrong)
      return this.stopAtStream(`the events stream lacks rows of control's events table: ${wrong}`);
    log("control", "the events stream holds control's events table whole", {
      rows,
      last_seq: lastSeq,
      sampled: samplePlaces(rows).length,
    });
    this.copy = store.migrate({ eventsMoved: { rows, lastSeq } });
    log("control", "control's events table dropped: the events stream keeps every event", {
      rows,
      copy: this.copy ?? null,
    });
  }

  /**
   * Publishes the table's rows after `end`, a batch at a time, in its order. False when it stopped
   * at a row the bus can't carry.
   */
  private async publishAfter(end: { place: number; seq: number }, behind: number) {
    const { store, bus } = this.o;
    const started = performance.now();
    log("control", "moving control's events table to the events stream", {
      stream_seq: end.seq,
      behind,
    });
    let { place, seq } = end;
    let logged = 0;
    let moved = 0;
    for (;;) {
      const rows = store.eventsTable.inOrder(seq, BUS_BATCH_MAX);
      if (!rows.length) break;
      const { messages, legacy, stop } = this.messagesOf(rows);
      for (const batch of inBatches(messages)) {
        place = await publishAfter(bus, place, batch);
        this.published += batch.length;
        moved += batch.length;
        this.o.published?.();
        // The rows of this batch the move put under `legacy`, said once the stream holds them.
        const through = Number(batch.at(-1)?.headers?.[EVENT_HEADERS.seq]);
        while (legacy[0] && legacy[0].seq <= through) this.saidLegacy(legacy.shift() as Legacy);
      }
      if (stop) {
        this.stop(stop);
        return false;
      }
      seq = rows.at(-1)?.seq ?? seq;
      if (moved - logged >= MOVE_LOG_ROWS) {
        logged = moved;
        const left = store.eventsTable.countAfter(seq);
        log("control", "moving control's events table to the events stream", { moved, left });
      }
    }
    const seconds = Math.round(performance.now() - started) / 1000;
    log("control", "control's events table moved to the events stream", { moved, seconds });
    return true;
  }

  /**
   * The rows' messages, in order, up to a row the bus can't carry, and why it stops there; and the
   * rows among them that go under `legacy`, in order.
   */
  private messagesOf(rows: StoredEvent[]) {
    const { store } = this.o;
    const messages: { out: ReturnType<typeof outgoing>; bytes: number }[] = [];
    const legacy: Legacy[] = [];
    // The rigs the run registry gives each run, looked up once a page.
    const rigsOf = new Map<string, string[]>();
    for (const row of rows) {
      const run = row.run;
      if (run !== null && !rigsOf.has(run)) rigsOf.set(run, store.runRegistry.rigsOf(run));
      const m = rowOnBus(row, run !== null && isTheRigsRun(row.rig, rigsOf.get(run) ?? []));
      if ("error" in m) {
        const at = { rig: row.rig, ledger: row.ledger_id, seq: row.seq };
        return { messages, legacy, stop: { ...at, bytes: m.bytes, error: m.error } };
      }
      if (m.legacy)
        legacy.push({
          seq: row.seq,
          rig: row.rig,
          ledger: row.ledger_id,
          event: row.event.id,
          kind: row.event.kind.slice(0, LEGACY_TEXT_MAX),
          ...m.legacy,
        });
      messages.push({ out: outgoing(m.message), bytes: m.bytes });
    }
    return { messages, legacy, stop: undefined };
  }

  /** Says, in control's log and its audit log, that a row went on the stream under `legacy`. */
  private saidLegacy(l: Legacy): void {
    log(
      "control",
      "an event of control's events table moved under the kind legacy",
      { ...l },
      "warn",
    );
    this.o.store.auditLog.add("control", "event_moved_as_legacy", l);
  }

  /**
   * What is wrong with the moved rows in the stream, in words, or undefined when the stream holds
   * the table whole: as many moved events as rows, from the stream's first place, the last at the
   * table's last seq, and at each sampled place, in order, the event of the row its Thermite-Seq
   * names, the same as the table keeps it.
   */
  private async check(rows: number, lastSeq: number): Promise<string | undefined> {
    const { store, bus } = this.o;
    const end = await movedEnd(bus);
    if (end.place !== rows || end.seq !== lastSeq)
      return `it holds ${end.place} of the table's ${rows} rows, the last at seq ${end.seq}, where the table's last is ${lastSeq}`;
    let before = 0;
    for (const place of samplePlaces(rows)) {
      const m = await bus.message(EVENT_STREAM, place);
      const seq = Number(m?.header(EVENT_HEADERS.seq));
      const row = Number.isSafeInteger(seq) && seq > before ? store.eventsTable.at(seq) : undefined;
      if (!m || !row || !holdsRow(m, row))
        return `its place ${place} does not hold the row it should, in the table's order`;
      before = seq;
    }
    return undefined;
  }
}

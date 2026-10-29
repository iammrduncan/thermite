import { BUS_READ_MAX, BUS_RETRY_MS, type Bus, type BusMessage } from "../../common/bus.ts";
import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { canonicalJson } from "../../core/canonical.ts";
import { EVENT_STREAM, type EventRead, readEventMessage } from "../../core/link/events.ts";
import { currentEvent } from "../../core/names.ts";
import { MODEL_CALL_EVENT, ModelCallBody } from "../../core/usage.ts";
import type { ControlStore } from "../store/index.ts";
import { type FoldCache, keepFolds, streamEvent } from "../views/index.ts";
import { readKnowledgeAgain, takeKbItem } from "./knowledge.ts";

/**
 * What control derives from its rigs' events, written from the `EVENTS` stream (goal 168, step 4).
 * The apply reads the stream in order, from the place control's store applied through
 * (`bus_position`), and writes, for each event: the run registry's entry for a run the rig created,
 * a command's outcome as the harness gave it, a model call's usage, and the knowledge base's items;
 * then each rig ledger's held cursor, the last event of it applied (`rig_ledger.through_event`),
 * and the stream's place, in the same transaction, so that the store and the stream never disagree
 * about what was applied. An event at or below its ledger's held cursor is applied already, and
 * changes nothing. Then it hands each event to control's kept folds (views/cache.ts), which its
 * views read: at control's start it reads the stream from its first message, the events before
 * the store's place for the folds alone, so the folds are built in one pass. The writer of the
 * stream (writer.ts) waits for it to reach what it published before control answers a report, and
 * the move of a store's events table (move.ts) nudges it after each batch it publishes.
 */

/** How many messages one read takes at most: one transaction applies them all. */
export const APPLY_PAGE = BUS_READ_MAX;

export interface EventsApplyOptions {
  store: ControlStore;
  bus: Pick<Bus, "read" | "lastSeq">;
  /** How long it waits after a failure: BUS_RETRY_MS unless a test gives a shorter one. */
  retryMs?: number | undefined;
}

const pause = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(true), ms));
/** How long reach() waits after a turn of the apply that found nothing new, before the next. */
const REACH_PAUSE_MS = 20;

/**
 * The apply of the events stream. start() checks the store's place against the stream's end, then
 * applies what the stream holds after it and hands the folds every message they lack (the first
 * time, from the stream's first), and again at each nudge(). A read or a transaction that fails
 * changes nothing, and is tried again after a pause. A store whose place is past the stream's end
 * stops it for good: control then does not start (main.ts).
 */
export class EventsApply {
  private readonly o: EventsApplyOptions;
  /** Control's kept folds, which its views read: handed every event of the stream, in order. */
  readonly folds: FoldCache;
  readonly since = new Date().toISOString();
  /** Messages it applied since control started. */
  applied = 0;
  /** Messages it could not read as events since control started, and passed over. */
  refused = 0;
  /** Why it waits now (the bus away); null while it applies, or has applied all. */
  waiting: string | null = null;
  /** Why it stopped for good: the store applied the stream past its end. Null while it goes on. */
  stopped: string | null = null;
  private checked = false;
  /** Whether the knowledge base has read again what an upgrade of its reading needs. */
  private readAgain = false;
  private readonly checkedOnce: Promise<void>;
  private markChecked: () => void = () => undefined;
  private due = false;
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(o: EventsApplyOptions) {
    this.o = o;
    this.folds = keepFolds(o.store, o.bus);
    this.checkedOnce = new Promise((r) => {
      this.markChecked = r;
    });
  }

  /**
   * Applies what the stream holds after the store's place, and again at each nudge(). Resolves once
   * it has checked the store's place against the stream's end, waiting for the bus while it is
   * away: `stopped` then says whether the store is past the stream's end.
   */
  start(): Promise<void> {
    void this.nudge();
    return this.checkedOnce;
  }

  /** A turn after the one under way; resolves when it has applied all the stream holds, or stopped. */
  nudge(): Promise<void> {
    this.due = true;
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  close(): void {
    this.closed = true;
    this.markChecked();
  }

  /**
   * Resolves true once control's store has applied the stream through `place`, nudging the apply
   * as often as it takes; false when it has not after `ms` (the bus away, or the apply failing),
   * or once the apply stopped or closed.
   */
  async reach(place: number, ms: number): Promise<boolean> {
    const applied = () => this.o.store.busPositions.of(EVENT_STREAM);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), ms);
    });
    try {
      while (applied() < place) {
        if (this.stopped || this.closed) return false;
        const before = applied();
        if (!(await Promise.race([this.nudge().then(() => true), late]))) return false;
        // A turn that found nothing new yet: the next looks again after a pause.
        if (applied() === before && !(await Promise.race([pause(REACH_PAUSE_MS), late])))
          return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(): Promise<void> {
    // After the code that nudged it has run to its end.
    await Promise.resolve();
    while (this.due && !this.stopped && !this.closed) {
      this.due = false;
      try {
        await this.turn();
        if (this.waiting)
          log("control", "events applied from the bus again", { after: this.waiting });
        this.waiting = null;
      } catch (err) {
        this.due = true;
        const error = errorText(err);
        if (this.waiting !== error)
          log("control", "events not applied from the bus; trying again", { error }, "warn");
        this.waiting = error;
        await pause(this.o.retryMs ?? BUS_RETRY_MS);
      }
    }
  }

  /**
   * The store's place against the stream's last: a store past it holds records of messages the
   * stream does not have, as when one of the two was restored from an older backup, and applying
   * the stream's next messages would skip them.
   */
  private async check(): Promise<void> {
    const { store, bus } = this.o;
    const last = await bus.lastSeq(EVENT_STREAM);
    const place = store.busPositions.of(EVENT_STREAM);
    if (place > last) {
      this.stopped = `control's store has applied the ${EVENT_STREAM} stream to place ${place}, past its last, ${last}: the stream is older than the store, as when one of them was restored from an older backup. Restore the stream from a backup at least as new as the store, or the store from one no newer than the stream, then start control again`;
      log("control", "control's store is past the events stream's end", { place, last }, "error");
    } else {
      this.checked = true;
      const where = { stream: EVENT_STREAM, place, last, behind: last - place };
      log("control", "control's records go on from the events stream's place", where);
    }
    this.markChecked();
  }

  /**
   * Applies every message the stream holds after the store's place, a page at a time, and hands
   * the folds every message after theirs: at control's start, from the stream's first. The
   * knowledge base reads again what an upgrade of its reading needs first, once.
   */
  private async turn(): Promise<void> {
    const { store, bus } = this.o;
    if (!this.checked) await this.check();
    if (this.stopped) return;
    if (!this.readAgain) {
      await readKnowledgeAgain(store, bus);
      this.readAgain = true;
    }
    while (!this.closed) {
      const from = Math.min(store.busPositions.of(EVENT_STREAM), this.folds.through) + 1;
      const read = await bus.read(EVENT_STREAM, { from, limit: APPLY_PAGE });
      if (read.next <= from) return;
      this.applyPage(read.messages, read.next - 1);
      if (read.done) return;
    }
  }

  /**
   * The page's messages after the store's place, in the stream's order, and the place it ends at,
   * in one transaction; then every message after the folds' place to the folds. Each rig
   * ledger's held cursor is read once a page, and written once at its end where it moved.
   */
  private applyPage(messages: readonly BusMessage[], through: number): void {
    const { store } = this.o;
    const place = store.busPositions.of(EVENT_STREAM);
    if (through > place) this.record(messages, place, through);
    const folds = this.folds.through;
    const events = messages.flatMap((m) => (m.seq > folds ? (streamEvent(m) ?? []) : []));
    this.folds.take(events, through);
  }

  /** The messages after the store's place, applied, and the place it ends at, in one transaction. */
  private record(messages: readonly BusMessage[], place: number, through: number): void {
    const { store } = this.o;
    const now = new Date().toISOString();
    const kb = store.kb();
    const fromTable = kb.indexedFromTable();
    const held = new Map<string, Held>();
    let applied = 0;
    let refused = 0;
    store.tx(() => {
      for (const m of messages) {
        if (m.seq <= place) continue;
        const read = readOrSay(m);
        if (!read) {
          refused++;
          continue;
        }
        const key = `${read.rig}\n${read.ledger}`;
        const h = held.get(key) ?? {
          rig: read.rig,
          ledger: read.ledger,
          through: store.reportedRigs.heldCursor(read.rig, read.ledger),
          moved: false,
        };
        held.set(key, h);
        // At or below its ledger's held cursor: applied already, its records in the store.
        if (read.event.id <= h.through) continue;
        // The knowledge base was indexed from control's events table up to `fromTable` before the
        // apply fed it: a message copied from a row at or below it is in it already.
        const toKb = read.seq === undefined || read.seq > fromTable;
        applyEvent(store, read, now, toKb);
        h.through = read.event.id;
        h.moved = true;
        applied++;
      }
      for (const h of held.values())
        if (h.moved) store.reportedRigs.holdThrough(h.rig, h.ledger, h.through, now);
      store.busPositions.set(EVENT_STREAM, through);
    });
    this.applied += applied;
    this.refused += refused;
  }
}

/** A rig ledger's held cursor as a page moves it: the last event applied, and whether it moved. */
interface Held {
  rig: string;
  ledger: string;
  through: number;
  moved: boolean;
}

/** A message read as an event, or undefined, said in control's log, for one it can't read. */
function readOrSay(m: BusMessage): EventRead | undefined {
  try {
    return readEventMessage(m);
  } catch (err) {
    const what = { place: m.seq, subject: m.subject.slice(0, 200), error: errorText(err) };
    log("control", "an event on the bus not applied: control can't read it", what, "error");
    return undefined;
  }
}

/**
 * What control keeps of one event, under the current names (core/names.ts): the run registry's
 * entry for a run the rig created (ingest wrote it before it published the event, whose subject
 * the registry chose; this writes the same again), a command's outcome
 * as the harness gave it, a model call's usage (goal 075; a body that does not read as one stays
 * an event only), and, with `toKb`, its items in the knowledge base: Thermite's reading of it into
 * its run's records slot, or a writer's `kb_item` into the writer's slot (knowledge.ts). An event
 * the knowledge base can't index is left out of it, in control's log and the audit log.
 */
function applyEvent(store: ControlStore, read: EventRead, now: string, toKb: boolean): void {
  const { rig, ledger } = read;
  const e = currentEvent(read.event);
  store.runRegistry.registerRunCreated(rig, ledger, e);
  if (e.kind === "command" && e.subject) {
    const b = (e.body ?? {}) as { accepted?: boolean };
    const status = b.accepted === false ? "failed" : "delivered";
    const outcome = canonicalJson({ source: "harness", ...(e.body as object) });
    store.commands.confirmApplied(rig, e.subject, status, outcome, now);
  }
  const call = e.kind === MODEL_CALL_EVENT && e.subject ? ModelCallBody.safeParse(e.body) : null;
  if (call?.success) store.usage.recordCall(rig, ledger, e.id, String(e.subject), call.data);
  if (!toKb) return;
  try {
    // A savepoint: an event indexed in part is not kept.
    store.tx(() =>
      e.kind === "kb_item"
        ? takeKbItem(store, { rig, ledger }, e)
        : store.kb().index({ rig, ledger }, e),
    );
  } catch (err) {
    const error = redact(errorText(err));
    const what = { rig, ledger, event: e.id, kind: e.kind, error };
    log("control", "an event not indexed in the knowledge base", what, "error");
    store.auditLog.add("control", "kb_failed", { rig, error });
  }
}

/**
 * The apply's state, for the bus's state (REST, MCP, /metrics): the stream's place control's store
 * applied through, the stream's last place as the server has it (`last`: null when the server did
 * not answer), the messages between them, those applied and passed over since control started,
 * and why it waits or stopped.
 */
export function applyState(store: ControlStore, apply: EventsApply, last: number | null) {
  const place = store.busPositions.of(EVENT_STREAM);
  return {
    place,
    last_place: last,
    behind: last === null ? null : Math.max(0, last - place),
    applied: apply.applied,
    refused: apply.refused,
    waiting: apply.waiting,
    stopped: apply.stopped,
  };
}

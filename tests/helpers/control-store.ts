import { BUS_READ_MAX } from "../../src/common/bus/index.ts";
import { EventsApply, EventsMove, EventsWriter } from "../../src/control/events/index.ts";
import { keepReport } from "../../src/control/ingest.ts";
import { ControlStore, type IngestReport } from "../../src/control/store/index.ts";
import {
  FoldCache,
  keepFolds,
  type RawEvent,
  rigEventsPage,
  type StoredEvent,
  streamEvent,
} from "../../src/control/views/index.ts";
import { foldEvent, readLedger } from "../../src/control/views/stream.ts";
import { EVENT_STREAM, EVENT_STREAM_CONFIG } from "../../src/core/link/events.ts";
import { FakeBus } from "./fake-bus.ts";

/**
 * Control's store as control's main makes it (goal 168, step 4): on its message bus, here the fake
 * one, with the writer of the events stream, which publishes each report's events first, the move
 * of the events table a store from before the stream holds, and the apply of the stream, which
 * writes what control derives from the events (a command's outcome as the harness gave it, a model
 * call's usage, the knowledge base) and hands them to control's views. A test takes a report with
 * ingestReport(), which answers once its events are applied.
 */

interface OnBus {
  bus: FakeBus;
  writer: EventsWriter;
  move: EventsMove;
  apply: EventsApply;
  /** The stream made, the apply's check of the store's place, then the move, as main.ts runs them. */
  started: Promise<void>;
}

const onBus = new WeakMap<ControlStore, OnBus>();

/**
 * A store at `path` (in memory unless given) on `bus` (a fake bus of its own unless given), with
 * the apply, the writer and the move started as control's main starts them.
 */
export function controlStore(path = ":memory:", bus = new FakeBus()): ControlStore {
  const store = new ControlStore(path);
  const apply = new EventsApply({ store, bus, retryMs: 5 });
  const writer = new EventsWriter({ store, bus, apply, applyWaitMs: 2_000 });
  const move = new EventsMove({ store, bus, retryMs: 5, published: () => void apply.nudge() });
  const started = bus
    .makeStream(EVENT_STREAM_CONFIG)
    .then(() => apply.start())
    .then(() => (apply.stopped ? undefined : writer.alone(() => move.run())));
  onBus.set(store, { bus, writer, move, apply, started });
  return store;
}

/** The store's bus, its writer, its move and its apply, for a test that looks at them. */
export function busOf(store: ControlStore): OnBus {
  const o = onBus.get(store);
  if (!o) throw new Error("a store controlStore() did not make has no bus");
  return o;
}

/**
 * A rig's report taken as control takes one that passed its checks (control/ingest.ts), in the
 * writer's turn: its events after the held cursor of its ledger published to the events stream
 * and applied, and the rig's row noting it. How many events it added. A report refused for now
 * fails the test.
 */
export async function ingestReport(store: ControlStore, report: IngestReport): Promise<number> {
  const o = busOf(store);
  await o.started;
  const kept = await o.writer.turn(() => keepReport(store, report));
  if ("later" in kept) throw new Error(`the report was refused for now: ${kept.later}`);
  return kept.added;
}

/**
 * Waits until the apply has applied every event the stream holds: the move of an old store's
 * table first, as control's start runs it.
 */
export async function applied(store: ControlStore): Promise<void> {
  const o = busOf(store);
  await o.started;
  await o.apply.nudge();
}

/** Stops the store's move and apply, for a test that opens the same store again. */
export function closeBus(store: ControlStore): void {
  const o = busOf(store);
  o.move.close();
  o.apply.close();
}

/**
 * A rig's events as control holds them, oldest first, under the current names, read from its
 * events stream as `GET /v1/rigs/<rig>/events` reads them (each one's seq is its place there),
 * once the apply has applied it.
 */
export async function heldEvents(store: ControlStore, rig: string): Promise<RawEvent[]> {
  await applied(store);
  return await rigEventsPage(store, { rig, after: 0, limit: BUS_READ_MAX });
}

/**
 * Folds of the store's events made now, in one pass over its events stream from the first
 * message, as control's start makes them: what the folds control kept must give the same views
 * as.
 */
export async function freshFolds(store: ControlStore): Promise<FoldCache> {
  await applied(store);
  const { bus } = busOf(store);
  const folds = new FoldCache(store, bus);
  for (let from = 1; ; ) {
    const read = await bus.read(EVENT_STREAM, { from, limit: BUS_READ_MAX });
    if (read.next <= from) return folds;
    folds.take(
      read.messages.flatMap((m) => streamEvent(m) ?? []),
      read.next - 1,
    );
    if (read.done) return folds;
    from = read.next;
  }
}

/**
 * A rig ledger's events as its fold takes them (views/stream.ts), oldest first: from the store's
 * events stream, once the apply has applied it.
 */
export async function foldedEvents(
  store: ControlStore,
  rig: string,
  ledger: string,
): Promise<StoredEvent[]> {
  await applied(store);
  const out: StoredEvent[] = [];
  for (let from = 1; ; ) {
    const subjects = keepFolds(store).subjectsOf(rig);
    const page = await readLedger(busOf(store).bus, { rig, ledger, subjects, from });
    for (const e of page.events) {
      const stored = foldEvent(e);
      if (stored) out.push(stored);
    }
    if (page.done || page.next <= from) return out;
    from = page.next;
  }
}

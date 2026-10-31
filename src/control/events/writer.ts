import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { EVENT_STREAM } from "../../core/link/events.ts";
import { reportMessageId } from "../../core/link/report.ts";
import type { ControlStore, IngestReport } from "../store/index.ts";
import type { EventsApply } from "./apply.ts";
import { inBatches, isTheRigsRun, onBus, outgoing, publishAfter, publishFailed } from "./batch.ts";

/**
 * The writer of the `EVENTS` stream (goal 168, step 4): control keeps each report's events on its
 * message bus first, and nowhere else. In its turn, one report at a time from the reports stream,
 * it publishes the
 * events after the held cursor of the report's rig ledger, in order, in atomic batches (batch.ts),
 * each event with its message id (`<rig>:<ledger>:<event id>`) and its report's (`Thermite-Report`);
 * then it waits until the apply of the stream (apply.ts) has applied them, which moves the held
 * cursor, before control answers. An event is published once: inside the server's duplicate
 * window its id keeps it once; beyond it, the held cursor, exact once the apply has applied what the
 * stream holds, which the writer waits for before it reads the cursor. A report of several batches
 * that fails part way leaves only whole batches in the stream, the ledger's next events in order;
 * the apply moves the cursor through them, and the report sent again publishes only what follows.
 * The bus away, its store full or the apply late: the report is refused for now, in words, and
 * control keeps nothing of it but what the stream took; the rig sends it again.
 */

/** How many reports may wait for the writer's turn at once: one more is refused for now. */
export const WRITER_WAITING_MAX = 32;
/**
 * How long a report waits for the apply of the stream to reach what the writer published, or the
 * stream's end after a publish failed: it is then refused for now, and the rig sends it again.
 */
export const APPLY_WAIT_MS = 20_000;

/** What became of a report's events: published and applied, or refused for now, in words. */
export type Written = { added: number } | { later: string };

export interface EventsWriterOptions {
  store: ControlStore;
  bus: Pick<Bus, "publishBatch" | "lastSeq">;
  apply: Pick<EventsApply, "reach">;
  /** How long a report waits for the apply: APPLY_WAIT_MS unless a test gives a shorter one. */
  applyWaitMs?: number | undefined;
}

/** Each store's writer: one control process, one writer. */
const WRITERS = new WeakMap<ControlStore, EventsWriter>();

/** The writer of the store's events, or undefined for a store control made without its bus. */
export function writerOf(store: ControlStore): EventsWriter | undefined {
  return WRITERS.get(store);
}

export class EventsWriter {
  private readonly o: EventsWriterOptions;
  readonly since = new Date().toISOString();
  /** Events published since control started. */
  published = 0;
  /** Reports refused for now since control started. */
  later = 0;
  /** Why the last report was refused for now; null once one is taken. */
  waiting: string | null = null;
  /** The stream's last place, as the writer last read or published it. */
  private place = 0;
  /** Set: the stream's end is read again before the next publish. */
  private reread = true;
  private last: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(o: EventsWriterOptions) {
    this.o = o;
    WRITERS.set(o.store, this);
  }

  /**
   * Whether as many reports wait for the turn as it takes: the words of the next one's refusal for
   * now, counted; undefined while there is room.
   */
  tooMany(): string | undefined {
    if (this.queued < WRITER_WAITING_MAX) return undefined;
    this.later++;
    return `${this.queued} reports wait to go on control's message bus: send this one again`;
  }

  /** Runs `work` in the writer's turn, after every turn asked for before it. */
  turn<T>(work: () => Promise<T>): Promise<T> {
    this.queued++;
    const next = this.last.then(work).finally(() => {
      this.queued--;
    });
    this.last = next.catch(() => undefined);
    return next;
  }

  /** Other work that publishes to the stream, as the move, in the writer's turn. */
  alone<T>(work: () => Promise<T>): Promise<T> {
    return this.turn(async () => {
      try {
        return await work();
      } finally {
        this.reread = true;
      }
    });
  }

  /**
   * In the writer's turn: the report's events after its ledger's held cursor, published in order
   * and applied; or why not now. The report passed control's checks (control/ingest.ts), and its
   * new runs are in the run registry, which chooses its events' subjects.
   */
  async publish(page: IngestReport): Promise<Written> {
    const { store, bus, apply } = this.o;
    const { rig, ledger_id: ledger } = page;
    if (!page.events.length) return this.taken(0);
    try {
      if (this.reread) {
        this.place = await bus.lastSeq(EVENT_STREAM);
        this.reread = false;
      }
    } catch (err) {
      return this.refused(rig, publishFailed(err));
    }
    if (!(await apply.reach(this.place, this.waitMs()))) return this.late(rig);
    // In the ledger's order, each once: the apply takes an event at or below its ledger's held
    // cursor as applied already.
    const held = store.reportedRigs.heldCursor(rig, ledger);
    const fresh = page.events
      .filter((e) => e.id > held)
      .sort((a, b) => a.id - b.id)
      .filter((e, i, sorted) => sorted[i - 1]?.id !== e.id);
    if (!fresh.length) return this.taken(0);
    const report = reportMessageId({ ...page, generated_at: page.generated_at ?? "" });
    // The rigs the run registry gives each run, looked up once a report.
    const rigsOf = new Map<string, string[]>();
    const messages = fresh.map((event) => {
      const run = event.run ?? null;
      if (run !== null && !rigsOf.has(run)) rigsOf.set(run, store.runRegistry.rigsOf(run));
      const runIsTheRigs = run !== null && isTheRigsRun(rig, rigsOf.get(run) ?? []);
      const m = onBus({ rig, ledger, event, runIsTheRigs, report });
      // Ingest refused a report with an event the bus can't carry before it came here.
      if ("error" in m) throw new Error(`event ${event.id} of rig ${rig}: ${m.error}`);
      return { out: outgoing(m.message), bytes: m.bytes };
    });
    for (const batch of inBatches(messages)) {
      try {
        this.place = await publishAfter(bus, this.place, batch);
      } catch (err) {
        // Gone, refused or not acked: the stream's end is read again before the next publish.
        this.reread = true;
        return this.refused(rig, publishFailed(err));
      }
      this.published += batch.length;
    }
    if (!(await apply.reach(this.place, this.waitMs()))) return this.late(rig);
    return this.taken(fresh.length);
  }

  private waitMs(): number {
    return this.o.applyWaitMs ?? APPLY_WAIT_MS;
  }

  private taken(added: number): Written {
    if (this.waiting)
      log("control", "reports' events go on the bus again", { after: this.waiting });
    this.waiting = null;
    return { added };
  }

  /** A report refused for now, said in control's log when the reason changes. */
  private refused(rig: string, error: string): Written {
    this.later++;
    if (this.waiting !== error) {
      const what = { rig, error };
      log("control", "a report refused for now: its events are not on the bus", what, "warn");
    }
    this.waiting = error;
    return {
      later: `the message bus did not take this report's events: ${error}. Control takes the report once the bus does: send it again`,
    };
  }

  private late(rig: string): Written {
    const error = `control has not applied its events stream to its end within ${this.waitMs() / 1000} seconds`;
    this.later++;
    if (this.waiting !== error) {
      const what = { rig, error };
      log("control", "a report refused for now: its events are not applied yet", what, "warn");
    }
    this.waiting = error;
    return { later: `${error}: send the report again` };
  }
}

/**
 * The writer's state, for the bus's state (REST, MCP, /metrics): the events it published since
 * control started, at `since`, the rows the move published at control's start, the reports
 * refused for now, and why the last one was, or null once one is taken.
 */
export function writerState(writer: EventsWriter, moved: number) {
  return {
    stream: EVENT_STREAM,
    since: writer.since,
    published: writer.published,
    moved,
    later: writer.later,
    waiting: writer.waiting,
  };
}

import { errorText } from "../../common/errors.ts";
import { log, logDebug } from "../../common/log.ts";
import { RIG_ID } from "../../core/ids.ts";
import { rigEventSubjects } from "../../core/link/events.ts";
import type { ControlStore, RegisteredRun } from "../store/index.ts";
import { type FoldedRig, type RigCheckView, RigFold } from "./fold/index.ts";
import { type RigRow, readRig, rigInputs, type ViewOptions } from "./rig.ts";
import { ownCopier } from "./sharing.ts";
import {
  type EventBus,
  foldEvent,
  type RawEvent,
  readLedger,
  rigEventsAfter,
  runEventsOfKind,
  type StreamEvent,
} from "./stream.ts";
import type { RigView, RunOnRig, RunView } from "./types.ts";

/**
 * The folds control keeps (goal 168): one for each rig, of its current ledger's events, kept up to
 * date by the apply of the message bus's events stream (control/events), which hands them each
 * event in the stream's order as it applies it (take). At control's start the apply reads the
 * stream from its first message, so the folds are built in one pass before control serves its
 * pages; after that, a view folds nothing when it is read and asks the store for no event. A
 * rig's new ledger (a full reset) starts a new fold, and its old one joins the earlier ones below;
 * so does the fold of a rig no longer listed (retired). The stream keeps every event for good and
 * the folds take each once, so a fold is never built again for its own ledger. A reader that
 * follows one part of a rig often (rigChecks, runMessages) reads it from the fold, without the
 * rest of the rig's view.
 *
 * A run is read wherever it ran (goal 170), from control's run registry: its rig and its ledger.
 * A run of an earlier ledger, or of a retired rig, is read from a fold of that ledger's events,
 * read from the stream when it is first needed (stream.ts) and then kept up to date as the rigs'
 * are, for the EARLIER_FOLDS ledgers read last. Since the folds take every event, they also know
 * the runs each rig's events name, whose subjects the stream's reads of a rig's events read.
 */

/**
 * One fold: its ledger, the seq of the newest of its events taken (its place in the stream), and
 * the place in the stream through which it holds every event of its ledger.
 */
interface Kept {
  ledger: string | null;
  fold: RigFold;
  seq: number;
  through: number;
}

/** How many folds of earlier ledgers and retired rigs are kept; the one read longest ago goes. */
export const EARLIER_FOLDS = 16;

/** A rig ledger's key among the folds. */
const keyOf = (rig: string, ledger: string | null) => `${rig}\n${ledger ?? ""}`;

export class FoldCache {
  private readonly store: ControlStore;
  /** The bus the folds of earlier ledgers are read from; none: they can't be read. */
  bus: EventBus | undefined;
  private readonly kept = new Map<string, Kept>();
  /** The earlier ledgers' and retired rigs' folds, by rig and ledger, the one read last at the end. */
  private readonly earlier = new Map<string, Kept>();
  /** The folds of earlier ledgers being read from the stream now, by rig and ledger. */
  private readonly loading = new Map<string, Promise<Kept>>();
  /** Each rig ledger the folds were handed an event of, by rig and ledger. */
  private readonly seen = new Set<string>();
  /** The runs each rig's events name, in any ledger: the run subjects its events are on. */
  private readonly runsOf = new Map<string, Set<string>>();
  /** A rig whose fold failed on one of its events, and why: its views say so, until a new ledger. */
  private readonly failed = new Map<string, string>();
  /** The place in the stream through which the folds were handed every event. */
  through = 0;

  constructor(store: ControlStore, bus?: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  /**
   * Events of the stream, in its order, as the apply hands them over, through the place `through`:
   * each goes to the fold of its rig ledger. A rig's current ledger, as control's store has it,
   * gets a fold at its first event; another ledger's event goes only to a fold kept of it. One the
   * folds took already is passed over. A fold that fails on an event is dropped, and its rig's
   * views say so.
   */
  take(events: readonly StreamEvent[], through: number): void {
    const current = new Map(this.store.reportedRigs.list().map((r) => [r.id, r.ledger_id]));
    for (const e of events) {
      if (e.place <= this.through) continue;
      const { rig, ledger, event } = e.read;
      const key = keyOf(rig, ledger);
      const first = !this.seen.has(key);
      this.seen.add(key);
      if (event.run) this.runsNamed(rig).add(event.run);
      let k = this.kept.get(rig);
      if (k?.ledger !== ledger) k = this.earlier.get(key);
      if (!k && first && current.get(rig) === ledger) k = this.start(rig, ledger);
      if (k && e.place > k.through) this.fold(rig, key, k, e);
    }
    this.through = Math.max(this.through, through);
  }

  /** A rig's view, read now; undefined for a rig control does not list. */
  view(rig: string, opts: ViewOptions): RigView | undefined {
    const row = this.store.reportedRigs.list().find((x) => x.id === rig);
    if (!row) {
      this.drop(rig);
      return undefined;
    }
    return this.read(row, opts);
  }

  /**
   * What a rig's fold holds now, without the rest of its view and without a copy: for a reader of
   * one part that reads it often. Undefined for a rig control does not list. The reader never
   * changes what it reads.
   */
  folded(rig: string): FoldedRig | undefined {
    const row = this.store.reportedRigs.list().find((x) => x.id === rig);
    if (!row) {
      this.drop(rig);
      return undefined;
    }
    return this.current(row).state();
  }

  /**
   * Every rig's view, read now. A rig whose events can't be read now is listed as `unreadable`,
   * with why, so one rig never keeps the others' views from a page.
   */
  views(opts: ViewOptions): RigView[] {
    const rows = this.store.reportedRigs.list();
    const listed = new Set(rows.map((u) => u.id));
    for (const rig of this.kept.keys()) if (!listed.has(rig)) this.drop(rig);
    return rows.map((u) => this.readOrSay(u, opts));
  }

  /** A run's view wherever it ran, read now; undefined for a run no rig created. */
  async run(id: string, opts: ViewOptions): Promise<RunOnRig | undefined> {
    const r = this.store.runRegistry.created(id);
    return r ? (await this.place([r], opts))[0] : undefined;
  }

  /** The run of this name a rig created, wherever on the rig it ran, read now; or undefined. */
  async runOn(rig: string, id: string, opts: ViewOptions): Promise<RunOnRig | undefined> {
    const r = this.store.runRegistry.createdOn(id, rig);
    return r ? (await this.place([r], opts))[0] : undefined;
  }

  /** Every run of a campaign a rig created, newest first, earlier ones too, read now. */
  campaignRuns(campaign: string, opts: ViewOptions): Promise<RunOnRig[]> {
    return this.place(this.store.runRegistry.ofCampaign(campaign), opts);
  }

  /**
   * A retired rig's fold, made ready before the rig is brought back: one of the earlier folds kept,
   * or read from the stream, which its first view after takes as the rig's own.
   */
  async restore(rig: string): Promise<void> {
    const row = this.store.reportedRigs.list({ withRetired: true }).find((x) => x.id === rig);
    if (!row || row.ledger_id === null || this.kept.get(rig)?.ledger === row.ledger_id) return;
    await this.earlierFold(rig, row.ledger_id);
  }

  /**
   * The subjects a rig's events are on (core/link/events.ts): its own, and those of the runs its
   * events taken so far name. None for a name no rig on the bus can have.
   */
  subjectsOf(rig: string): string[] {
    return RIG_ID.test(rig) ? rigEventSubjects(rig, this.runsOf.get(rig) ?? []) : [];
  }

  /** The folds kept: each rig's ledger and the seq of the newest of its events taken. */
  held(): { rig: string; ledger: string | null; seq: number }[] {
    return [...this.kept].map(([rig, k]) => ({ rig, ledger: k.ledger, seq: k.seq }));
  }

  /** The earlier ledgers' and retired rigs' folds kept, the one read last at the end. */
  heldEarlier(): { rig: string; ledger: string | null }[] {
    return [...this.earlier].map(([key, k]) => ({
      rig: key.split("\n")[0] ?? "",
      ledger: k.ledger,
    }));
  }

  /** The runs a rig's events named, made at its first. */
  private runsNamed(rig: string): Set<string> {
    let runs = this.runsOf.get(rig);
    if (!runs) {
      runs = new Set();
      this.runsOf.set(rig, runs);
    }
    return runs;
  }

  /** A new fold of a rig's ledger, kept as the rig's own; the one it had joins the earlier ones. */
  private start(rig: string, ledger: string | null): Kept {
    const k: Kept = { ledger, fold: new RigFold(), seq: 0, through: this.through };
    this.keep(rig, k);
    this.failed.delete(rig);
    return k;
  }

  /** `k` kept as the rig's own fold; the one it had joins the earlier ones. */
  private keep(rig: string, k: Kept): void {
    const old = this.kept.get(rig);
    if (old && old !== k) this.remember(rig, old);
    this.kept.set(rig, k);
  }

  /**
   * A fold among the earlier ones, read last; past EARLIER_FOLDS, the one read longest ago goes.
   * A rig's fold from before its first report holds nothing, and goes.
   */
  private remember(rig: string, k: Kept): void {
    if (k.ledger === null) return;
    const key = keyOf(rig, k.ledger);
    this.earlier.delete(key);
    this.earlier.set(key, k);
    for (const old of this.earlier.keys()) {
      if (this.earlier.size <= EARLIER_FOLDS) break;
      this.earlier.delete(old);
    }
  }

  /** A rig control no longer lists (retired, or never reported): its fold joins the earlier ones. */
  private drop(rig: string): void {
    const k = this.kept.get(rig);
    if (!k) return;
    this.kept.delete(rig);
    this.remember(rig, k);
    logDebug("control", "a rig's kept fold dropped", { rig });
  }

  /**
   * One event into a fold. A fold that fails is dropped: the rig's views say why, until its next
   * ledger, and an earlier ledger's is read from the stream again when it is next needed.
   */
  private fold(rig: string, key: string, k: Kept, e: StreamEvent): void {
    try {
      const stored = foldEvent(e);
      const why = stored && k.fold.apply(stored);
      if (why) {
        const what = { rig, ledger: k.ledger, event: e.read.event.id, kind: stored.kind, why };
        log("control", "an event the views can't read: kept, not folded", what, "warn");
      }
      k.seq = e.place;
      k.through = e.place;
    } catch (err) {
      const error = `rig ${rig}'s view failed on its event ${e.read.event.id} (${e.read.event.kind}): ${errorText(err)}`;
      log("control", "a rig's fold failed on an event", { rig, ledger: k.ledger, error }, "error");
      if (this.kept.get(rig) === k) {
        this.kept.delete(rig);
        this.failed.set(rig, error);
      }
      if (this.earlier.get(key) === k) this.earlier.delete(key);
    }
  }

  private read(row: RigRow, opts: ViewOptions): RigView {
    return readRig(this.current(row).state(), rigInputs(this.store, row, opts));
  }

  /** A rig's view; or, when its events can't be read now, one without them that says why. */
  private readOrSay(row: RigRow, opts: ViewOptions): RigView {
    try {
      return this.read(row, opts);
    } catch (err) {
      const empty = readRig(new RigFold().state(), rigInputs(this.store, row, opts));
      return { ...empty, unreadable: errorText(err) };
    }
  }

  /**
   * The fold of the rig's current ledger: the one kept; an earlier one, for a rig brought back
   * from retirement; or, for a ledger the folds have taken no event of yet (a full reset's new
   * one, its first events still on their way), a new one. A ledger whose fold went is being read
   * from the stream again: the view says so, in words.
   */
  private current(row: RigRow): RigFold {
    const failed = this.failed.get(row.id);
    if (failed) throw new Error(failed);
    const k = this.kept.get(row.id);
    if (k && k.ledger === row.ledger_id) return k.fold;
    const key = keyOf(row.id, row.ledger_id);
    const back = this.earlier.get(key);
    if (back) {
      this.earlier.delete(key);
      this.keep(row.id, back);
      return back.fold;
    }
    if (this.seen.has(key)) {
      this.restore(row.id).catch((err: unknown) => {
        const what = { rig: row.id, error: errorText(err) };
        log("control", "a rig's fold not read again from the bus", what, "error");
      });
      throw new Error(
        `control is reading rig ${row.id}'s events from the message bus again: try again in a moment`,
      );
    }
    return this.start(row.id, row.ledger_id).fold;
  }

  /**
   * Each registered run with the view of its rig as of its ledger: the rig's own view for a listed
   * rig's current ledger, else the view of an earlier fold. A rig is read once for all its runs.
   */
  private async place(runs: RegisteredRun[], opts: ViewOptions): Promise<RunOnRig[]> {
    const rows = new Map(this.store.reportedRigs.list({ withRetired: true }).map((u) => [u.id, u]));
    const read = new Map<string, RigView | undefined>();
    const out: RunOnRig[] = [];
    for (const r of runs) {
      const row = rows.get(r.rig);
      if (!row) continue;
      const retired = this.store.retired.get(r.rig) !== undefined;
      const current = !retired && row.ledger_id === r.ledger_id;
      const key = keyOf(r.rig, r.ledger_id);
      if (!read.has(key))
        read.set(
          key,
          current ? this.view(r.rig, opts) : await this.earlierView(row, r.ledger_id, opts),
        );
      const rig = read.get(key);
      const run = rig?.runs.find((x) => x.id === r.run);
      if (rig && run)
        out.push({ rig, run, earlier: retired ? "retired" : current ? null : "reset" });
    }
    return out;
  }

  /**
   * A view of one ledger of a rig that is not the rig's current view: an earlier ledger, or a
   * retired rig's. Its report is the rig's last one for its own ledger, and none for another.
   */
  private async earlierView(row: RigRow, ledger: string, opts: ViewOptions): Promise<RigView> {
    const k = await this.earlierFold(row.id, ledger);
    const own = row.ledger_id === ledger;
    const at = { ...row, ledger_id: ledger, summary: own ? row.summary : {} };
    return readRig(k.fold.state(), rigInputs(this.store, at, opts));
  }

  /** An earlier fold of a rig ledger, read last now: kept, or read from the stream. */
  private async earlierFold(rig: string, ledger: string): Promise<Kept> {
    const key = keyOf(rig, ledger);
    const kept = this.earlier.get(key);
    if (kept) {
      this.remember(rig, kept);
      return kept;
    }
    let loading = this.loading.get(key);
    if (!loading) {
      loading = this.load(rig, ledger).finally(() => this.loading.delete(key));
      this.loading.set(key, loading);
    }
    return await loading;
  }

  /**
   * A fold of a rig ledger from the stream, a read at a time, kept among the earlier ones: every
   * event of it the folds have taken, the place they reached read again after each read, so the
   * fold, once kept, misses none, and the apply hands it the rest. An event past the place the
   * folds had reached when a read began waits for the next read: the subjects it read are the
   * runs the folds knew then.
   */
  private async load(rig: string, ledger: string): Promise<Kept> {
    const bus = this.bus;
    if (!bus) throw new Error("control reads its rigs' events from the message bus, and has none");
    const started = performance.now();
    const k: Kept = { ledger, fold: new RigFold(), seq: 0, through: 0 };
    while (k.through < this.through) {
      const upTo = this.through;
      const subjects = this.subjectsOf(rig);
      const page = await readLedger(bus, { rig, ledger, subjects, from: k.through + 1 });
      for (const e of page.events) {
        if (e.place > upTo) break;
        const stored = foldEvent(e);
        if (stored) k.fold.apply(stored);
        k.seq = e.place;
      }
      k.through = page.done ? upTo : Math.min(page.next - 1, upTo);
    }
    this.remember(rig, k);
    const ms = Math.round(performance.now() - started);
    logDebug("control", "an earlier ledger's events folded", { rig, ledger, ms });
    return k;
  }
}

/** Each store's kept folds: one control process, one set. */
const CACHES = new WeakMap<ControlStore, FoldCache>();

/**
 * The folds control keeps for `store`, made at the first call: the apply of the events stream
 * makes them with the bus, and hands them every event (control/events); controlParts reads them.
 */
export function keepFolds(store: ControlStore, bus?: EventBus): FoldCache {
  let c = CACHES.get(store);
  if (!c) {
    c = new FoldCache(store, bus);
    CACHES.set(store, c);
  }
  c.bus ??= bus;
  return c;
}

/**
 * The folds control keeps for the store, or, for a store without them (a test's, a script's),
 * new ones that hold no event.
 */
const foldsOf = (store: ControlStore) => CACHES.get(store) ?? new FoldCache(store);

/**
 * The store's folds, with the bus they read the stream through; it says so in words when there is
 * none.
 */
function onBus(store: ControlStore): { folds: FoldCache; bus: EventBus } {
  const folds = CACHES.get(store);
  if (!folds?.bus)
    throw new Error("control reads its rigs' events from the message bus, and has none");
  return { folds, bus: folds.bus };
}

const DEFAULT_VIEW: ViewOptions = { staleAfterMs: 180_000 };

/**
 * A rig's view from its events (only the current ledger's, after a reset): through the folds
 * control keeps for the store, or, for a store without them, a view with no event.
 */
export function rigView(
  store: ControlStore,
  rig: string,
  opts: ViewOptions = DEFAULT_VIEW,
): RigView | undefined {
  return foldsOf(store).view(rig, opts);
}

/** Every rig's view, as rigView reads one; a rig whose events can't be read says why (`unreadable`). */
export function rigViews(store: ControlStore, opts: ViewOptions = DEFAULT_VIEW): RigView[] {
  return foldsOf(store).views(opts);
}

/** A run's view wherever it ran (goal 170), as rigView reads a rig's: undefined when none. */
export function findRun(
  store: ControlStore,
  run: string,
  opts: ViewOptions = DEFAULT_VIEW,
): Promise<RunOnRig | undefined> {
  return foldsOf(store).run(run, opts);
}

/**
 * The run of this name a rig created, wherever on the rig it ran (an earlier ledger too), as
 * findRun reads a run: undefined when the rig created none.
 */
export function findRunOn(
  store: ControlStore,
  rig: string,
  run: string,
  opts: ViewOptions = DEFAULT_VIEW,
): Promise<RunOnRig | undefined> {
  return foldsOf(store).runOn(rig, run, opts);
}

/** Every run of a campaign a rig created, newest first, earlier ones too, as findRun reads one. */
export function campaignRuns(
  store: ControlStore,
  campaign: string,
  opts: ViewOptions = DEFAULT_VIEW,
): Promise<RunOnRig[]> {
  return foldsOf(store).campaignRuns(campaign, opts);
}

/**
 * A rig's checks, each one's newest run on its current ledger, from its fold without the rest of
 * its view: what a check's row reads, which the dashboard follows often. None for a rig control
 * does not list.
 */
export function rigChecks(store: ControlStore, rig: string): Record<string, RigCheckView> {
  return ownCopier()(foldsOf(store).folded(rig)?.checks ?? {});
}

/**
 * The runs a rig closed on its current ledger, from its fold. None while its events can't be read
 * (the view says why): then what is handed for a run rests on its assignment's status alone.
 */
export function closedRuns(store: ControlStore, rig: string): Set<string> {
  let runs: RunView[];
  try {
    runs = foldsOf(store).folded(rig)?.runs ?? [];
  } catch (err) {
    logDebug("control", "a rig's closed runs not read", { rig, error: errorText(err) });
    return new Set();
  }
  return new Set(runs.filter((r) => r.status === "closed").map((r) => r.id));
}

/**
 * The owner's messages to one run on a rig's current ledger, by id, from the rig's signed events
 * as its fold holds them, without the rest of its view: what Live checks a run's message lines
 * against each time it draws them (a worker's own line can claim anything).
 */
export function runMessages(
  store: ControlStore,
  rig: string,
  run: string,
): Map<number, { to: string; text: string; keep: boolean }> {
  const r = foldsOf(store)
    .folded(rig)
    ?.runs.find((x) => x.id === run);
  return new Map((r?.messages ?? []).map((m) => [m.id, { to: m.to, text: m.text, keep: m.keep }]));
}

/**
 * A rig's events after a place in the stream, oldest first, `limit` at most, each with its place
 * as its `seq`: what `GET /v1/rigs/<rig>/events` gives (stream.ts). Those the folds have taken: a
 * page that ends early ends at the place the folds reached.
 */
export async function rigEventsPage(
  store: ControlStore,
  o: { rig: string; after: number; limit: number },
): Promise<RawEvent[]> {
  const { folds, bus } = onBus(store);
  const subjects = folds.subjectsOf(o.rig);
  if (!subjects.length) return [];
  return await rigEventsAfter(bus, { ...o, subjects, through: folds.through });
}

/** A run's events of one kind on a rig, oldest first, in every ledger (stream.ts). */
export async function runEvents(
  store: ControlStore,
  o: { rig: string; run: string; kind: string },
): Promise<StreamEvent[]> {
  if (!RIG_ID.test(o.rig)) return [];
  return await runEventsOfKind(onBus(store).bus, o);
}

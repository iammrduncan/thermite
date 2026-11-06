import { z } from "zod";
import { ExperimentText, type QueuePosition } from "../core/commands.ts";
import { DIRECTION_NAME, directionOf, RESEARCH_TASK_KINDS } from "../core/directions.ts";
import { newExperimentId } from "../core/ids.ts";
import { labelledQuestion } from "../core/research-check.ts";
import { FINAL_LIFECYCLES, WON_VERDICTS } from "../core/verdicts.ts";
import {
  type ExperimentRow,
  type ExperimentTry,
  type Ledger,
  LedgerError,
} from "./ledger/index.ts";

/**
 * Each run's experiment queue (goal 064): the experiments still to try, in order, and the log
 * of those tried, with what became of each. It is research state, so it lives in the ledger.
 *
 * States: `proposed` (a lane's idea, waiting for the planner or the owner), `queued` (up next,
 * in order), `assigned` (a lane's trial works on it), `done` (its trial ended: its attempt, or
 * no attempt and why) and `dropped` (with who dropped it and why).
 *
 * Tries (goal 214): an experiment may get more than one trial (`tries`, 1 by default). A try that
 * ends without a win (no attempt, or an attempt the judge settles without one) sends the same
 * experiment back to the top, with the try kept (`experiment_try`), until a try wins or none is
 * left. A lane that tried it gets it again only when every lane of the run has.
 *
 * Writers: the owner (signed commands), the planner (it coordinates: it gives queued work to
 * lanes without overlap, and adds, moves, drops and accepts experiments), the advisors (add and
 * move) and the workers (propose ideas). Every change is one call of the ledger's
 * `experiments.write`: its rows and one event, in one transaction. Control builds its view of the
 * queue from those events, so the places here follow control's rule exactly: an experiment's
 * place is its index among the queued ones (0 first), and a position names an index among the
 * others ("top": 0, "end": after the last).
 */

export type Experiment = ExperimentRow;

/**
 * An attempt's lifecycles that end its experiment's tries (goal 214): a win, a win that waits for
 * the owner, or one the owner decided. Any other final lifecycle uses a try.
 */
const ENDS_TRIES: ReadonlySet<string> = new Set([
  "promoted",
  "awaiting_approval",
  "audit_blocked",
  "declined",
]);

/** An experiment's tries as an agent reads them (goal 214), when it gets more than one. */
interface TriesBrief {
  /** How many trials it gets. */
  of: number;
  /** Its try now (in progress or done) or next (up next), from 1. */
  try: number;
  /** The lanes that tried it, in the order they did. */
  lanes: string[];
  earlier: { n: number; lane: string | null; result: string; verdict?: string; cause?: string }[];
}

/** An experiment's text, as every writer gives it (the same limits as the owner's commands). */
export const ExperimentInput = z.object({
  title: ExperimentText.title,
  details: ExperimentText.details.optional(),
  direction: ExperimentText.direction.optional(),
  why: ExperimentText.why.optional(),
});
export type ExperimentInput = z.infer<typeof ExperimentInput>;

export { directionOf };

/** Whether an experiment's direction is the direction a rule names (exactly, or as its id). */
export function inDirection(x: Pick<Experiment, "direction">, direction: string): boolean {
  return (
    x.direction !== "" && (x.direction === direction || directionOf(x.direction) === direction)
  );
}

/** Where a position puts an experiment among `others` queued ones: an index, as control does. */
function indexOf(pos: QueuePosition | undefined, others: number): number {
  if (pos === "top") return 0;
  if (typeof pos === "number") return Math.max(0, Math.min(others, Math.trunc(pos)));
  return others;
}

/**
 * What a research task's trial added (goal 117), kept with the task when its trial ends: the
 * verified claims it recorded, by question, with how many brought a registrable domain new to
 * their question; the registrable domains new to the run; its supported findings; and its
 * changes to answer cards (none yet: cards come later in goal 117).
 */
export interface TaskYield {
  verified_claims: number;
  by_question: { question: number; verified_claims: number; new_domain_claims: number }[];
  new_domains: number;
  /** The first of the new registrable domains (at most 20). */
  domains: string[];
  findings: number;
  card_changes: number;
}

/** An experiment as an agent reads it in the queue's brief. */
export interface BriefExperiment {
  id: string;
  title: string;
  details?: string;
  direction?: string;
  why?: string;
  /** A research task's question, as an index from 0 (goal 117). */
  question?: number;
  by: string;
  /**
   * Up next: its trials that ended without really trying it (the provider failed, the harness
   * restarted, the run was paused), how many and the last one's cause (goal 079).
   */
  returned?: { times: number; cause: string };
  /** Its tries, when it gets more than one (goal 214). */
  tries?: TriesBrief;
}

export interface QueueBrief {
  up_next: BriefExperiment[];
  proposed: BriefExperiment[];
  in_progress: (BriefExperiment & { lane: string })[];
  tried: (BriefExperiment & {
    lane?: string;
    result: string;
    /** How its trial ended, in words (goal 079): not only "error". */
    cause?: string;
    attempt?: string;
    verdict?: string;
    delta?: number;
    lifecycle?: string;
    /** What a research task's trial added (goal 117). */
    yield?: TaskYield;
  })[];
}

/** A task's yield as the ledger keeps it, read back; undefined when it has none. */
export function yieldOf(x: Pick<Experiment, "yield">): TaskYield | undefined {
  if (!x.yield) return undefined;
  try {
    return JSON.parse(x.yield) as TaskYield;
  } catch {
    // Only the harness writes a yield, as JSON (finish); a row that holds anything else has none.
    return undefined;
  }
}

type Row = Omit<ExperimentRow, "created_at" | "updated_at">;
const strip = ({ created_at: _c, updated_at: _u, ...r }: ExperimentRow): Row => r;

export class ExperimentQueue {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  // ------------------------------------------------------------------ reads

  get(id: string): Experiment | undefined {
    return this.ledger.experiments.get(id);
  }

  /** Every experiment of the run, oldest first. */
  all(run: string): Experiment[] {
    return this.ledger.experiments.list(run);
  }

  /** Up next, in order. */
  queued(run: string): Experiment[] {
    return this.all(run)
      .filter((x) => x.state === "queued")
      .sort((a, b) => (a.place ?? 0) - (b.place ?? 0));
  }

  /**
   * Up next and ready for a lane's next trial (goal 081): queued, not handed out to a lane this
   * round (`given`), and in no direction an AVOID rule in force names. The planner's round and
   * the teachers' brief count the queue against its target with this one count.
   */
  ready(
    run: string,
    rules: readonly { body: { kind: string; direction?: string | undefined } }[],
    given: ReadonlySet<string> = new Set(),
  ): Experiment[] {
    const avoid = rules.flatMap((r) =>
      r.body.kind === "avoid" && r.body.direction ? [r.body.direction] : [],
    );
    return this.queued(run).filter(
      (x) => !given.has(x.id) && !avoid.some((f) => inDirection(x, f)),
    );
  }

  /** The lanes' ideas waiting for the planner or the owner, oldest first. */
  proposed(run: string): Experiment[] {
    return this.all(run).filter((x) => x.state === "proposed");
  }

  /** Experiments a lane's trial works on now. */
  assigned(run: string): Experiment[] {
    return this.all(run).filter((x) => x.state === "assigned");
  }

  /** Experiments that ended (done or dropped), newest first. */
  tried(run: string, limit = 20): Experiment[] {
    return this.all(run)
      .filter((x) => x.state === "done" || x.state === "dropped")
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * The run's directions (goal 066), by name: the direction of each of its experiments, in any
   * state; each direction in its direction registry; each direction an attempt was tagged with; and, in
   * a research run, the task kinds. A rule may name only these. Sorted by name.
   */
  directions(run: string): string[] {
    const names = new Set<string>();
    for (const x of this.all(run)) {
      const d = x.direction ? directionOf(x.direction) : undefined;
      if (d) names.add(d);
    }
    const directions = this.ledger.trials.directions(run).map((f) => f.id);
    for (const name of [...directions, ...this.ledger.attempts.directions(run)])
      if (DIRECTION_NAME.test(name)) names.add(name);
    if (this.ledger.runs.get(run)?.mode === "research")
      for (const k of RESEARCH_TASK_KINDS) names.add(k);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** The experiment a trial works (or worked) on, if it had one. */
  forTrial(trial: string): Experiment | undefined {
    const id = this.ledger.experiments.ofTrial(trial)?.id;
    return id ? this.get(id) : undefined;
  }

  /** An experiment's tries that ended without a win (goal 214), the first first. */
  earlier(id: string): ExperimentTry[] {
    return this.ledger.experiments.triesOf(id);
  }

  /**
   * Whether a lane may take an experiment (goal 214): not one it tried already while a lane of the
   * run's `lanes` has not tried it yet. Every lane may take one that gets one try.
   */
  takes(x: Pick<Experiment, "id" | "tries">, lane: string, lanes: readonly string[]): boolean {
    if ((x.tries ?? 1) <= 1) return true;
    const tried = new Set(this.earlier(x.id).flatMap((t) => (t.lane ? [t.lane] : [])));
    return !tried.has(lane) || lanes.every((l) => tried.has(l));
  }

  /** An experiment's tries in its brief (goal 214); undefined for one that gets one try. */
  triesBrief(x: Experiment, clip: (s: string, n: number) => string): TriesBrief | undefined {
    const of = x.tries ?? 1;
    if (of <= 1) return undefined;
    const earlier = this.earlier(x.id);
    return {
      of,
      try: earlier.length + 1,
      lanes: earlier.flatMap((t) => (t.lane ? [t.lane] : [])),
      earlier: earlier.map((t) => ({
        n: t.n,
        lane: t.lane,
        result: t.result,
        ...(t.verdict ? { verdict: t.verdict } : {}),
        ...(t.cause ? { cause: clip(t.cause, 400) } : {}),
      })),
    };
  }

  /**
   * The queue as an agent reads it (the planner, the teachers): up next in order, the
   * lanes' ideas, what each lane is on, and the newest tried with their results (the judge's
   * verdict and change for an attempt). Long texts are shortened.
   */
  brief(run: string, o: { upNext?: number; proposed?: number; tried?: number } = {}): QueueBrief {
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const text = (x: Experiment) => ({
      id: x.id,
      title: x.title,
      ...(x.details ? { details: clip(x.details, 600) } : {}),
      ...(x.direction ? { direction: x.direction } : {}),
      ...(x.why ? { why: clip(x.why, 400) } : {}),
      ...(typeof x.question === "number" ? { question: x.question } : {}),
      by: x.added_by,
      ...((x.tries ?? 1) > 1 ? { tries: this.triesBrief(x, clip) } : {}),
    });
    const judged = (attempt: string) => {
      const v = this.ledger.verdicts.current(attempt);
      if (!v) return { lifecycle: String(this.ledger.attempts.get(attempt)?.lifecycle ?? "") };
      const delta = this.ledger.verdicts.get(v.id)?.delta;
      return { verdict: v.verdict, ...(typeof delta === "number" ? { delta } : {}) };
    };
    return {
      up_next: this.queued(run)
        .slice(0, o.upNext ?? 40)
        .map((x) => ({
          ...text(x),
          ...(x.returns ? { returned: { times: x.returns, cause: clip(x.cause ?? "", 300) } } : {}),
        })),
      proposed: this.proposed(run)
        .slice(-(o.proposed ?? 20))
        .map(text),
      in_progress: this.assigned(run).map((x) => ({ ...text(x), lane: x.lane ?? "" })),
      tried: this.tried(run, o.tried ?? 20).map((x) => ({
        ...text(x),
        ...(x.lane ? { lane: x.lane } : {}),
        result:
          x.state === "dropped"
            ? `dropped by ${x.dropped_by ?? "?"}: ${clip(x.dropped_why ?? "", 300)}`
            : (x.result ?? ""),
        ...(x.state === "done" && x.cause ? { cause: clip(x.cause, 300) } : {}),
        ...(x.attempt ? { attempt: x.attempt, ...judged(x.attempt) } : {}),
        ...(yieldOf(x) ? { yield: yieldOf(x) } : {}),
      })),
    };
  }

  /** An experiment of this run, or a refusal in words. */
  require(run: string, id: string): Experiment {
    const x = this.get(id);
    if (!x || x.run !== run)
      throw new LedgerError("not_found", `no experiment ${id} in run ${run}`);
    return x;
  }

  // ------------------------------------------------------------------ writes

  /**
   * The rows for a new order of the queued experiments: `x` placed at `pos` among the others
   * (or taken out, with `pos` undefined and `leave`), and every other queued one whose place
   * changed.
   */
  private reorder(run: string, x: Row, how: { place: QueuePosition | undefined } | "leave"): Row[] {
    const others = this.queued(run).filter((q) => q.id !== x.id);
    const order: Row[] = others.map(strip);
    if (how !== "leave") order.splice(indexOf(how.place, others.length), 0, x);
    const rows: Row[] = [];
    order.forEach((r, i) => {
      if (r === x) {
        x.place = i;
        return;
      }
      if (r.place !== i) rows.push({ ...r, place: i });
    });
    if (how === "leave") x.place = null;
    return [x, ...rows];
  }

  /**
   * The question a new experiment names (goal 117). In a research run: the one it was given,
   * checked against the run's questions and refused in words when the run has no such question;
   * else the index its title's "Question N (index K)" names, when the run has it (a copy from
   * another run names none: its numbers were that run's). In another run: none, and one given is
   * refused.
   */
  private questionFor(
    run: string,
    given: number | null | undefined,
    title: string,
    copied: boolean,
  ): number | null {
    const inst = this.ledger.runs.get(run);
    const contract = inst ? this.ledger.contracts.get(inst.campaign, inst.version) : undefined;
    if (contract?.mode !== "research") {
      if (given !== undefined && given !== null)
        throw new LedgerError("invalid", "only a research run's tasks name a question");
      return null;
    }
    const n = contract.questions.length;
    const has = (q: number) => Number.isInteger(q) && q >= 0 && q < n;
    if (given !== undefined && given !== null) {
      if (!has(given))
        throw new LedgerError(
          "invalid",
          `no question ${given}: a task's "question" is the index of one of the campaign's ${n} questions, from 0 to ${n - 1}`,
        );
      return given;
    }
    const labelled = copied ? undefined : labelledQuestion(title);
    return labelled !== undefined && has(labelled) ? labelled : null;
  }

  /**
   * How many trials an experiment gets (goal 214): 1 when not given. A research run's tasks get
   * one each: a task's trial ends with what it found, never a win to try again for.
   */
  private triesFor(run: string, given: number | undefined): number {
    if (given === undefined || given === 1) return 1;
    if (!Number.isInteger(given) || given < 1 || given > 10)
      throw new LedgerError("invalid", "tries is a whole number from 1 to 10");
    if (this.ledger.runs.get(run)?.mode === "research")
      throw new LedgerError("invalid", "a research run's task gets one try: leave out tries");
    return given;
  }

  /** The owner's, the planner's, an advisor's or a lane's new experiment. */
  add(
    run: string,
    input: ExperimentInput & {
      by: string;
      state?: "queued" | "proposed" | undefined;
      position?: QueuePosition | undefined;
      from?: { run: string; id: string } | undefined;
      /** A lane's idea: the trial it came from (in the event, for the record). */
      trial?: string | undefined;
      /**
       * Back in the queue because its trial was interrupted or failed: the experiment it repeats
       * and that trial (in the event as `requeued_from`, so History says why it came back).
       */
      requeued?:
        | {
            experiment: string;
            trial: string;
            lane: string | null;
            result: "interrupted" | "error";
          }
        | undefined;
      /**
       * A research task's question, an index from 0 (goal 117). Left out, a title labelled
       * "Question N (index K)" names it; other runs' experiments name none.
       */
      question?: number | null | undefined;
      /** How many trials it gets (goal 214); 1 when left out. */
      tries?: number | undefined;
    },
    actor: string,
  ): Experiment {
    const text = ExperimentInput.parse(input);
    const state = input.state ?? "queued";
    const question = this.questionFor(run, input.question, text.title, input.from !== undefined);
    const tries = this.triesFor(run, input.tries);
    const x: Row = {
      id: newExperimentId(),
      run,
      title: text.title,
      details: text.details ?? "",
      direction: text.direction ?? "",
      why: text.why ?? "",
      added_by: input.by,
      state,
      place: null,
      lane: null,
      trial: null,
      attempt: null,
      result: null,
      dropped_by: null,
      dropped_why: null,
      from_run: input.from?.run ?? null,
      from_id: input.from?.id ?? null,
      question,
      yield: null,
      tries,
    };
    const rows = state === "queued" ? this.reorder(run, x, { place: input.position }) : [x];
    this.ledger.experiments.write(rows, {
      actor,
      kind: "experiment_added",
      run,
      body: {
        id: x.id,
        title: x.title,
        ...(x.details ? { details: x.details } : {}),
        ...(x.direction ? { direction: x.direction } : {}),
        ...(x.why ? { why: x.why } : {}),
        ...(question !== null ? { question } : {}),
        ...(tries > 1 ? { tries } : {}),
        by: input.by,
        state,
        ...(state === "queued" && input.position !== undefined ? { position: input.position } : {}),
        ...(input.from ? { from_run: input.from.run, from_id: input.from.id } : {}),
        ...(input.trial ? { trial: input.trial } : {}),
        ...(input.requeued ? { requeued_from: input.requeued } : {}),
      },
    });
    return this.require(run, x.id);
  }

  /** A lane's proposed idea goes into up next (by default at the end). */
  accept(
    run: string,
    id: string,
    o: { by: string; position?: QueuePosition | undefined; why?: string | undefined },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "proposed")
      throw new LedgerError("invalid", `experiment ${id} is ${x.state}, not a proposed idea`);
    const row: Row = { ...strip(x), state: "queued" };
    this.ledger.experiments.write(this.reorder(run, row, { place: o.position }), {
      actor,
      kind: "experiment_accepted",
      run,
      body: {
        id,
        by: o.by,
        ...(o.position !== undefined ? { position: o.position } : {}),
        ...(o.why ? { why: o.why } : {}),
      },
    });
    return this.require(run, id);
  }

  /** A queued experiment moves to another place in up next. */
  move(
    run: string,
    id: string,
    o: { by: string; position: QueuePosition; why?: string | undefined },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "queued")
      throw new LedgerError(
        "invalid",
        `experiment ${id} is ${x.state}: only queued experiments move`,
      );
    this.ledger.experiments.write(this.reorder(run, strip(x), { place: o.position }), {
      actor,
      kind: "experiment_moved",
      run,
      body: { id, by: o.by, position: o.position, ...(o.why ? { why: o.why } : {}) },
    });
    return this.require(run, id);
  }

  /** New words, or a new number of tries (goal 214), for an experiment still waiting. */
  edit(
    run: string,
    id: string,
    change: Partial<ExperimentInput> & { tries?: number | undefined },
    o: { by: string },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "proposed" && x.state !== "queued")
      throw new LedgerError(
        "invalid",
        `experiment ${id} is ${x.state}: only proposed or queued experiments can be edited`,
      );
    const c = ExperimentInput.partial().parse(change);
    const tries = change.tries === undefined ? undefined : this.triesFor(run, change.tries);
    const used = tries === undefined ? 0 : this.earlier(id).length;
    if (tries !== undefined && tries <= used)
      throw new LedgerError(
        "invalid",
        `experiment ${id} was tried ${used} time${used === 1 ? "" : "s"} already: give it more than ${used} tries`,
      );
    const row: Row = {
      ...strip(x),
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.details !== undefined ? { details: c.details } : {}),
      ...(c.direction !== undefined ? { direction: c.direction } : {}),
      ...(c.why !== undefined ? { why: c.why } : {}),
      ...(tries !== undefined ? { tries } : {}),
    };
    this.ledger.experiments.write([row], {
      actor,
      kind: "experiment_edited",
      run,
      body: {
        id,
        by: o.by,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.details !== undefined ? { details: c.details } : {}),
        ...(c.direction !== undefined ? { direction: c.direction } : {}),
        ...(c.why !== undefined ? { why: c.why } : {}),
        ...(tries !== undefined ? { tries } : {}),
      },
    });
    return this.require(run, id);
  }

  /** A proposed or queued experiment is dropped, with why. It stays in the log. */
  drop(run: string, id: string, o: { by: string; why: string }, actor: string): Experiment {
    const x = this.require(run, id);
    if (x.state !== "proposed" && x.state !== "queued")
      throw new LedgerError(
        "invalid",
        `experiment ${id} is ${x.state}: only proposed or queued experiments can be dropped`,
      );
    const why = o.why.trim().slice(0, 2000);
    if (!why) throw new LedgerError("invalid", "say why the experiment is dropped");
    const row: Row = { ...strip(x), state: "dropped", dropped_by: o.by, dropped_why: why };
    this.ledger.experiments.write(this.reorder(run, row, "leave"), {
      actor,
      kind: "experiment_dropped",
      run,
      body: { id, by: o.by, why },
    });
    return this.require(run, id);
  }

  /**
   * A lane's trial starts on a queued (or proposed) experiment. One experiment goes to one
   * trial: an experiment already assigned, done or dropped is refused.
   */
  assign(
    run: string,
    id: string,
    o: { lane: string; trial: string; by: string; why?: string | undefined },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "queued" && x.state !== "proposed")
      throw new LedgerError("conflict", `experiment ${id} is ${x.state}: it can't be given out`);
    const row: Row = { ...strip(x), state: "assigned", lane: o.lane, trial: o.trial };
    this.ledger.experiments.write(this.reorder(run, row, "leave"), {
      actor,
      kind: "experiment_assigned",
      run,
      body: {
        id,
        lane: o.lane,
        trial: o.trial,
        by: o.by,
        ...(o.why ? { why: o.why.slice(0, 2000) } : {}),
      },
    });
    return this.require(run, id);
  }

  /**
   * A trial ended: its experiment is done, with its attempt or why there is none ("submitted",
   * "no_attempt", or the trial's stopped reason). With no attempt and tries left (goal 214), it
   * goes back to the top for its next try instead. Nothing happens for a trial with no experiment.
   */
  finish(
    trial: string,
    o: {
      result: string;
      attempt?: string | null | undefined;
      /** How its trial ended, in words (goal 079). */
      cause?: string | undefined;
      /** What a research task's trial added (goal 117). */
      yield?: TaskYield | undefined;
    },
    actor: string,
  ): Experiment | undefined {
    const x = this.forTrial(trial);
    if (x?.state !== "assigned") return undefined;
    const cause = o.cause?.trim().slice(0, 2000) || null;
    if (!o.attempt && this.triesLeft(x) > 0)
      return this.retry(
        x,
        { lane: x.lane, trial, attempt: null, result: o.result, verdict: null, cause },
        actor,
      );
    const row: Row = {
      ...strip(x),
      state: "done",
      result: o.result,
      attempt: o.attempt ?? null,
      cause,
      ...(o.yield ? { yield: JSON.stringify(o.yield) } : {}),
    };
    this.ledger.experiments.write([row], {
      actor,
      kind: "experiment_finished",
      run: x.run,
      body: {
        id: x.id,
        lane: x.lane,
        trial,
        ...(o.attempt ? { attempt: o.attempt } : {}),
        result: o.result,
        ...(cause ? { cause: cause.slice(0, 500) } : {}),
        ...(o.yield ? { yield: o.yield } : {}),
      },
    });
    return this.require(x.run, x.id);
  }

  /** How many more tries an experiment gets after the one it is on or just ended (goal 214). */
  private triesLeft(x: Experiment): number {
    return (x.tries ?? 1) - this.earlier(x.id).length - 1;
  }

  /**
   * A try ended without a win and tries are left (goal 214): the same experiment goes back to the
   * top of the queue, with the try kept (lane, trial, attempt, result, verdict and cause) and one
   * event, `experiment_retried`.
   */
  private retry(x: Experiment, t: Omit<ExperimentTry, "n" | "at">, actor: string): Experiment {
    const n = this.earlier(x.id).length + 1;
    const row: Row = {
      ...strip(x),
      state: "queued",
      lane: null,
      trial: null,
      attempt: null,
      result: null,
      cause: null,
    };
    this.ledger.experiments.write(
      this.reorder(x.run, row, { place: "top" }),
      {
        actor,
        kind: "experiment_retried",
        run: x.run,
        body: {
          id: x.id,
          try: n,
          tries: x.tries ?? 1,
          lane: t.lane,
          trial: t.trial,
          ...(t.attempt ? { attempt: t.attempt } : {}),
          result: t.result,
          ...(t.verdict ? { verdict: t.verdict } : {}),
          ...(t.cause ? { cause: t.cause.slice(0, 500) } : {}),
          position: "top",
        },
      },
      { ...t, n },
    );
    return this.require(x.run, x.id);
  }

  /**
   * The run's experiments whose attempt the judge settled without a win, with tries left (goal
   * 214), go back to the top of the queue, the oldest last so it ends up first. An attempt still
   * being judged, a win, a win that waits for the owner and one the owner decided stay as they
   * are. Returns those that went back.
   */
  retrySettled(run: string, actor: string): Experiment[] {
    const out: Experiment[] = [];
    for (const x of this.ledger.experiments.doneWithTriesLeft(run).reverse()) {
      const attempt = x.attempt as string;
      const lifecycle = String(this.ledger.attempts.get(attempt)?.lifecycle ?? "");
      if (!FINAL_LIFECYCLES.has(lifecycle) || ENDS_TRIES.has(lifecycle)) continue;
      const v = this.ledger.verdicts.current(attempt);
      if (v && WON_VERDICTS.includes(v.verdict)) continue;
      const reasons = v ? this.ledger.verdicts.get(v.id)?.reasons : undefined;
      out.push(
        this.retry(
          x,
          {
            lane: x.lane,
            trial: x.trial ?? "",
            attempt,
            result: x.result ?? "submitted",
            verdict: v?.verdict ?? lifecycle,
            cause: reasons?.trim().slice(0, 2000) || x.cause || null,
          },
          actor,
        ),
      );
    }
    return out;
  }

  /**
   * A trial ended without really trying its experiment (goal 079): the provider failed (a rate
   * limit, a 5xx, no credits, a refused key), the harness restarted, or the run was paused or
   * reset. The same experiment goes back to the top of the queue, not a copy, with how many times
   * that happened and why. While the agents are stopped it waits there; it is the next one given
   * out when they go on.
   */
  returnToQueue(
    trial: string,
    o: { result: string; cause: string },
    actor: string,
  ): Experiment | undefined {
    const x = this.forTrial(trial);
    if (x?.state !== "assigned") return undefined;
    const cause = o.cause.trim().slice(0, 2000) || o.result;
    const returns = (x.returns ?? 0) + 1;
    const row: Row = {
      ...strip(x),
      state: "queued",
      lane: null,
      trial: null,
      attempt: null,
      result: null,
      cause,
      returns,
    };
    this.ledger.experiments.write(this.reorder(x.run, row, { place: "top" }), {
      actor,
      kind: "experiment_returned",
      run: x.run,
      body: {
        id: x.id,
        lane: x.lane,
        trial,
        result: o.result,
        cause: cause.slice(0, 500),
        returns,
        position: "top",
      },
    });
    return this.require(x.run, x.id);
  }
}

import { type Contract, type LaneLimitValues, laneLimits, MAX_LANES } from "../../core/contract.ts";
import type { StoredRule } from "../../core/directives.ts";
import { ideaWords, ruleRefusal } from "../../core/queue-target.ts";
import { JUDGED_LIFECYCLES } from "../../core/verdicts.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";
import {
  directionOf,
  type Experiment,
  type ExperimentQueue,
  inFamily,
  type TaskYield,
} from "../queue.ts";
import type { NewFamily, QueuePlan } from "./planner/index.ts";
import type { Assignment, Registry } from "./registry.ts";

/**
 * The coordinator's side of the experiment queue (goal 064): how lanes get work. The planner
 * gives out queued work each round; the code here applies its answer, and when there is no
 * model answer it gives out work itself by fixed rules. Either way, every change is recorded
 * as the planner's (`planner`), and each hand-out is one `planner_handout` event.
 *
 * The fixed rules: lanes take queued experiments in order, skipping those an AVOID rule names by
 * family, MANDATE families first and TRY families next. Among the next experiments in order
 * (as many as the run has lanes), a lane prefers one in its last direction, so it builds on what
 * it learned. An experiment goes to one lane only.
 */

/** Who gives out work and changes the queue for the coordinator, in the record. */
export const PLANNER = "planner";

/**
 * A rule in force. One in words (legacy, goal 066) has no family: code never keeps it, until the
 * planner's round converts it to a rule on a named direction.
 */
export type Directive = { id: number; body: StoredRule };

/** A lane's work for its next trial: the experiment and why the lane got it. */
export interface Handout {
  lane: string;
  experiment: string;
  why: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * An experiment's result from how its trial ended: "submitted" (with the attempt), "no_attempt"
 * (the worker stopped without submitting), or the trial's stopped reason (interrupted, error,
 * wall, turns, context; a research trial's finished).
 */
/** The provider's error kinds after which a trial never really tried its experiment (goal 079). */
const PROVIDER_KINDS = new Set(["rate_limit", "server", "credits", "auth", "route"]);

export function resultOf(stopped: string, attempt?: string | null | undefined): string {
  if (attempt) return "submitted";
  return stopped === "no_submission" || stopped === "submitted" ? "no_attempt" : stopped;
}

/** What a trial works on, as its focus: the experiment's title and details. */
export function focusOf(x: Pick<Experiment, "title" | "details">): string {
  return x.details ? `${x.title}\n${x.details}` : x.title;
}

/**
 * The rules for the plan in force. The owner's (issued through control) come first: a supervisor
 * directive about a family the owner has a directive for, or a supervisor lane count when the
 * owner set one, does not apply.
 */
export function rulesInForce(ledger: Ledger, run: string): { id: number; body: StoredRule }[] {
  // An old rule in words (legacy, goal 066) stays in force for the planner's model until its
  // round converts it; it has no family, so the code below and the fixed rules never keep it.
  // An advisor's rule that freezes the queue's size or pins an experiment, set before code
  // refused them (goal 081), never reaches the plan.
  const all = ledger.directives
    .active(run)
    .filter((d) => !d.author.startsWith("supervisor") || !ruleRefusal(d.body as StoredRule))
    .map((d) => ({
      id: d.id,
      owner: d.author.startsWith("control:"),
      body: d.body as StoredRule,
    }));
  const ownerFamilies = new Set(
    all.filter((d) => d.owner && d.body.family).map((d) => d.body.family),
  );
  const ownerLanes = all.some((d) => d.owner && d.body.kind === "lane_count");
  return all
    .filter(
      (d) =>
        d.owner ||
        ((!d.body.family || !ownerFamilies.has(d.body.family)) &&
          !(d.body.kind === "lane_count" && ownerLanes)),
    )
    .map((d) => ({ id: d.id, body: d.body }));
}

/**
 * How many lanes work now (goal 162): the contract's count, at most MAX_LANES (a contract stored
 * before the cap may ask for more, and lanes past it have no user to run as), or the lane count
 * of the rules in force, the owner's first. The scheduler starts this many, and a message to
 * everyone waits for the reads of this many.
 */
export function lanesAtWork(ledger: Ledger, run: string, contract: Contract): number {
  const cap = Math.min(contract.lanes.count, MAX_LANES);
  const ruled = rulesInForce(ledger, run)
    .map((d) => d.body)
    .filter((b) => b.kind === "lane_count" && Number.isFinite(Number(b.value)))
    .at(-1);
  return Math.max(1, Math.min(cap, Math.trunc(Number(ruled?.value ?? cap))));
}

/** Whether the judge is done with an attempt (none: nothing to wait for). */
export function attemptSettled(ledger: Ledger, attempt: string | null): boolean {
  return !attempt || JUDGED_LIFECYCLES.has(String(ledger.attempts.get(attempt)?.lifecycle));
}

/**
 * Whether the run's lanes keep working while the judge works (goal 135): the newest keep_working
 * rule in force, else the contract's lanes.keep_working, else not (they wait for its verdicts).
 */
export function keepsWorking(ledger: Ledger, run: string, contract: Contract): boolean {
  const rule = rulesInForce(ledger, run)
    .filter((d) => d.body.kind === "keep_working")
    .at(-1);
  return rule ? rule.body.value === "on" : contract.lanes.keep_working === true;
}

/** The run's lane limits: the contract's, with the trial length a trial_minutes rule sets. */
export function limitsInForce(ledger: Ledger, run: string, contract: Contract): LaneLimitValues {
  const rule = rulesInForce(ledger, run)
    .filter((d) => d.body.kind === "trial_minutes" && typeof d.body.value === "number")
    .at(-1);
  const limits = laneLimits(contract);
  return rule ? { ...limits, trialMinutes: Number(rule.body.value) } : limits;
}

/** The experiments the run's newest hand-out gave its lanes. */
export function handedOut(ledger: Ledger, run: string): Set<string> {
  const b = ledger.events.newest("planner_handout", { subject: run })?.body;
  return new Set(
    (b?.assignments ?? []).flatMap((a) => (typeof a.experiment === "string" ? [a.experiment] : [])),
  );
}

export class Coordinator {
  private readonly ledger: Ledger;
  private readonly queue: ExperimentQueue;
  private readonly registry: Registry;

  constructor(o: { ledger: Ledger; queue: ExperimentQueue; registry: Registry }) {
    this.ledger = o.ledger;
    this.queue = o.queue;
    this.registry = o.registry;
  }

  /** What each lane worked on last: the direction and title of its newest experiment. */
  laneState(
    run: string,
    lanes: string[],
  ): Record<string, { direction: string | null; experiment: string | null }> {
    const out: Record<string, { direction: string | null; experiment: string | null }> = {};
    for (const lane of lanes) {
      const x = this.ledger.experiments.lastOfLane(run, lane);
      const t = x ? undefined : this.ledger.trials.lastOfLane(run, lane);
      out[lane] = {
        direction: x ? x.family || null : (t?.family ?? null),
        experiment: x?.title ?? null,
      };
    }
    return out;
  }

  /**
   * The next experiment for a lane by the fixed rules, or none when nothing queued may go to
   * it. `exclude`: experiments already given to other lanes in this hand-out or this round.
   */
  pick(
    run: string,
    lane: string,
    o: { directives: Directive[]; window: number; exclude: Set<string> },
  ): Experiment | undefined {
    const fam = (k: string) =>
      o.directives
        .filter((d) => d.body.kind === k && d.body.family)
        .map((d) => String(d.body.family));
    const avoid = fam("avoid");
    const mandate = fam("mandate");
    const tried = fam("try");
    const rank = (x: Experiment) =>
      mandate.some((f) => inFamily(x, f)) ? 0 : tried.some((f) => inFamily(x, f)) ? 1 : 2;
    const candidates = this.queue
      .queued(run)
      .filter((x) => !o.exclude.has(x.id) && !avoid.some((f) => inFamily(x, f)))
      .map((x, i) => ({ x, i, r: rank(x) }))
      .sort((a, b) => a.r - b.r || a.i - b.i);
    const first = candidates[0];
    if (!first) return undefined;
    const last = this.laneState(run, [lane])[lane]?.direction;
    const same =
      last &&
      candidates
        .slice(0, Math.max(1, o.window))
        .find((c) => c.r === first.r && sameDirection(c.x.family, last));
    return (same || first).x;
  }

  /** Why a lane got an experiment by the fixed rules, in words. */
  whyPicked(run: string, lane: string, x: Experiment, directives: Directive[]): string {
    const ruled = directives.find(
      (d) =>
        (d.body.kind === "mandate" || d.body.kind === "try") &&
        d.body.family &&
        inFamily(x, d.body.family),
    );
    if (ruled)
      return `a ${ruled.body.kind.toUpperCase()} rule (${ruled.id}) names its direction, ${ruled.body.family}`;
    const last = this.laneState(run, [lane])[lane]?.direction;
    if (last && sameDirection(x.family, last))
      return `next in the queue in ${lane}'s last direction (${x.family}), so it builds on what it learned`;
    return "next in the queue";
  }

  /**
   * A MANDATE family with nothing queued or in progress gets one experiment, at the top, so the
   * fixed rules can keep it: a lane always works in every MANDATE direction.
   */
  ensureMandates(run: string, directives: Directive[]): void {
    const waiting = [...this.queue.queued(run), ...this.queue.assigned(run)];
    for (const d of directives) {
      const f = d.body.family;
      if (d.body.kind !== "mandate" || !f || waiting.some((x) => inFamily(x, f))) continue;
      waiting.push(
        this.queue.add(
          run,
          {
            title: `Work on the "${f}" direction`,
            family: f,
            why: `a MANDATE rule (${d.id}) asks for the "${f}" direction, and nothing queued was in it`,
            by: PLANNER,
            position: "top",
          },
          PLANNER,
        ),
      );
    }
  }

  /**
   * The fixed plan fills an empty queue: an experiment in the direction it gives a lane, added
   * by the planner. `a` is the fixed plan's (or the round's) assignment for the lane.
   */
  fill(run: string, a: Pick<Assignment, "family" | "focus">, why: string): Experiment {
    return this.queue.add(
      run,
      {
        title: clip(a.focus.split("\n")[0] ?? a.focus, 200),
        ...(a.focus.length > 200 || a.focus.includes("\n") ? { details: clip(a.focus, 4000) } : {}),
        family: a.family,
        why,
        by: PLANNER,
      },
      PLANNER,
    );
  }

  /**
   * Tops the queue up from the lanes' ideas (goal 081): the oldest distinct ones go up next, as
   * the planner's, until `need` are accepted. An idea is distinct when its words repeat no other
   * experiment of the run (queued, in progress, tried or dropped) and no idea taken before it; an
   * idea in a direction an AVOID rule names stays where it is. The rest wait, as before, for the
   * planner's model or the owner.
   */
  acceptIdeas(run: string, need: number, avoided: (x: Experiment) => boolean, why: string) {
    const out: Experiment[] = [];
    if (need <= 0) return out;
    const seen = new Set(
      this.queue
        .all(run)
        .filter((x) => x.state !== "proposed")
        .map((x) => ideaWords(x.title)),
    );
    for (const x of this.queue.proposed(run)) {
      if (out.length >= need) break;
      const words = ideaWords(x.title);
      if (!words || seen.has(words) || avoided(x)) continue;
      seen.add(words);
      out.push(this.queue.accept(run, x.id, { by: PLANNER, why }, PLANNER));
    }
    return out;
  }

  /**
   * Applies a model's checked answer: accepted ideas and drops, new experiments (their refs
   * become ids), moves, the rules from the owner's messages, and the old rules in words it
   * converted to named directions. A change the queue or the rules no longer allow (the owner
   * moved first, or removed the old rule while the planner planned) is skipped and said. Returns
   * each lane's hand-out (a lane whose experiment can no longer be given out gets none, and takes
   * one by the fixed rules), and the ids the added experiments got, by their refs.
   */
  apply(
    run: string,
    plan: QueuePlan,
  ): {
    handout: (Handout & { parent: "champion" | "lane_best" })[];
    skipped: string[];
    refs: Map<string, string>;
  } {
    const skipped: string[] = [];
    const tryIt = (what: string, f: () => void) => {
      try {
        f();
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        skipped.push(`${what}: ${err.message}`);
      }
    };
    for (const a of plan.accept)
      tryIt(`accept ${a.id}`, () =>
        this.queue.accept(run, a.id, { by: PLANNER, position: a.position, why: a.why }, PLANNER),
      );
    for (const d of plan.drop)
      tryIt(`drop ${d.id}`, () => this.queue.drop(run, d.id, { by: PLANNER, why: d.why }, PLANNER));
    const refs = new Map<string, string>();
    for (const a of plan.add) {
      const x = this.queue.add(
        run,
        {
          title: a.title,
          details: a.details,
          family: a.family,
          why: a.why,
          by: PLANNER,
          position: a.position,
          ...(a.question !== undefined ? { question: a.question } : {}),
        },
        PLANNER,
      );
      refs.set(a.ref, x.id);
    }
    for (const m of plan.move)
      tryIt(`move ${m.id}`, () =>
        this.queue.move(run, m.id, { by: PLANNER, position: m.position, why: m.why }, PLANNER),
      );
    if (plan.rules.length)
      this.ledger.directives.addSet(
        run,
        PLANNER,
        plan.rules.map((r) => ({
          kind: r.kind,
          family: r.family,
          rationale: r.rationale,
          citations: [],
          from_message: r.from_message,
        })),
        false,
      );
    // Each old rule in words becomes a rule on the direction the model named (goal 066).
    for (const c of plan.convert)
      tryIt(`convert rule ${c.rule}`, () => {
        this.ledger.directives.convertRule(run, c.rule, c.family, PLANNER);
      });
    const handout: (Handout & { parent: "champion" | "lane_best" })[] = [];
    for (const h of plan.handout) {
      const id = refs.get(h.experiment) ?? h.experiment;
      const x = this.queue.get(id);
      if (!x || x.run !== run || (x.state !== "queued" && x.state !== "proposed")) {
        skipped.push(`${h.lane}: ${id} can no longer be given out (${x?.state ?? "unknown"})`);
        continue;
      }
      if (handout.some((o) => o.experiment === id)) {
        skipped.push(`${h.lane}: ${id} is another lane's already`);
        continue;
      }
      handout.push({ lane: h.lane, experiment: id, parent: h.parent, why: h.why });
    }
    return { handout, skipped, refs };
  }

  /** The direction-registry family for an experiment's direction (registered if new). */
  direction(run: string, x: Experiment, families: NewFamily[] = []): string {
    const id = directionOf(x.family) ?? "general";
    const described = families.find((f) => f.id === id)?.description;
    this.registry.addFamily(
      run,
      id,
      described ??
        (id === "general"
          ? "Any correct change that improves the primary metric"
          : x.family && x.family !== id
            ? x.family
            : `the "${id}" direction (first: ${clip(x.title, 200)})`),
      PLANNER,
    );
    return id;
  }

  /** One hand-out, in the planner's log. */
  handout(run: string, round: number, assignments: Handout[], notes: string): void {
    this.ledger.appendEvent(PLANNER, "planner_handout", run, {
      round,
      assignments: assignments.map((a) => ({
        lane: a.lane,
        experiment: a.experiment,
        why: clip(a.why, 2000),
      })),
      notes: clip(notes, 2000),
    });
  }

  /**
   * A trial ended: its experiment is done, with its attempt or why there is none, and how its
   * trial ended in words (its cause). One whose trial never really tried it goes back to the top
   * of the queue, the same row with its cause (goal 079): a trial interrupted (a reset, a pause, a
   * restart), or one that ended on the provider's error (a rate limit, a 5xx, no credits, a
   * refused key or an unserved model, or calls that failed until the run's agents stopped). Any
   * other failure is a tried experiment, with its cause.
   */
  finish(
    trial: string,
    r: {
      result: string;
      attempt?: string | null | undefined;
      cause?: string | undefined;
      /** The provider's error's kind, when the trial ended on one. */
      kind?: string | undefined;
      /** The trial ended because its model calls failed until the run's agents stopped. */
      agentsStopped?: boolean | undefined;
      /** What a research task's trial added (goal 117), kept when the task is done. */
      yield?: TaskYield | undefined;
    },
    actor: string,
  ): void {
    const never =
      !r.attempt &&
      (r.result === "interrupted" ||
        (r.result === "error" &&
          (r.agentsStopped === true || (r.kind !== undefined && PROVIDER_KINDS.has(r.kind)))));
    if (never) {
      this.queue.returnToQueue(
        trial,
        {
          result: r.result,
          cause:
            r.cause ??
            (r.result === "interrupted" ? "its trial was interrupted" : "the provider failed"),
        },
        actor,
      );
      return;
    }
    this.queue.finish(
      trial,
      { result: r.result, attempt: r.attempt, cause: r.cause, yield: r.yield },
      actor,
    );
  }

  /**
   * After a restart: experiments whose trial a dead controller left open are finished with how
   * their trial ended (interrupted), and go back to the queue.
   */
  finishOrphans(actor: string): void {
    const rows = this.ledger.experiments.orphans();
    for (const r of rows)
      this.finish(
        r.trial,
        {
          result: resultOf(r.stopped ?? "interrupted", r.attempt),
          attempt: r.attempt,
          cause: r.error ?? "the harness restarted while its trial ran",
        },
        actor,
      );
  }
}

/** Whether an experiment's direction is a lane's last one (the same words, or the same family). */
function sameDirection(family: string, last: string): boolean {
  if (!family) return false;
  return family === last || (directionOf(family) ?? family) === (directionOf(last) ?? last);
}

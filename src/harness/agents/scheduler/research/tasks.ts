import type { ResearchContract } from "../../../../core/contract.ts";
import { questionLabel } from "../../../../core/research-check.ts";
import type { Experiment } from "../../../queue.ts";
import {
  gapOf,
  hypothesisTask,
  nextGap,
  nextQuestion,
  type QuestionState,
  type Research,
  type ResearchState,
  researchState,
  taskDetails,
  took,
} from "../../../research/index.ts";
import { type Directive, PLANNER } from "../../coordinator.ts";
import type { Assignment, EpochRecord } from "../../registry.ts";
import { directivesOf, laneCountOf, type SchedulerContext } from "../context.ts";
import { heldHandouts } from "../rounds.ts";

/**
 * A research run's tasks, its experiments (goals 047 and 117): each about one question and one
 * evidence gap, given out by the gap-driven rules when the planner gives a lane none.
 */

export const RESEARCH_TASKS: { id: string; description: string }[] = [
  { id: "explore", description: "Find and read new relevant sources; record verified claims" },
  {
    id: "primary",
    description: "Trace existing claims to primary sources (papers, specifications, data)",
  },
  {
    id: "contradict",
    description: "Look for sources that disagree with recorded claims; record both sides",
  },
  { id: "consolidate", description: "Fold verified claims and notes into the report sections" },
];

/** The questions a TRY or MANDATE rule with a question's index puts first. */
function firstQuestions(directives: Directive[], contract: ResearchContract): number[] {
  return directives
    .filter(
      (d) =>
        (d.body.kind === "mandate" || d.body.kind === "try") &&
        typeof d.body.value === "number" &&
        Number.isInteger(d.body.value) &&
        d.body.value >= 0 &&
        d.body.value < contract.questions.length,
    )
    .map((d) => Number(d.body.value));
}

/**
 * A lane's next research task by the gap-driven rules (goal 117). First the owner's queued tasks,
 * in queue order, as before (AVOID task kinds skipped, MANDATE and TRY kinds first), any other
 * that names no question, else one for a hypothesis with no evidence (hypothesisTask). Then the
 * question the gaps weigh for (nextQuestion: the floor, then the weighted shares under the
 * ceiling; never a question decided or saturated, unless every open one is): the first task
 * queued for it, whoever added it (a teacher's, a lane's idea once queued, the plan's), else a
 * new task of the gap-driven plan for it. Each task given counts in `state`.
 */
export function nextResearchTask(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
  n: number,
  lane: string,
  state: ResearchState,
  exclude: ReadonlySet<string>,
  directives: Directive[],
): { x: Experiment; why: string; stalled: boolean } | undefined {
  const queued = sched.o.service.queue.queued(run);
  const only = (keep: (x: Experiment) => boolean) =>
    sched.coordinator.pick(run, lane, {
      directives,
      window: 1,
      exclude: new Set([...exclude, ...queued.filter((x) => !keep(x)).map((x) => x.id)]),
    });
  const unbalanced = only((x) => x.added_by === "owner" || typeof x.question !== "number");
  const queue = sched.o.service.queue;
  const lead = unbalanced ?? hypothesisTask(sched.ledger, queue, run, contract.questions, PLANNER);
  if (lead) {
    if (typeof lead.question === "number") took(state, lead.question);
    const why = unbalanced ? sched.coordinator.whyPicked(run, lane, lead, directives) : lead.why;
    return { x: lead, why, stalled: false };
  }
  const next = nextQuestion(state, firstQuestions(directives, contract));
  if (!next) return undefined;
  const q = next.question.index;
  const waiting = only((x) => x.question === q);
  if (waiting) {
    took(state, q);
    return {
      x: waiting,
      why: `the gap-driven plan: ${next.why}; this task was queued for it`,
      stalled: false,
    };
  }
  const added = fillResearch(
    sched,
    run,
    contract,
    n,
    next.question,
    `the gap-driven plan: ${next.why}`,
    directives,
  );
  took(state, q);
  return { x: added.x, why: added.x.why, stalled: added.stalled };
}

/**
 * The task a lane's research trial takes (goal 117): the round's own for its first trial, while
 * it can still be given out; otherwise the next by the gap-driven rules (one hand-out of its
 * own). Tasks other lanes were given this round, and have not started yet, are left to them.
 */
export function researchTaskFor(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
  epoch: EpochRecord,
  a: Assignment,
  k: number,
): { x: Experiment; why: string } | undefined {
  const queue = sched.o.service.queue;
  const mine = k === 1 && a.experiment ? queue.get(a.experiment) : undefined;
  if (mine && mine.run === run && (mine.state === "queued" || mine.state === "proposed"))
    return { x: mine, why: a.why ?? "the round's hand-out" };
  // A busy lane's hand-out stays its own, but its question is not taken by it (goal 136).
  const { held, counted } = heldHandouts(sched.registry, run, epoch, a.lane, sched.running);
  const state = researchState(sched.ledger, run, contract, {
    lanes: laneCountOf(sched, run, contract),
    epoch: epoch.n,
    reserved: counted,
  });
  const got = nextResearchTask(
    sched,
    run,
    contract,
    epoch.n,
    a.lane,
    state,
    new Set(held),
    directivesOf(sched, run),
  );
  if (!got) return undefined;
  sched.coordinator.handout(
    run,
    epoch.n,
    [{ lane: a.lane, experiment: got.x.id, why: got.why }],
    k === 1
      ? `${a.lane}'s first trial of round ${epoch.n}: the task the round gave it can no longer be given out`
      : `${a.lane}'s trial ${k} of ${contract.lanes.trials_per_epoch} in round ${epoch.n}`,
  );
  return { x: got.x, why: got.why };
}

/**
 * Whether a research run's novelty fell: past its first hour, an hour with no new source and no
 * newly verified claim. Then the plan's tasks go deeper instead of wider.
 */
function noveltyFell(sched: SchedulerContext, run: string): boolean {
  const research = sched.o.research as Research;
  if (research.clock(run).elapsed_ms <= 3_600_000) return false;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  return (
    sched.ledger.sources.countSince(run, hourAgo) === 0 &&
    sched.ledger.claims.countVerifiedSince(run, hourAgo) === 0
  );
}

/**
 * A new task of the gap-driven plan for one question (goal 117): its title names the question,
 * its details the gap it closes (nextGap: the first of its card's open evidence gaps that no task
 * waiting for it names), and its task kind comes in turn. When novelty fell, primary sources and
 * contradictions come first. Directives steer it by structure only: MANDATE and TRY name task
 * kinds to put first, AVOID removes a task kind. Directive text never reaches a worker's brief.
 */
function fillResearch(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
  n: number,
  q: QuestionState,
  why: string,
  directives: Directive[] = directivesOf(sched, run),
): { x: Experiment; stalled: boolean } {
  const question = q.index;
  const avoid = new Set(
    directives.filter((d) => d.body.kind === "avoid" && d.body.family).map((d) => d.body.family),
  );
  const rank = (id: string) =>
    directives.some((d) => d.body.kind === "mandate" && d.body.family === id)
      ? 0
      : directives.some((d) => d.body.kind === "try" && d.body.family === id)
        ? 1
        : 2;
  const stalled = noveltyFell(sched, run);
  const deep = (id: string) => Number(!["primary", "contradict"].includes(id));
  const all = RESEARCH_TASKS;
  const rotated = stalled
    ? [...all].sort((x, y) => deep(x.id) - deep(y.id))
    : all.map((_, k) => all[(n + k - 1) % all.length] as { id: string; description: string });
  const kinds = rotated
    .filter((t) => !avoid.has(t.id))
    .map((t, k) => ({ t, k }))
    .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.k - b.k)
    .map((x) => x.t);
  if (!kinds.length) kinds.push(rotated[0] as { id: string; description: string });
  const queue = sched.o.service.queue;
  const waiting = [...queue.queued(run), ...queue.assigned(run)];
  // Task kinds go on in turn after the plan's own waiting tasks.
  const own = waiting.filter((x) => x.added_by === PLANNER).length;
  const kind = kinds[own % kinds.length] as { id: string; description: string };
  const gap = nextGap(
    q,
    waiting.filter((x) => x.question === question).flatMap((x) => gapOf(x.details) ?? []),
  );
  const x = queue.add(
    run,
    {
      title: `${questionLabel(question)}: ${kind.description}`,
      details: taskDetails(question, contract.questions[question] ?? "", gap),
      family: kind.id,
      question,
      why: (stalled
        ? `${why}; novelty fell, so primary sources and contradictions first`
        : why
      ).slice(0, 2000),
      by: PLANNER,
    },
    PLANNER,
  );
  return { x, stalled };
}

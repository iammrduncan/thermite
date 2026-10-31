import type { Certainty } from "../../core/api/harness/research.ts";
import { EXPERIMENT_DETAILS } from "../../core/commands.ts";
import type { ResearchContract } from "../../core/contract.ts";
import { GAP_LINE, questionLabel, SATURATION_TASKS } from "../../core/research-check.ts";
import type { Ledger } from "../ledger/index.ts";
import type { TaskYield } from "../queue.ts";
import { cardsOf, rubricOf } from "./cards.ts";
import { questionEnded, questionSaturated, standingDecisions } from "./progress.ts";

/**
 * Where each question of a research run stands for the plan (goal 117): its answer card's
 * certainty and open evidence gaps, the review panel's standing decision, whether it is saturated,
 * its share of the run's recent tasks and what its last tasks added. The gap-driven plan below
 * (the plan when there is no planner model, and the model planner's fallback) and the model
 * planner's research context both read it; nothing here writes.
 *
 * The gap-driven plan gives each question a weight from its card: the openness of its certainty
 * (none 4, low 3, moderate 2, high or insufficient 1) plus its open evidence gaps; a question with
 * no card yet weighs as much as the most open one (at least 5). A question that is decided (a
 * standing decision of answered or insufficient) or saturated gets none, unless every question
 * still open is saturated (then the saturated ones are weighed again, so lanes keep reading while
 * the progress rule runs), or every question is decided (then all are). Each round, a question
 * with open evidence gaps (or no card) and no task in the round gets one first: the floor. Then
 * tasks go by weight, each to the question furthest below its weighted share of the round's tasks.
 * A question that holds half of the run's last 2 × lanes tasks (the window) gets no more while
 * another weighed question has open evidence gaps: the ceiling.
 */

/** A question with no card yet: the gap its task closes. */
export const NO_CARD_GAP =
  "No answer card yet: find and archive sources that answer the question directly, and record verified claims from them";
/** A card that names no open evidence gap: the gap its task closes. */
export const NO_GAP_NAMED =
  "The card names no open evidence gap: find independent sources that confirm or contradict its main points, from sites its claims do not cite yet";

/** How open each certainty leaves a question: the more open, the more tasks it weighs for. */
const OPENNESS: Record<Certainty, number> = {
  none: 4,
  low: 3,
  moderate: 2,
  high: 1,
  insufficient: 1,
};
/** The least weight of a question with no card: it weighs as the most open question. */
const NO_CARD_WEIGHT = 5;

export interface QuestionState {
  index: number;
  /** "Question 1 (index 0)". */
  label: string;
  text: string;
  rubric: string;
  verified_claims: number;
  /** Its answer card (the newest version), or null: none yet. */
  card: {
    version: number;
    certainty: Certainty;
    answer: string;
    evidence_gaps: string[];
    measurement_gaps: number;
  } | null;
  /** The review panel's standing decision on it, or null: none stands. */
  decision: { decision: string; certainty: string | null; review: number } | null;
  /** A standing decision of answered or insufficient: the question has an end. */
  decided: boolean;
  /** Its last SATURATION_TASKS tasks added nothing new and changed no card. */
  saturated: boolean;
  /** Its tasks among the run's last `window` research tasks given out (to a lane's trial). */
  share: number;
  /** Its tasks in this round: given to a trial of the round, or reserved for one. */
  round: number;
  /** All its tasks, ever (queued, in progress or done). */
  tasks: number;
  /** What its last SATURATION_TASKS finished tasks added. */
  yield: { tasks: number; verified_claims: number; new_domain_claims: number };
  /** Open evidence gaps, or no card yet: a source could still add to it. */
  gapped: boolean;
  /** Its weight in the gap-driven plan: 0, it gets no task. */
  weight: number;
}

export interface ResearchState {
  questions: QuestionState[];
  /** The window the shares and the ceiling count: the run's last 2 × lanes tasks given out. */
  window: number;
  /** The questions of the run's last `window` research tasks given out, the newest first. */
  recent: number[];
  /** Every question that is not decided is saturated (and at least one is not decided). */
  allSaturated: boolean;
  /** Every question is decided. */
  allDecided: boolean;
}

/** A research task's question and gap, as the plan gives them, with why in words. */
export interface PlannedTask {
  question: number;
  gap: string;
  why: string;
}

/** The weight of a question's card, before decisions and saturation. */
function cardWeight(card: QuestionState["card"]): number {
  return card ? OPENNESS[card.certainty] + card.evidence_gaps.length : 0;
}

/**
 * Where a research run's questions stand (see above). `lanes`: the run's lanes, for the window;
 * `epoch`: the round, whose trials' tasks count in `round`; `reserved`: the tasks the round's
 * hand-out gave lanes that have not started on them yet, which count as given out.
 */
export function researchState(
  ledger: Ledger,
  run: string,
  contract: Pick<ResearchContract, "questions" | "rubrics">,
  o: { lanes: number; epoch?: number | undefined; reserved?: readonly string[] | undefined },
): ResearchState {
  const window = Math.max(2, 2 * o.lanes);
  const n = contract.questions.length;
  const cards = new Map(cardsOf(ledger, run).map((c) => [c.question, c]));
  const counts = ledger.claims.verifiedByQuestion(run);
  const standing = standingDecisions(ledger, run);
  const has = (q: unknown): q is number =>
    typeof q === "number" && Number.isInteger(q) && q >= 0 && q < n;
  // The tasks given out: those handed to a lane for its next trial and not started yet (the
  // round's reserved ones), then those a trial took, the newest first.
  const reserved = (o.reserved ?? []).flatMap((id) => {
    const x = ledger.experiments.get(id);
    return x?.run === run && x.state === "queued" && has(x.question) ? [x.question] : [];
  });
  const taken = ledger.experiments.takenQuestions(run, window).filter(has);
  const recent = [...reserved, ...taken].slice(0, window);
  const total = ledger.experiments.questionCounts(run);
  // The round's tasks: given to a trial of the round, or reserved for one.
  const round = new Map<number, number>();
  for (const q of reserved) round.set(q, (round.get(q) ?? 0) + 1);
  if (o.epoch !== undefined)
    for (const [q, c] of ledger.experiments.questionCounts(run, o.epoch))
      round.set(q, (round.get(q) ?? 0) + c);
  const questions: QuestionState[] = contract.questions.map((text, index) => {
    const c = cards.get(index);
    const card = c
      ? {
          version: c.version,
          certainty: c.certainty,
          answer: c.answer,
          evidence_gaps: c.gaps.filter((g) => g.kind === "evidence").map((g) => g.text),
          measurement_gaps: c.gaps.filter((g) => g.kind === "measurement").length,
        }
      : null;
    const d = standing.get(`question:${index}`);
    const decided = questionEnded(d);
    return {
      index,
      label: questionLabel(index),
      text,
      rubric: rubricOf(contract, index),
      verified_claims: counts.get(index) ?? 0,
      card,
      decision: d ? { decision: d.decision, certainty: d.certainty, review: d.review } : null,
      decided,
      saturated: !decided && questionSaturated(ledger, run, index),
      share: recent.filter((q) => q === index).length,
      round: round.get(index) ?? 0,
      tasks: total.get(index) ?? 0,
      yield: lastYield(ledger, run, index),
      gapped: card === null || card.evidence_gaps.length > 0,
      weight: 0,
    };
  });
  const undecided = questions.filter((q) => !q.decided);
  const allDecided = undecided.length === 0;
  const allSaturated = !allDecided && undecided.every((q) => q.saturated);
  // Who is weighed: the open questions; when all are saturated, the saturated ones; when all are
  // decided, every question.
  const weighed = (q: QuestionState) =>
    allDecided ? true : allSaturated ? !q.decided : !q.decided && !q.saturated;
  const most = Math.max(NO_CARD_WEIGHT, ...questions.map((q) => cardWeight(q.card)));
  for (const q of questions) q.weight = weighed(q) ? (q.card ? cardWeight(q.card) : most) : 0;
  return { questions, window, recent, allSaturated, allDecided };
}

/** What a question's last SATURATION_TASKS finished tasks added. */
function lastYield(ledger: Ledger, run: string, question: number): QuestionState["yield"] {
  const rows = ledger.experiments.yields(run, question, SATURATION_TASKS);
  const out = { tasks: rows.length, verified_claims: 0, new_domain_claims: 0 };
  for (const r of rows) {
    let y: TaskYield | undefined;
    try {
      y = JSON.parse(r.yield) as TaskYield;
    } catch {
      continue;
    }
    for (const b of y.by_question ?? [])
      if (b.question === question) {
        out.verified_claims += b.verified_claims;
        out.new_domain_claims += b.new_domain_claims;
      }
  }
  return out;
}

/** The ceiling: the most of the window's tasks one question holds while another has gaps. */
export function ceilingOf(state: Pick<ResearchState, "window">): number {
  return Math.max(1, Math.floor(state.window / 2));
}

/**
 * Whether a question may get a task now: it is weighed, and it is under the ceiling, or no other
 * weighed question has open evidence gaps.
 */
export function mayTake(state: ResearchState, q: QuestionState): boolean {
  if (q.weight <= 0) return false;
  if (q.share < ceilingOf(state)) return true;
  return !state.questions.some((o) => o.index !== q.index && o.weight > 0 && o.gapped);
}

/**
 * The floor: the weighed questions with open evidence gaps (or no card) that have no task in this
 * round and may take one, the heaviest first. `first`: questions a rule puts first.
 */
export function floorOf(state: ResearchState, first: number[] = []): QuestionState[] {
  return state.questions
    .filter((q) => q.gapped && q.round === 0 && mayTake(state, q))
    .sort(
      (a, b) =>
        Number(!first.includes(a.index)) - Number(!first.includes(b.index)) ||
        b.weight - a.weight ||
        a.share - b.share ||
        a.index - b.index,
    );
}

/** Records a task given to a question in the state: its share, its round and its tasks. */
export function took(state: ResearchState, question: number): void {
  const q = state.questions[question];
  if (!q) return;
  state.recent.unshift(question);
  const dropped = state.recent.length > state.window ? state.recent.pop() : undefined;
  q.share++;
  q.round++;
  q.tasks++;
  if (dropped !== undefined) {
    const d = state.questions[dropped];
    if (d) d.share = Math.max(0, d.share - 1);
  }
}

/**
 * The question the next task goes to, by the floor, then the weighted shares under the ceiling.
 * `first`: questions a rule (a TRY or MANDATE with a question's index) puts first. Undefined only
 * when no question is weighed, which researchState never leaves.
 */
export function nextQuestion(
  state: ResearchState,
  first: number[] = [],
): { question: QuestionState; why: string } | undefined {
  const floor = floorOf(state, first)[0];
  if (floor)
    return {
      question: floor,
      why: `${floor.label} has ${floor.card ? `${floor.card.evidence_gaps.length} open evidence gap${floor.card.evidence_gaps.length === 1 ? "" : "s"} at certainty ${floor.card.certainty}` : "no answer card yet"}, and no task in this round`,
    };
  const weighed = state.questions.filter((q) => q.weight > 0);
  const open = weighed.filter((q) => mayTake(state, q));
  const pool = open.length ? open : weighed;
  if (!pool.length) return undefined;
  // Each question's share of the round by its weight, against the round's tasks so far: the next
  // task goes to the one furthest below it (the largest remainder).
  const sum = pool.reduce((a, q) => a + q.weight, 0);
  const given = pool.reduce((a, q) => a + q.round, 0);
  const deficit = (q: QuestionState) => (q.weight / sum) * (given + 1) - q.round;
  const best = [...pool].sort(
    (a, b) =>
      Number(!first.includes(a.index)) - Number(!first.includes(b.index)) ||
      deficit(b) - deficit(a) ||
      b.weight - a.weight ||
      a.index - b.index,
  )[0] as QuestionState;
  return {
    question: best,
    why: `${best.label} is furthest below its share of the round by its gaps (weight ${best.weight} of ${sum}; ${best.round} of the round's ${given} tasks so far)`,
  };
}

/**
 * The gap a question's next task closes: the first of its card's open evidence gaps that no task
 * waiting for it names (`taken`), else the next in turn; with no card, NO_CARD_GAP; with a card
 * that names none, NO_GAP_NAMED.
 */
export function nextGap(q: QuestionState, taken: readonly string[]): string {
  if (!q.card) return NO_CARD_GAP;
  const gaps = q.card.evidence_gaps;
  if (!gaps.length) return NO_GAP_NAMED;
  const free = gaps.find((g) => !taken.includes(g));
  if (free !== undefined) return free;
  return gaps[q.tasks % gaps.length] as string;
}

/** The gap a task's details name (its GAP_LINE), if they name one. */
export function gapOf(details: string): string | undefined {
  const line = details.split("\n").find((l) => l.startsWith(GAP_LINE));
  return line ? line.slice(GAP_LINE.length).trim() : undefined;
}

/**
 * The gap-driven plan's next `count` tasks: each a question (by nextQuestion) and the gap it
 * closes (by nextGap), with why. `taken(question)`: the gaps the tasks waiting for a question
 * name. The state is updated as tasks are planned.
 */
export function gapPlan(
  state: ResearchState,
  count: number,
  o: { taken: (question: number) => string[]; first?: number[] | undefined },
): PlannedTask[] {
  const out: PlannedTask[] = [];
  for (let k = 0; k < count; k++) {
    const next = nextQuestion(state, o.first);
    if (!next) break;
    const q = next.question;
    const gap = nextGap(q, [
      ...o.taken(q.index),
      ...out.filter((t) => t.question === q.index).map((t) => t.gap),
    ]);
    out.push({ question: q.index, gap, why: `the gap-driven plan: ${next.why}` });
    took(state, q.index);
  }
  return out;
}

/**
 * Where each question stands, in short, for the teachers' brief (goal 117): its card's certainty
 * and how many open evidence gaps it names, whether the review panel decided it (and how),
 * whether it is saturated, the weight the gap-driven plan gives it, and its share of the last
 * tasks given out. The teachers propose for the questions still open.
 */
export function stateBrief(state: ResearchState) {
  return {
    window: state.window,
    all_saturated: state.allSaturated,
    all_decided: state.allDecided,
    questions: state.questions.map((q) => ({
      index: q.index,
      label: q.label,
      certainty: q.card?.certainty ?? null,
      evidence_gaps: q.card?.evidence_gaps.length ?? null,
      decided: q.decided,
      ...(q.decision ? { decision: q.decision.decision } : {}),
      saturated: q.saturated,
      weight: q.weight,
      share: q.share,
    })),
  };
}

/** A question's state in a few words, for a round's notes: its certainty, gaps and share. */
export function stateWords(q: QuestionState): string {
  const card = q.card
    ? `certainty ${q.card.certainty}, ${q.card.evidence_gaps.length} evidence gap${q.card.evidence_gaps.length === 1 ? "" : "s"}`
    : "no card";
  const end = q.decided ? `, decided ${q.decision?.decision}` : q.saturated ? ", saturated" : "";
  return `${q.label}: ${card}${end}`;
}

/**
 * A research task's details: its question. A question has no length limit (goal 078); an
 * experiment's details hold at most EXPERIMENT_DETAILS characters (`max`), so a longer one is cut
 * there and says where the whole question is: in the trial brief's Questions.
 */
export function questionDetails(i: number, q: string, max = EXPERIMENT_DETAILS): string {
  const whole = `${questionLabel(i)}: ${q}`;
  if (whole.length <= max) return whole;
  const note = ` … (cut: the whole question is under Questions in your brief)`;
  return `${whole.slice(0, max - note.length)}${note}`;
}

/**
 * A research task's details (goal 117): the evidence gap it closes, on its first line
 * (GAP_LINE), then its question, cut as questionDetails cuts it. `more`: what else the task says,
 * such as the kind of source to read and the planner's details, between the two.
 */
export function taskDetails(i: number, q: string, gap: string, more: string[] = []): string {
  const head = [`${GAP_LINE}${gap.replace(/\s+/g, " ").trim()}`, ...more].join("\n");
  const room = EXPERIMENT_DETAILS - head.length - 1;
  return room > 200 ? `${head}\n${questionDetails(i, q, room)}` : head.slice(0, EXPERIMENT_DETAILS);
}

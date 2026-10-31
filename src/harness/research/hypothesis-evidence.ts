import { EXPERIMENT_DETAILS } from "../../core/commands.ts";
import {
  GAP_LINE,
  questionLabel,
  REQUIRED_HYPOTHESES,
  SATURATION_TASKS,
} from "../../core/research-check.ts";
import type { Ledger } from "../ledger/index.ts";
import type { Experiment, ExperimentQueue } from "../queue.ts";
import { type StandingDecision, standingDecisions } from "./progress.ts";
import { gapOf, taskDetails } from "./shares.ts";

/**
 * Evidence for or against a research run's required hypotheses (goal 117): the author's and the
 * promoted ones, which need a verdict. A hypothesis has evidence when verified claims support it
 * (its own supporting claims) or a reviewer cited claims for its verdict. The review panel's
 * `undecided` on one with no evidence is no end: nothing looked for it. The plan then gives it a
 * task to find some, as a question's gap gets one, until SATURATION_TASKS of its tasks are done;
 * each one done shows the panel the hypothesis again (itemsMarker).
 */

/** A required hypothesis with no evidence for or against it yet. */
export interface UnevidencedHypothesis {
  id: string;
  text: string;
  question: number | null;
}

const list = (v: unknown): string[] => {
  try {
    const x = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};

/** How many claims stand behind each required hypothesis, by id: its own and those reviewers cited. */
export function hypothesisEvidence(ledger: Ledger, run: string): Map<string, number> {
  const claims = new Map<string, Set<string>>();
  const add = (id: string, ids: string[]) => {
    const s = claims.get(id) ?? new Set<string>();
    for (const c of ids) s.add(c);
    claims.set(id, s);
  };
  for (const h of ledger.hypotheses.withStatus(run, REQUIRED_HYPOTHESES))
    add(h.id, list(h.supporting));
  // A reviewer's verdict that passed the check, with the claims it cites.
  for (const r of ledger.reviews.hypothesisCitations(run))
    if (claims.has(r.key)) add(r.key, list(r.claims));
  return new Map([...claims].map(([id, s]) => [id, s.size]));
}

/**
 * Whether a required hypothesis has an end: the panel's supported or refuted, or its undecided
 * when claims stand behind it (`evidence`). An undecided with no evidence is no end.
 */
export function hypothesisEnded(d: StandingDecision | undefined, evidence: number): boolean {
  return d !== undefined && (d.decision !== "undecided" || evidence > 0);
}

/** The required hypotheses the panel left undecided with no evidence, the oldest first. */
export function unevidencedHypotheses(
  ledger: Ledger,
  run: string,
  standing: Map<string, StandingDecision>,
): UnevidencedHypothesis[] {
  const evidence = hypothesisEvidence(ledger, run);
  return ledger.hypotheses
    .withStatus(run, REQUIRED_HYPOTHESES)
    .filter((h) => {
      const d = standing.get(`hypothesis:${h.id}`);
      return d?.decision === "undecided" && (evidence.get(h.id) ?? 0) === 0;
    })
    .map((h) => ({ id: h.id, text: h.text, question: h.question }));
}

/** The gap a hypothesis's task closes: its line in the task's details names the hypothesis. */
export function hypothesisGap(h: UnevidencedHypothesis): string {
  return `Hypothesis ${h.id} needs a verdict and no claim supports or contradicts it yet: find sources that confirm or refute it, and record verified claims from them, each under the question it bears on. The hypothesis: ${h.text}`;
}

/** How many of the plan's tasks for hypotheses are done: each shows the panel them again. */
export function hypothesisTasksDone(ledger: Ledger, run: string): number {
  return ledger.experiments.list(run).filter((x) => x.state === "done" && forAnyHypothesis(x))
    .length;
}

/** Whether a task closes a hypothesis's gap; this one's, given its id. */
const forAnyHypothesis = (x: Pick<Experiment, "details">) =>
  gapOf(x.details)?.startsWith("Hypothesis ") === true;
const forHypothesis = (x: Pick<Experiment, "details">, id: string) =>
  gapOf(x.details)?.startsWith(`Hypothesis ${id} `) === true;

/**
 * A new task of the plan for the first required hypothesis with no evidence (goal 117) that has
 * no task waiting or running, and fewer than SATURATION_TASKS done: its question's when it has
 * one, else none. Undefined when no hypothesis needs one.
 */
export function hypothesisTask(
  ledger: Ledger,
  queue: ExperimentQueue,
  run: string,
  questions: string[],
  by: string,
): Experiment | undefined {
  const tasks = queue.all(run).filter(forAnyHypothesis);
  const h = unevidencedHypotheses(ledger, run, standingDecisions(ledger, run)).find((h) => {
    const mine = tasks.filter((x) => forHypothesis(x, h.id));
    return (
      !mine.some((x) => x.state === "queued" || x.state === "assigned") &&
      mine.filter((x) => x.state === "done").length < SATURATION_TASKS
    );
  });
  if (!h) return undefined;
  const q = h.question !== null && h.question < questions.length ? h.question : null;
  const gap = hypothesisGap(h);
  return queue.add(
    run,
    {
      title: `${q === null ? "" : `${questionLabel(q)}: `}Find evidence for or against hypothesis ${h.id}`,
      details:
        q === null
          ? `${GAP_LINE}${gap}`.slice(0, EXPERIMENT_DETAILS)
          : taskDetails(q, questions[q] ?? "", gap),
      family: "primary",
      question: q,
      why: `the review panel gives hypothesis ${h.id} a verdict, and no claim for or against it stands yet`,
      by,
    },
    by,
  );
}

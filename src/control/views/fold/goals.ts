import {
  type GoalChecks,
  type GoalCellValues as GoalValues,
  parseGoalValues as goalValuesOf,
  parseGoalChecks,
} from "../../../core/goal/index.ts";
import { RESEARCH_REVIEW } from "../../../core/research-check.ts";
import { newReviewFigures, panelFigures } from "../research.ts";
import type { Handler, Handlers } from "./index.ts";

/**
 * Goals: how the rig's kit checks them, the judge's reports on them, and the reviews of a
 * subjective goal (a research run's reviews have the goal `research`, goal 112).
 */

export type { GoalChecks, GoalValues };

/** The review panel's result on a review, or the owner's decision on it. */
const reviewed: Handler = (f, e, b) => {
  const r = f.run(String(e.subject)).reviews.find((x) => x.review === Number(b.review));
  if (r && e.kind === "review_panel") {
    r.panel = String(b.result);
    panelFigures(r, e.at, b);
    // A research review's gaps (goal 112): the reviewers' words, kept short.
    if (Array.isArray(b.gaps))
      r.gaps = b.gaps.filter((g): g is string => typeof g === "string").map((g) => g.slice(0, 300));
    if (r.goal === RESEARCH_REVIEW && Array.isArray(b.questions))
      r.answers = (b.questions as Record<string, unknown>[]).flatMap((q) =>
        q && typeof q.answer === "string" && Number.isInteger(q.question)
          ? [{ question: Number(q.question), answer: q.answer.slice(0, 500) }]
          : [],
      );
  }
  if (r && e.kind === "review_decided") {
    r.owner = String(b.decision);
    r.owner_at = e.at;
    r.owner_note = typeof b.note === "string" && b.note ? b.note : null;
  }
};

export const GOALS: Handlers = {
  goal_checks(f, e, b) {
    f.run(String(e.subject)).goal_checks = parseGoalChecks(b);
  },
  goal_report(f, e, b) {
    const v = f.run(String(e.subject));
    v.goals = (
      (b.goals as { goal: string; description?: string; status: string; reasons: string }[]) ?? []
    ).map((g) => ({
      goal: g.goal,
      description: typeof g.description === "string" ? g.description : null,
      status: g.status,
      reasons: g.reasons,
      values: goalValuesOf((g as { values?: unknown }).values),
    }));
    v.goals_at = e.at;
    v.goals_seq = typeof b.champion_seq === "number" ? b.champion_seq : null;
    // Every required goal met, and the second check still to come (goal 086).
    v.goals_confirming = b.complete === true && b.confirming === true;
    // Met for good: complete, and not the first check that a second one must confirm.
    v.goals_complete = b.complete === true && b.confirming !== true;
  },
  review_requested(f, e, b) {
    f.run(String(e.subject)).reviews.push({
      review: Number(b.review),
      goal: String(b.goal),
      commit: String(b.commit),
      panel: null,
      owner: null,
      gaps: null,
      answers: null,
      ...newReviewFigures(e.at, b),
    });
  },
  review_panel: reviewed,
  review_decided: reviewed,
};

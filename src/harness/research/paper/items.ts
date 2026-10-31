import { standingDecisions } from "../progress.ts";
import {
  type CheckedHypothesis,
  type CheckedQuestion,
  type CheckedReviewer,
  checkedPanel,
  type Dissent,
  requiredHypotheses,
} from "../review/index.ts";
import type { PaperItems } from "./appended.ts";
import type { PapersContext } from "./context.ts";

/**
 * Where each item of a run stands, for its paper (goal 117): each question's standing decision,
 * the checked answers behind it and its dissent; the same for each required hypothesis.
 */
export function paperItems(ctx: PapersContext, run: string): PaperItems {
  const standing = standingDecisions(ctx.ledger, run);
  const panels = new Map<number, CheckedReviewer[]>();
  const panelOf = (review: number) => {
    if (!panels.has(review)) {
      const row = ctx.ledger.reviews.get(review);
      panels.set(review, row ? checkedPanel(row) : []);
    }
    return panels.get(review) ?? [];
  };
  const dissentOf = (kind: string, key: string, review: number): Dissent[] => {
    const row = ctx.ledger.reviews.decision(run, kind, key, review);
    try {
      return row ? (JSON.parse(row.dissent) as Dissent[]) : [];
    } catch {
      return [];
    }
  };
  return {
    questions: ctx.contract(run).questions.map((text, index) => {
      const d = standing.get(`question:${index}`);
      return {
        index,
        text,
        decision: d,
        answers: d
          ? panelOf(d.review)
              .map((r) => r.questions.find((q) => q.index === index))
              .filter((q): q is CheckedQuestion => q?.valid === true && q.verdict === d.decision)
          : [],
        dissent: d ? dissentOf("question", String(index), d.review) : [],
      };
    }),
    hypotheses: requiredHypotheses(ctx.ledger, run).map((h) => {
      const d = standing.get(`hypothesis:${h.id}`);
      return {
        ...h,
        decision: d,
        given: d
          ? panelOf(d.review)
              .map((r) => r.hypotheses.find((x) => x.id === h.id))
              .filter((x): x is CheckedHypothesis => x?.valid === true && x.verdict === d.decision)
          : [],
        dissent: d ? dissentOf("hypothesis", h.id, d.review) : [],
      };
    }),
  };
}

/** The hypotheses the run proposed that need no verdict (status pool), the oldest first. */
export function proposedHypotheses(
  ctx: PapersContext,
  run: string,
): { id: string; text: string; question: number | null }[] {
  return ctx.ledger.hypotheses
    .withStatus(run, ["pool"])
    .map((h) => ({ id: h.id, text: h.text, question: h.question }));
}

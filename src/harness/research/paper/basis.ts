import { type Ledger, LedgerError } from "../../ledger/index.ts";
import { cardsOf } from "../cards.ts";
import type { PaperBasis } from "./check.ts";
import type { PapersContext } from "./context.ts";
import { paperItems, proposedHypotheses } from "./items.ts";
import { accepted, requested } from "./request.ts";

/** Whether an id is a verified claim of the run. */
const verifiedClaim = (ledger: Ledger, run: string, id: string) =>
  ledger.claims.get(run, id)?.verified === true;

/** What a run's paper is checked against; it must wait for its paper. */
export function paperBasis(ctx: PapersContext, run: string): PaperBasis {
  const inst = ctx.ledger.runs.get(run);
  if (!inst) throw new LedgerError("not_found", `no run ${run}`);
  if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
  if (accepted(ctx, run))
    throw new LedgerError("conflict", `run ${run} already has its research paper`);
  const asked = requested(ctx, run);
  if (!asked) throw new LedgerError("invalid", `run ${run} does not wait for a research paper`);
  const questions = ctx.contract(run).questions;
  const items = paperItems(ctx, run);
  const verdicts = new Map<string, Set<string>>();
  for (const h of items.hypotheses)
    if (h.decision) verdicts.set(h.id, new Set([h.decision.decision]));
  const counts = ctx.ledger.claims.verifiedByQuestion(run);
  const cards = new Map(cardsOf(ctx.ledger, run).map((c) => [c.question, c]));
  const ofQuestion = new Map<number, string[]>();
  for (const c of ctx.ledger.claims.verifiedWithQuestion(run))
    ofQuestion.set(Number(c.question), [...(ofQuestion.get(Number(c.question)) ?? []), c.id]);
  return {
    review: asked.review,
    questions,
    bare: questions.map((_, i) => i).filter((i) => !counts.get(i)),
    hypotheses: items.hypotheses.map((h) => ({ id: h.id, text: h.text })),
    verdicts,
    figures: asked.figures,
    evidence: questions.map(
      (_, i) =>
        new Set([
          ...(cards.get(i)?.claims ?? []).filter((c) => verifiedClaim(ctx.ledger, run, c)),
          ...(ofQuestion.get(i) ?? []),
        ]),
    ),
    proposed: proposedHypotheses(ctx, run).map((h) => ({ id: h.id, text: h.text })),
  };
}

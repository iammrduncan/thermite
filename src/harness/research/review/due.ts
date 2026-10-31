import type { ResearchContract } from "../../../core/contract.ts";
import { ANSWERED } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import { cardsOf } from "../cards.ts";
import { researchEnd } from "./end.ts";
import { itemsMarker, itemsState, researchReviews, waitingReview } from "./items.ts";
import { questionsWords } from "./shared.ts";

/** Why the review panel is not asked now, or the marker of the items it would see. */
export function researchReviewDue(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
):
  | { due: true; marker: string; questions: number[]; hypotheses: string[] }
  | { due: false; why: string } {
  const end = researchEnd(ledger, run);
  if (end)
    return {
      due: false,
      why:
        end.reason === ANSWERED
          ? "the review panel's decisions gave every item an end"
          : "the progress rule ended the run",
    };
  if (clock.elapsed_ms < clock.min_ms)
    return { due: false, why: "the run has not run for its minimum duration yet" };
  const n = contract.questions.length;
  const carded = new Set(cardsOf(ledger, run).map((c) => c.question));
  const bare = Array.from({ length: n }, (_, i) => i).filter((i) => !carded.has(i));
  if (bare.length)
    return {
      due: false,
      why: `${questionsWords(bare)} ${bare.length === 1 ? "has" : "have"} no answer card yet`,
    };
  const floor = contract.min_verified_claims;
  const verified = ledger.claims.count(run, { verified: true });
  if (floor !== undefined && verified < floor)
    return {
      due: false,
      why: `the run has ${verified} verified claims of the ${floor} the campaign asks for`,
    };
  const waiting = waitingReview(ledger, run);
  if (waiting) return { due: false, why: `review ${String(waiting.id)} waits` };
  const { decide } = itemsState(ledger, run, n);
  if (!decide.questions.length && !decide.hypotheses.length)
    return {
      due: false,
      why: "every item has a decision that stands: a question is reviewed again when its answer card changes",
    };
  const marker = itemsMarker(ledger, run, n);
  const seen = researchReviews(ledger, run).find((r) => r.commit_sha === marker);
  if (seen)
    return { due: false, why: `review ${String(seen.id)} saw these items: it needs a new card` };
  return { due: true, marker, questions: decide.questions, hypotheses: decide.hypotheses };
}

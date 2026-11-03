import { ANSWERED, PROGRESS_STOPPED, RESEARCH_STOPPED } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import { acceptedReview, researchReviews } from "./items.ts";
import type { Row } from "./shared.ts";

/** How a research run ended, when it did: answered (an accepted review) or stopped by the progress rule. */
export interface ResearchEnd {
  reason: typeof ANSWERED | typeof PROGRESS_STOPPED;
  /** The accepted review, for an answered run; the newest decided review, if any, for a stopped one. */
  review: Row | undefined;
  at: string;
  /** The questions with no end and the required hypotheses with no verdict when it ended. */
  open: { questions: number[]; hypotheses: string[] };
}

/**
 * A research run's end, when it has one: a review whose pass was accepted, or the progress rule's
 * stop (a `research_stopped` event). Either way no new trial starts, the final writer writes the
 * paper, and the run closes with the end's reason once its paper is in and its trials end.
 */
export function researchEnd(ledger: Ledger, run: string): ResearchEnd | undefined {
  const accepted = acceptedReview(ledger, run);
  if (accepted)
    return {
      reason: ANSWERED,
      review: accepted,
      at: String(accepted.owner_at ?? accepted.panel_at ?? ""),
      open: { questions: [], hypotheses: [] },
    };
  const stopped = ledger.events.newest(RESEARCH_STOPPED, { subject: run });
  if (!stopped) return undefined;
  const b = stopped.body;
  return {
    reason: PROGRESS_STOPPED,
    review: researchReviews(ledger, run).find((r) => r.panel_result !== null),
    at: stopped.at,
    open: {
      questions: (b.open?.questions ?? []).map(Number).filter(Number.isInteger),
      hypotheses: (b.open?.hypotheses ?? []).map(String),
    },
  };
}

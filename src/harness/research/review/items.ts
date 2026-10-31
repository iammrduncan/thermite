import { createHash } from "node:crypto";
import { REQUIRED_HYPOTHESES, RESEARCH_REVIEW } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import { cardsOf } from "../cards.ts";
import {
  hypothesisEnded,
  hypothesisEvidence,
  hypothesisTasksDone,
} from "../hypothesis-evidence.ts";
import { questionEnded, type StandingDecision, standingDecisions } from "../progress.ts";
import { listOf, type Row } from "./shared.ts";

/**
 * A research run's reviews and its items: its questions and its required hypotheses, the review
 * panel's decisions that stand on them, which have no end and which to decide.
 */

/** A run's research reviews, newest first. */
export function researchReviews(ledger: Ledger, run: string): Row[] {
  return ledger.reviews.ofGoal(run, RESEARCH_REVIEW);
}

/** The review whose pass was accepted (hands-off or by the owner): the run's items have ends. */
export function acceptedReview(ledger: Ledger, run: string): Row | undefined {
  return researchReviews(ledger, run).find((r) => r.owner_decision === "accepted");
}

/** A review that waits: for the review panel, or, passed, for the owner's acceptance. */
export function waitingReview(ledger: Ledger, run: string): Row | undefined {
  return researchReviews(ledger, run).find(
    (r) =>
      r.panel_result === null || (r.panel_result === "review_passed" && r.owner_decision === null),
  );
}

/** A run's required hypotheses (the author's and promoted ones), the oldest first. */
export function requiredHypotheses(
  ledger: Ledger,
  run: string,
): { id: string; text: string; status: string; question: number | null; supporting: string[] }[] {
  return ledger.hypotheses.withStatus(run, REQUIRED_HYPOTHESES).map((h) => ({
    id: h.id,
    text: h.text,
    status: h.status,
    question: h.question,
    supporting: listOf<string>(h.supporting).map(String),
  }));
}

/**
 * Where a run's items stand: the panel's standing decisions; the items with no end (a question
 * with no answered or insufficient, a hypothesis by hypothesisEnded); and the items to decide:
 * the questions with no standing decision, and the required hypotheses with no end.
 */
export function itemsState(
  ledger: Ledger,
  run: string,
  questions: number,
): {
  standing: Map<string, StandingDecision>;
  open: { questions: number[]; hypotheses: string[] };
  decide: { questions: number[]; hypotheses: string[] };
} {
  const standing = standingDecisions(ledger, run);
  const all = Array.from({ length: questions }, (_, i) => i);
  const hypotheses = requiredHypotheses(ledger, run).map((h) => h.id);
  const evidence = hypothesisEvidence(ledger, run);
  const undecidedHypotheses = hypotheses.filter(
    (id) => !hypothesisEnded(standing.get(`hypothesis:${id}`), evidence.get(id) ?? 0),
  );
  return {
    standing,
    open: {
      questions: all.filter((i) => !questionEnded(standing.get(`question:${i}`))),
      hypotheses: undecidedHypotheses,
    },
    decide: {
      questions: all.filter((i) => !standing.has(`question:${i}`)),
      hypotheses: undecidedHypotheses,
    },
  };
}

/**
 * The items a review sees, as a marker: each question's newest card version, the required
 * hypotheses and their tasks done. A review is never asked twice with the same marker.
 */
export function itemsMarker(ledger: Ledger, run: string, questions: number): string {
  const versions = new Map(cardsOf(ledger, run).map((c) => [c.question, c.version]));
  const cards = Array.from({ length: questions }, (_, i) => `${i}v${versions.get(i) ?? 0}`);
  const ids = requiredHypotheses(ledger, run)
    .map((h) => h.id)
    .sort();
  const hash = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 12);
  const tasks = hypothesisTasksDone(ledger, run);
  return `items:${cards.join(".")}:h${ids.length}-${hash}${tasks ? `:t${tasks}` : ""}`;
}

import type { ResearchContract } from "../../../core/contract.ts";
import { PAPER_ACCEPTED, PAPER_REQUESTED } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import {
  ANSWERED,
  checkedPanel,
  type ResearchEnd,
  researchEnd,
  researchPackage,
} from "../review/index.ts";
import type { PapersContext, Row } from "./context.ts";

/** A run's paper asked for, with the corpus figures frozen in the request, and accepted. */

/**
 * The corpus figures the writer is given, frozen when the paper is requested: the Method part may
 * state them, and a number equal to one is never refused.
 */
export interface PaperFigures {
  sources: number;
  domains: number;
  verified_claims: number;
  corroborated_claims: number;
  draft_claims: number;
  findings: number;
  draft_findings: number;
  questions: number;
  hypotheses: number;
  min_independent_domains: number;
  review: number;
  reviewers: number;
}

/** The figures of a run's corpus now, for its paper's request. */
function figuresNow(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  review: Row | undefined,
): PaperFigures {
  const corpus = researchPackage(ledger, run, contract).corpus;
  return {
    sources: corpus.sources,
    domains: corpus.domains,
    verified_claims: corpus.verified_claims,
    corroborated_claims: corpus.corroborated_claims,
    draft_claims: ledger.claims.count(run, { verified: false }),
    findings: corpus.findings,
    draft_findings: ledger.claims.countFindings(run, false),
    questions: contract.questions.length,
    hypotheses: ledger.hypotheses.count(run),
    min_independent_domains: corpus.min_independent_domains,
    review: review ? Number(review.id) : 0,
    reviewers: review ? checkedPanel(review).length : 0,
  };
}

/** The event body of a paper's request, as the harness keeps it. */
interface PaperRequest {
  review: number;
  figures: PaperFigures;
  /** How the run ended; a request from before goal 117 has none: answered. */
  end?: string;
}

/** Whether a request is for the run's end: the same end, and for an answered run the same review. */
const forEnd = (b: PaperRequest, end: ResearchEnd) =>
  (b.end ?? ANSWERED) === end.reason &&
  (end.reason !== ANSWERED || Number(b.review) === Number(end.review?.id));

/** The run's accepted paper, as its event keeps it: the paper whole, with its references and appendices. */
export function accepted(ctx: PapersContext, run: string): Row | undefined {
  return ctx.ledger.latestEventBody(PAPER_ACCEPTED, run);
}

/** The request for the paper of the run's end, when the harness made it. */
export function requested(
  ctx: PapersContext,
  run: string,
): { review: number; figures: PaperFigures; at: string } | undefined {
  const end = researchEnd(ctx.ledger, run);
  if (!end) return undefined;
  const row = ctx.ledger.events.newest(PAPER_REQUESTED, { subject: run });
  if (!row) return undefined;
  const b = row.body as PaperRequest;
  return forEnd(b, end) ? { review: b.review, figures: b.figures, at: row.at } : undefined;
}

/**
 * Asks the final writer for the paper of a run that ended (its review's pass accepted, or the
 * progress rule's stop), once: the figures of its corpus are frozen in the request. False when
 * there is nothing to ask.
 */
export function request(ctx: PapersContext, run: string, by: string): boolean {
  const end = researchEnd(ctx.ledger, run);
  if (!end || requested(ctx, run) || accepted(ctx, run)) return false;
  const figures = figuresNow(ctx.ledger, run, ctx.contract(run), end.review);
  ctx.ledger.appendEvent(by, PAPER_REQUESTED, run, {
    review: figures.review,
    figures,
    end: end.reason,
  });
  return true;
}

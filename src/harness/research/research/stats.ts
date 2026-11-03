import { registrableDomain } from "../../../agents/tools/index.ts";
import type { ResearchContext } from "./context.ts";

/** A run's figures: its corpus, its claims and how many are corroborated, and its last hour. */

/**
 * Distinct registrable domains a verified claim's quotes come from (goal 117): a source keeps
 * the host it was fetched from, and docs.example.com and blog.example.com count as one.
 */
export function claimDomains(ctx: ResearchContext, run: string, quotesJson: string): number {
  const ids = (JSON.parse(quotesJson) as { source: string }[]).map((q) => q.source);
  const domains = new Set<string>();
  for (const id of ids) {
    const d = ctx.ledger.sources.get(run, id)?.domain;
    if (d !== undefined) domains.add(registrableDomain(d));
  }
  return domains.size;
}

/** The run's distinct registrable domains (goal 117). */
function runDomains(ctx: ResearchContext, run: string): number {
  return new Set(ctx.ledger.sources.domains(run).map((d) => registrableDomain(d))).size;
}

/**
 * The run's figures: its corpus, claims, hypotheses and findings, each question's verified
 * claims, and the last hour's.
 */
export function statsOf(ctx: ResearchContext, run: string) {
  const c = ctx.contract(run);
  const { claims, sources } = ctx.ledger;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const corroborated = claims
    .verified(run)
    .filter((r) => claimDomains(ctx, run, r.quotes) >= c.quality.min_independent_sources).length;
  return {
    sources: sources.count(run),
    domains: runDomains(ctx, run),
    verified: claims.count(run, { verified: true }),
    corroborated,
    drafts: claims.count(run, { verified: false }),
    hypotheses: ctx.ledger.hypotheses.count(run),
    findings: claims.countFindings(run, true),
    draft_findings: claims.countFindings(run, false),
    questions: c.questions.map((q, i) => ({
      question: q,
      verified: claims.count(run, { question: i, verified: true }),
    })),
    // Novelty in the last hour: new sources, newly verified claims, newly covered questions.
    last_hour: {
      sources: sources.countSince(run, hourAgo),
      verified: claims.countVerifiedSince(run, hourAgo),
      questions_covered: c.questions.filter((_, i) => {
        const t = claims.firstVerified(run, i);
        return t !== undefined && t > hourAgo;
      }).length,
    },
  };
}

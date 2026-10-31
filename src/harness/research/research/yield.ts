import { registrableDomain } from "../../../agents/tools/index.ts";
import type { TaskYield } from "../../queue.ts";
import type { ResearchContext } from "./context.ts";

/**
 * What a research trial added (goal 117), from the records its lane wrote between the trial's
 * start and now (a lane runs one trial at a time): its verified claims, by question, and how
 * many brought a registrable domain its question's claims had not cited before; the registrable
 * domains new to the run among the pages it fetched; its supported findings. Cards come later in
 * goal 117: their changes are 0 for now. Undefined for a trial the ledger does not have.
 */
export function trialYield(
  ctx: ResearchContext,
  run: string,
  trial: string,
  until = new Date().toISOString(),
): TaskYield | undefined {
  const t = ctx.ledger.trials.get(trial);
  if (t?.run !== run) return undefined;
  const lane = t.lane;
  const since = t.started_at;
  const domainOf = new Map(
    ctx.ledger.sources.ofRun(run).map((s) => [s.id, registrableDomain(s.domain)]),
  );
  const domainsOf = (quotes: string) =>
    new Set(
      (JSON.parse(quotes) as { source: string }[]).flatMap((q) => {
        const d = domainOf.get(q.source);
        return d ? [d] : [];
      }),
    );
  // What each question's verified claims cited before the trial started.
  const seen = new Map<number, Set<string>>();
  for (const c of ctx.ledger.claims.verifiedBefore(run, since)) {
    const q = Number(c.question);
    seen.set(q, new Set([...(seen.get(q) ?? []), ...domainsOf(c.quotes)]));
  }
  const by = new Map<number, { verified_claims: number; new_domain_claims: number }>();
  let total = 0;
  for (const c of ctx.ledger.claims.verifiedOfLane(run, lane, since, until)) {
    total++;
    // A claim from before claims named their question counts in the total only.
    if (c.question === null) continue;
    const q = c.question;
    const had = seen.get(q) ?? new Set<string>();
    const ds = domainsOf(c.quotes);
    const fresh = [...ds].some((d) => !had.has(d));
    seen.set(q, new Set([...had, ...ds]));
    const row = by.get(q) ?? { verified_claims: 0, new_domain_claims: 0 };
    row.verified_claims++;
    if (fresh) row.new_domain_claims++;
    by.set(q, row);
  }
  const before = new Set(
    ctx.ledger.sources.domainsBefore(run, since).map((d) => registrableDomain(d)),
  );
  const fresh = [
    ...new Set(
      ctx.ledger.sources
        .domainsFetchedBy(run, lane, since, until)
        .map((d) => registrableDomain(d))
        .filter((d) => !before.has(d)),
    ),
  ];
  const findings = ctx.ledger.claims.countFindingsOfLane(run, lane, since, until);
  return {
    verified_claims: total,
    by_question: [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([question, r]) => ({ question, ...r })),
    new_domains: fresh.length,
    domains: fresh.slice(0, 20),
    findings,
    card_changes: 0,
  };
}

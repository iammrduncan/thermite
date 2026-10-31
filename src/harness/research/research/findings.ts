import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LedgerError } from "../../ledger/index.ts";
import { checkCited } from "../checks.ts";
import { DRAFT_FINDING, KEPT_FINDING } from "../worker-words.ts";
import { claimKey, clip, type ResearchContext } from "./context.ts";

export const FindingInput = z.object({
  text: z.string().min(5).max(4000),
  summary: z.string().min(5).max(8000),
  why_it_matters: z.string().min(5).max(8000),
  supporting: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * A finding: a worker's conclusion, with a summary and why it matters, citing verified claims.
 * Code checks it: every cited claim must be a verified claim of this run, and every number in
 * its text, summary and why must appear in those claims (their text or quotes). Otherwise it
 * is kept as a draft finding, with the problems.
 */
export function addFinding(ctx: ResearchContext, run: string, lane: string | null, input: unknown) {
  const f = FindingInput.parse(input);
  const cited = [...new Set(f.supporting)];
  // The check a review panel's answer shares (checks.ts).
  const { problems } = checkCited(ctx.ledger, run, cited, [f.text, f.summary, f.why_it_matters]);
  const supported = problems.length === 0;
  // The same statement again (goal 117): a supported one is kept once; a draft is refused in
  // words, whatever its problems, with the finding it repeats, so a worker that resends it in
  // a loop learns what to change and fills no records. Only a supported one is recorded again.
  const before = ctx.ledger.claims
    .findings(run)
    .filter((r) => claimKey(r.text) === claimKey(f.text));
  const kept = before.find((r) => r.supported);
  if (kept) return { finding: kept.id, supported: true, problems: [], note: KEPT_FINDING };
  const draft = before[0];
  if (draft && !supported)
    throw new LedgerError(
      "invalid",
      `this finding repeats draft finding ${draft.id} and is not recorded again. It is still a draft: ${problems.join("; ")}. Cite only verified claims and use only numbers they contain, then send it again; or record what you learned as a note (add_note)`,
    );
  const id = `f-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  ctx.ledger.tx(() => {
    ctx.ledger.claims.addFinding({
      id,
      run,
      lane,
      text: f.text,
      summary: f.summary,
      whyItMatters: f.why_it_matters,
      supporting: cited,
      supported,
      problems,
    });
    // The finding's statement, summary and why it matters, bounded.
    ctx.ledger.appendEvent(lane ?? "research", "finding_added", run, {
      finding: id,
      supported,
      claims: cited.length,
      statement: clip(f.text, 1000),
      summary: clip(f.summary, 1000),
      why: clip(f.why_it_matters, 500),
    });
  });
  ctx.changed(run);
  const note = supported ? undefined : DRAFT_FINDING;
  return note ? { finding: id, supported, problems, note } : { finding: id, supported, problems };
}

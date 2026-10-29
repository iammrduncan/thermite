import type { PaperExperiment, PaperSubmission } from "../../../core/api/harness/research.ts";
import { newExperimentId } from "../../../core/ids.ts";
import { PAPER_ACCEPTED, PAPER_REFUSED } from "../../../core/research-check.ts";
import { ANSWERED, researchEnd } from "../review/index.ts";
import { claimsAppendix, numberCitations, panelAppendix, referencesPart } from "./appended.ts";
import { paperBasis } from "./basis.ts";
import { checkPaper, type PaperProblem } from "./check.ts";
import type { PapersContext } from "./context.ts";
import { paperItems, proposedHypotheses } from "./items.ts";
import { clip } from "./markdown.ts";
import { checkExperiments, nextSectionProblems } from "./next.ts";
import { PROPOSED_MAX } from "./package.ts";
import { steProblems } from "./ste.ts";

/** A paper checked, as its writer asks or as the supervisor posts it, then accepted or refused. */

/**
 * A draft checked, as the writer's check_paper tool asks: each problem with its line; with its
 * next experiments when it gives them (goal 119).
 */
export function checkDraft(
  ctx: PapersContext,
  run: string,
  markdown: string,
  experiments?: PaperExperiment[],
): { ok: boolean; problems: PaperProblem[] } {
  const { problems } = checkPaper(ctx.ledger, run, paperBasis(ctx, run), markdown);
  if (experiments)
    problems.push(
      ...checkExperiments(ctx.ledger, run, experiments).map((problem) => ({
        line: null,
        problem,
      })),
      ...nextSectionProblems(markdown, experiments),
    );
  return { ok: problems.length === 0, problems };
}

/**
 * A paper the supervisor posts for a run that waits for one: checked by code, then accepted or
 * refused with its problems. Accepted, its citations become numbered references, and it is kept
 * whole with the References and the appendices that code appends; each next experiment becomes
 * an experiment of the campaign's knowledge-base collection.
 */
export function submit(
  ctx: PapersContext,
  run: string,
  input: PaperSubmission,
  by: string,
):
  | { accepted: true; chars: number; cited: number; experiments: string[]; ste_checked: boolean }
  | { accepted: false; problems: PaperProblem[] } {
  const basis = paperBasis(ctx, run);
  const checked = checkPaper(ctx.ledger, run, basis, input.paper);
  const problems: PaperProblem[] = [
    ...checked.problems,
    ...checkExperiments(ctx.ledger, run, input.experiments).map((problem) => ({
      line: null,
      problem,
    })),
    ...nextSectionProblems(input.paper, input.experiments),
    ...steProblems(input.ste, input.paper),
  ];
  if (problems.length) {
    ctx.ledger.appendEvent(by, PAPER_REFUSED, run, {
      review: basis.review,
      writer: input.writer,
      count: problems.length,
      problems: problems
        .slice(0, 20)
        .map((p) => clip(`${p.line ? `line ${p.line}: ` : ""}${p.problem}`, 300)),
      ste_checked: input.ste.checked,
    });
    return { accepted: false, problems };
  }
  // What readers get: numbered references, then the parts code writes (owner, 2026-10-24).
  const numbered = numberCitations(ctx.ledger, run, input.paper.replace(/\s+$/, ""), checked.cited);
  const paper = [
    numbered.text,
    "",
    ...referencesPart(numbered.references),
    "",
    ...panelAppendix(
      paperItems(ctx, run),
      researchEnd(ctx.ledger, run)?.reason ?? ANSWERED,
      proposedHypotheses(ctx, run),
      PROPOSED_MAX,
    ),
    "",
    ...claimsAppendix(ctx.ledger, run, checked.cited, numbered.numbers),
    "",
  ].join("\n");
  const finding = (id: string) => ctx.ledger.claims.finding(run, id);
  const claim = (id: string) => ctx.ledger.claims.get(run, id);
  const experiments = input.experiments.map((x) => ({
    id: newExperimentId(),
    title: x.title,
    why: x.why,
    details: x.details,
    kind: x.kind,
    measure: x.measure,
    findings: [...new Set(x.findings)],
    claims: [...new Set(x.claims)],
    // What it rests on, in words: a run that takes it cannot read this run's records.
    rests_on: [
      ...[...new Set(x.findings)].map((f) => `finding ${f}: ${clip(finding(f)?.text ?? "", 300)}`),
      ...[...new Set(x.claims)].map((c) => `claim ${c}: ${clip(claim(c)?.text ?? "", 300)}`),
    ],
  }));
  const ste = input.ste.checked
    ? {
        checked: true,
        version: input.ste.version,
        issue: input.ste.issue,
        counts: input.ste.counts,
      }
    : { checked: false, why: input.ste.why };
  ctx.ledger.appendEvent(by, PAPER_ACCEPTED, run, {
    review: basis.review,
    writer: input.writer,
    ste,
    cited_claims: checked.cited.length,
    // Each cited claim's reference numbers: what each [n] of the paper stands for.
    citations: Object.fromEntries(numbered.numbers),
    references: numbered.references.length,
    experiments,
    chars: paper.length,
    paper,
  });
  return {
    accepted: true,
    chars: paper.length,
    cited: checked.cited.length,
    experiments: experiments.map((x) => x.id),
    ste_checked: input.ste.checked,
  };
}

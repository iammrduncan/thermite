import { cutSaid } from "../../../core/kb-index.ts";
import { hypothesisStatusWords, questionLabel } from "../../../core/research-check.ts";
import { type ClaimRow, type FindingRow, LedgerError } from "../../ledger/index.ts";
import { answersSection } from "../cards.ts";
import { claimNumbers, numbersIn } from "../checks.ts";
import { Papers } from "../paper/index.ts";
import { answerSections, checkLine, researchEnd } from "../review/index.ts";
import { clockOf } from "./clock.ts";
import { claimKey, type ResearchContext } from "./context.ts";
import { claimDomains, statsOf } from "./stats.ts";

/** A run's report: the sections its workers write, and each version of it from the ledger. */

/** A worker's section of the run's report: shown as notes, never as findings. */
export function updateSection(
  ctx: ResearchContext,
  run: string,
  by: string | null,
  name: string,
  body: string,
) {
  if (!/^[a-z0-9][a-z0-9 _-]{0,59}$/i.test(name))
    throw new LedgerError("invalid", "section names are short words");
  ctx.ledger.reports.setSection(run, name, body.slice(0, 20_000), by ?? "worker");
  ctx.changed(run);
  return { section: name };
}

/**
 * A report version from the ledger: each question's answer card first (goal 117), then
 * sections, the verified claims with their sources, the hypotheses with their support, the
 * open questions, and numbers in the sections that appear in no archived source and no verified
 * claim (flagged, not hidden).
 *
 * A final report of a run that ended (goals 112 and 117: its questions answered, or stopped by
 * the progress rule) starts with its research paper, when code accepted one; the review panel's
 * decisions and the corpus follow it, as an appendix. Without a paper it says why: `noPaper`,
 * or what the records show.
 */
export function report(
  ctx: ResearchContext,
  run: string,
  kind: "digest" | "final",
  opts: { noPaper?: string | undefined } = {},
) {
  const c = ctx.contract(run);
  const papers = new Papers(ctx.ledger, () => c);
  const paper = kind === "final" ? papers.accepted(run) : undefined;
  const noPaper =
    kind === "final" && !paper && researchEnd(ctx.ledger, run)
      ? (opts.noPaper ??
        (papers.requested(run)
          ? "the run ended before the final writer's paper passed the harness's checks"
          : "the run ended before a final writer was asked for one"))
      : undefined;
  const stats = statsOf(ctx, run);
  const clock = clockOf(ctx, run);
  const sources = new Map(ctx.ledger.sources.ofRun(run).map((s) => [s.id, s]));
  const claims = ctx.ledger.claims.verified(run);
  const sections = ctx.ledger.reports.sections(run);
  // A number in a section is supported only by a verified claim (its text or its quotes).
  const supported = claimNumbers(claims);
  const unsupported: string[] = [];
  for (const s of sections) {
    for (const num of numbersIn(s.body)) {
      if (!supported.has(num) && !unsupported.includes(num)) unsupported.push(num);
    }
  }
  const min = c.quality.min_independent_sources;
  const corroborated = claims.filter((cl) => claimDomains(ctx, run, cl.quotes) >= min);
  const single = claims.filter((cl) => claimDomains(ctx, run, cl.quotes) < min);
  const cite = (cl: ClaimRow) => {
    const quotes = JSON.parse(cl.quotes) as { source: string; quote: string }[];
    return `- ${cl.text} ${[...new Set(quotes.map((q) => sources.get(q.source)?.url).filter(Boolean))].map((u) => `[${u}]`).join(" ")}`;
  };
  // Worker-written text cannot make its own headings: a line starting with # is shown as text.
  const fence = (body: string) => body.replace(/^(\s*)#/gm, "$1\\#");
  const byId = new Map(claims.map((cl) => [cl.id, cl]));
  const findings = ctx.ledger.claims.findings(run);
  const supportedFindings = findings.filter((f) => f.supported);
  const supportedWords = new Set(supportedFindings.map((f) => claimKey(f.text)));
  const finding = (f: FindingRow) => {
    const cited = (JSON.parse(f.supporting) as string[])
      .map((id) => byId.get(id))
      .filter((cl): cl is ClaimRow => cl !== undefined);
    const strong = cited.filter((cl) => corroborated.includes(cl)).length;
    return [
      `### ${fence(f.text).replace(/\n+/g, " ")}`,
      "",
      fence(f.summary),
      "",
      `Why it matters: ${fence(f.why_it_matters)}`,
      "",
      `Supported by ${cited.length} verified claims (${strong} from at least ${min} independent domains):`,
      ...cited.map(cite),
      "",
    ];
  };
  const lines = [
    `# ${c.title}`,
    "",
    `Topic: ${c.topic}`,
    `Report: ${kind}, ${new Date().toISOString()}. Elapsed ${(clock.elapsed_ms / 3_600_000).toFixed(2)} h of at least ${(clock.min_ms / 3_600_000).toFixed(2)} h.`,
    `Corpus: ${stats.sources} sources from ${stats.domains} domains; ${stats.verified} verified claims (${stats.corroborated} from at least ${min} independent domains), ${stats.drafts} drafts; ${stats.findings} findings, ${stats.draft_findings} draft findings.`,
    `Last hour: ${stats.last_hour.sources} new sources, ${stats.last_hour.verified} newly verified claims, ${stats.last_hour.questions_covered} questions newly covered.`,
    // Where the check that every question is answered stands (goal 112).
    ...(kind === "digest" ? [checkLine(ctx.ledger, run, c, clock)] : []),
    "",
    // Why an answered run has no research paper (goal 112).
    ...(noPaper ? [`Research paper: none, ${noPaper}.`, ""] : []),
    // Each question's answer card first (goal 117), for people: "Question 1".
    ...answersSection(ctx.ledger, run, c, fence),
    // The review panel's answers and verdicts (goal 112): one block, after the paper.
    ...(kind === "final" ? answerSections(ctx.ledger, run, c, fence) : []),
    "## Questions",
    // A question may have several lines (goal 078): its further lines stay under it.
    // Numbered from 1, with the index a claim's `question` takes: workers read REPORT.md too.
    ...stats.questions.map(
      (q, i) =>
        `- ${questionLabel(i)}: ${q.question.replace(/\n/g, "\n  ")} (${q.verified} verified claims)`,
    ),
    "",
    "## Findings",
    ...supportedFindings.flatMap(finding),
    "",
    `## Verified claims from at least ${min} independent domains`,
    ...corroborated.map(cite),
    "",
    "## Verified claims from a single domain",
    ...single.map(cite),
    "",
    "## Draft findings (not supported by verified claims)",
    ...findings
      .filter((f) => !f.supported && !supportedWords.has(claimKey(f.text)))
      .map(
        (f) =>
          `- ${fence(f.text).replace(/\n+/g, " ")} (${(JSON.parse(f.problems) as string[]).join("; ")})`,
      ),
    "",
    // Those that need a verdict first: the author's, then promoted ones; then the pool and the
    // rest, each with its status and question (goal 117).
    "## Hypotheses",
    ...ctx.ledger.hypotheses
      .byStatus(run)
      .map(
        (h) =>
          `- ${fence(h.text).replace(/\n+/g, " ")} (${h.id}, ${hypothesisStatusWords(h.status, h.merged_into)}; ${h.question === null ? "the whole run" : questionLabel(h.question)}; supported by ${(JSON.parse(h.supporting) as string[]).length} verified claims)`,
      ),
    "",
    "## Open questions",
    ...stats.questions.flatMap((q, i) =>
      q.verified === 0 ? [`- ${questionLabel(i)}: ${q.question.replace(/\n/g, "\n  ")}`] : [],
    ),
    "",
    "## Worker sections (not verified; only the findings and claims above are checked)",
    ...sections.flatMap((s) => [`### ${s.name}`, fence(s.body), ""]),
    ...(unsupported.length
      ? [
          "",
          "## Numbers without a source",
          `These appear in the sections but in no archived source or verified claim: ${unsupported.join(", ")}`,
        ]
      : []),
  ];
  // The paper first, whole, with its appendices; then the rest as supplementary material.
  const body = paper
    ? [
        String(paper.paper).replace(/\s+$/, ""),
        "",
        "---",
        "",
        `# Supplementary material: the review panel's decisions and the corpus of ${c.title}`,
        ...lines.slice(1),
      ].join("\n")
    : lines.join("\n");
  ctx.ledger.tx(() => {
    ctx.ledger.reports.add(run, kind, body);
    ctx.ledger.appendEvent(
      "research",
      kind === "final" ? "research_final" : "research_digest",
      run,
      {
        ...stats,
        elapsed_ms: clock.elapsed_ms,
        // So the run's page can say when the answer check starts (goal 112).
        min_ms: clock.min_ms,
        max_ms: clock.max_ms,
        min_verified_claims: c.min_verified_claims ?? null,
        // A final report: whether it starts with a research paper, or why not (goal 112).
        ...(kind === "final" ? { paper: paper !== undefined } : {}),
        ...(noPaper ? { no_paper: noPaper } : {}),
        unsupported_numbers: unsupported.length,
        report: cutSaid(body, 60_000, "report"),
      },
    );
  });
  ctx.changed(run);
  return { kind, body };
}

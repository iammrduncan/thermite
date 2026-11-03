import type { Ledger } from "../../ledger/index.ts";
import type { StandingDecision } from "../progress.ts";
import type {
  CheckedHypothesis,
  CheckedQuestion,
  Dissent,
  requiredHypotheses,
} from "../review/index.ts";
import { CITE, clip, FENCE } from "./markdown.ts";

/**
 * What code appends to an accepted research paper (owner, 2026-10-24): its citations as numbered
 * references, the References part, and two appendices, the review panel's decisions and the claims
 * cited. The writer writes none of them.
 */

/** A run's items as its paper reads them (goal 117): each with its standing decision and dissent. */
export interface PaperItems {
  questions: {
    index: number;
    text: string;
    decision: StandingDecision | undefined;
    /** The answers behind the decision that passed the check. */
    answers: CheckedQuestion[];
    dissent: Dissent[];
  }[];
  hypotheses: (ReturnType<typeof requiredHypotheses>[number] & {
    decision: StandingDecision | undefined;
    given: CheckedHypothesis[];
    dissent: Dissent[];
  })[];
}

/** One numbered reference of an accepted paper: an archived source of the claims it cites. */
export interface PaperReference {
  n: number;
  /** The archived source; absent for a cited claim with none, which is then its own reference. */
  source?: { id: string; url: string; title: string; domain: string; archived: string };
  claim?: string;
}

/**
 * A paper's citations as readers get them (owner, 2026-10-24: "normal reference numbering like
 * [1] in the text, mapped to claims behind the scenes"): each [c-…] becomes the numbers of its
 * claims' archived sources, [1] or [1, 3], numbered in the order the paper first cites them. Code
 * blocks keep their text. With the references and each claim's numbers.
 */
export function numberCitations(
  ledger: Ledger,
  run: string,
  markdown: string,
  cited: string[],
): { text: string; references: PaperReference[]; numbers: Map<string, number[]> } {
  const references: PaperReference[] = [];
  const numbers = new Map<string, number[]>();
  const bySource = new Map<string, number>();
  for (const id of cited) {
    const cl = ledger.claims.get(run, id);
    if (!cl?.verified) continue;
    const ns: number[] = [];
    for (const s of new Set((JSON.parse(cl.quotes) as { source: string }[]).map((q) => q.source))) {
      let n = bySource.get(s);
      if (n === undefined) {
        const row = ledger.sources.get(run, s);
        if (!row) continue;
        n = references.length + 1;
        references.push({
          n,
          source: {
            id: s,
            url: row.url,
            title: row.title?.trim() ? clip(row.title, 200) : "",
            domain: row.domain,
            archived: row.fetched_at.slice(0, 10),
          },
        });
        bySource.set(s, n);
      }
      if (!ns.includes(n)) ns.push(n);
    }
    if (!ns.length) {
      ns.push(references.length + 1);
      references.push({ n: references.length + 1, claim: id });
    }
    numbers.set(id, ns);
  }
  let fence = false;
  const text = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) fence = !fence;
      if (fence || FENCE.test(line)) return line;
      return line.replace(CITE, (whole, ids: string) => {
        const ns = [...new Set(ids.split(/[,;]/).flatMap((x) => numbers.get(x.trim()) ?? []))].sort(
          (x, y) => x - y,
        );
        return ns.length ? `[${ns.join(", ")}]` : whole;
      });
    })
    .join("\n");
  return { text, references, numbers };
}

/** The References part code appends: each source, numbered as the paper cites it. */
export function referencesPart(refs: PaperReference[]): string[] {
  return [
    "## References",
    ...refs.flatMap((r) => [
      "",
      r.source
        ? `[${r.n}] ${r.source.title ? `${r.source.title}. ` : ""}${r.source.domain}, archived ${r.source.archived}. <${r.source.url}>`
        : `[${r.n}] The run's claim ${r.claim}, which has no archived source.`,
    ]),
  ];
}

const tableCell = (s: string) => clip(s, 600).replace(/\|/g, "\\|");

/**
 * Appendix A, which code appends (goal 117): how the run ended; the review panel's standing
 * decision on each question, with its certainty, and its verdict on each hypothesis that needs
 * one; how many reviewers gave each, and each reviewer who dissents with the reasons, as the owner
 * asked: "the dissent kept in the review and the paper"; then the hypotheses the run proposed,
 * which the panel did not judge.
 */
export function panelAppendix(
  items: PaperItems,
  end: string,
  proposed: { id: string; text: string }[],
  max: number,
): string[] {
  const dissent = (ds: Dissent[]) =>
    ds.length
      ? tableCell(
          ds
            .map(
              (d) =>
                `${d.reviewer}: ${d.verdict}${d.certainty ? `, certainty ${d.certainty}` : ""}${d.reasons ? `. ${d.reasons}` : ""}`,
            )
            .join("; "),
        )
      : "none";
  const decided = (d: StandingDecision | undefined) =>
    d
      ? `${d.decision === "insufficient" ? "insufficient: the best answer the sources allow" : d.decision} (review ${d.review})`
      : "no decision";
  const listed = proposed.slice(0, max);
  return [
    "## Appendix A: The review panel's decisions",
    "",
    `The harness wrote this appendix from the records of the review panel. The writer of the paper did not write it. The run ended because ${end}.`,
    "",
    "### Questions",
    "",
    "| Question | Decision | Certainty | Reviewers who gave it | Dissent |",
    "| --- | --- | --- | --- | --- |",
    ...items.questions.map(
      (q) =>
        `| ${q.index + 1}. ${tableCell(q.text)} | ${decided(q.decision)} | ${q.decision?.decision === "answered" ? (q.decision.certainty ?? "not given") : "-"} | ${q.decision ? q.answers.length : "-"} | ${dissent(q.dissent)} |`,
    ),
    ...(items.hypotheses.length
      ? [
          "",
          "### Hypotheses",
          "",
          "| Hypothesis | Verdict | Reviewers who gave it | Dissent |",
          "| --- | --- | --- | --- |",
          ...items.hypotheses.map(
            (h) =>
              `| ${tableCell(h.text)} (${h.id}) | ${h.decision ? decided(h.decision) : "undecided: no verdict"} | ${h.decision ? h.given.length : "-"} | ${dissent(h.dissent)} |`,
          ),
        ]
      : []),
    ...(listed.length
      ? [
          "",
          "### Hypotheses that the run proposed",
          "",
          "The review panel did not judge these hypotheses.",
          "",
          ...listed.map((h) => `- ${clip(h.text, 600)} (${h.id})`),
          ...(proposed.length > listed.length
            ? [`- And ${proposed.length - listed.length} more.`]
            : []),
        ]
      : []),
  ];
}

/** Appendix B, which code appends: each claim the paper cites, with its references. */
export function claimsAppendix(
  ledger: Ledger,
  run: string,
  cited: string[],
  numbers: Map<string, number[]>,
): string[] {
  return [
    "## Appendix B: The claims cited",
    "",
    "Each claim that the paper cites, with the references that its quotes come from. The harness checked each quote against the archived text of its source.",
    "",
    "| Claim | What it says | References |",
    "| --- | --- | --- |",
    ...cited.flatMap((id) => {
      const row = ledger.claims.get(run, id);
      const ns = numbers.get(id);
      return row?.verified && ns ? [`| ${id} | ${tableCell(row.text)} | [${ns.join(", ")}] |`] : [];
    }),
  ];
}

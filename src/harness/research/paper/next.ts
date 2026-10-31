import type { PaperExperiment } from "../../../core/api/harness/research.ts";
import type { Ledger } from "../../ledger/index.ts";
import { checkCited } from "../checks.ts";
import type { PaperProblem } from "./check.ts";
import { clip, FENCE, fold, HEADING } from "./markdown.ts";

/** A paper's next experiments (goal 119): their kinds, and code's checks of them. */

/**
 * The kinds of next experiment (goal 119), by the run that takes one: an improvement a hill climb
 * measures against its champion, or an outcome a goal campaign proves.
 */
export const NEXT_KINDS = ["hill_climb", "goal"] as const;
export type NextKind = (typeof NEXT_KINDS)[number];
/** Each kind in words. */
export const NEXT_KIND_WORDS: Record<NextKind, string> = {
  hill_climb: "an improvement a hill climb measures against its champion",
  goal: "an outcome a goal campaign proves",
};
/** Each kind's section heading in the paper's part on future work. */
export const NEXT_HEADINGS: Record<NextKind, string> = {
  hill_climb: "For a hill climb",
  goal: "For a goal campaign",
};
/** What a kind's measure says. */
const MEASURE_WORDS: Record<NextKind, string> = {
  hill_climb: "the metric it should move, and which way",
  goal: "how a check would know the goal is reached",
};
export const isNextKind = (k: string): k is NextKind =>
  (NEXT_KINDS as readonly string[]).includes(k);

/**
 * Each next experiment checked: its kind and measure (goal 119), and that it rests on supported
 * findings or verified claims of the run.
 */
export function checkExperiments(ledger: Ledger, run: string, xs: PaperExperiment[]): string[] {
  const out: string[] = [];
  xs.forEach((x, i) => {
    const which = `next experiment ${i + 1} ("${clip(x.title, 80)}")`;
    if (!isNextKind(x.kind))
      out.push(
        `${which} ${x.kind ? `has the kind "${clip(x.kind, 40)}", which is not one` : "has no kind"}: give hill_climb (${NEXT_KIND_WORDS.hill_climb}) or goal (${NEXT_KIND_WORDS.goal})`,
      );
    else if (!x.measure) out.push(`${which} has no measure: give ${MEASURE_WORDS[x.kind]}`);
    if (!x.findings.length && !x.claims.length)
      out.push(
        `${which} rests on no finding or claim: give the ids of the supported findings or verified claims it builds on`,
      );
    for (const f of [...new Set(x.findings)]) {
      const row = ledger.claims.finding(run, f);
      if (!row) out.push(`${which}: no finding ${f}`);
      else if (!row.supported) out.push(`${which}: finding ${f} is a draft, not supported`);
    }
    for (const p of checkCited(ledger, run, x.claims, []).problems) out.push(`${which}: ${p}`);
  });
  return out;
}

/**
 * The paper has a ### section for each kind its next experiments have (goal 119), headed as
 * NEXT_HEADINGS says, in the part on future work or wherever the writer puts its next experiments.
 * Problems in words, or none.
 */
export function nextSectionProblems(markdown: string, xs: PaperExperiment[]): PaperProblem[] {
  const kinds = [...new Set(xs.map((x) => x.kind).filter(isNextKind))];
  if (!kinds.length) return [];
  const headings: string[] = [];
  let fence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h && (h[1] as string).length >= 3) headings.push(fold(h[2] as string));
  }
  return kinds
    .filter((k) => !headings.some((x) => x.startsWith(fold(NEXT_HEADINGS[k]))))
    .map((k) => {
      const n = xs.filter((x) => x.kind === k).length;
      return {
        line: null,
        problem: `the paper has no "### ${NEXT_HEADINGS[k]}" section, and ${n} of its next experiments ${n === 1 ? "is" : "are"} for ${k === "goal" ? "a goal campaign" : "a hill climb"}: put ${n === 1 ? "it" : "them"} under that heading, in the part on future work`,
      };
    });
}

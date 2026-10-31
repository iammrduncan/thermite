import type { SteResult } from "../../../core/api/harness/research.ts";
import { sha256Hex } from "../../../core/canonical.ts";
import type { PaperProblem } from "./check.ts";
import { clip } from "./markdown.ts";

/** The STE checker's result on a paper, as the supervisor ran it on the paper's text. */

/**
 * The STE checker's result held to the paper: it is of this text, and it found no error. A paper
 * the rig had no checker for is not refused here; it is accepted as not checked, and says so.
 */
export function steProblems(ste: SteResult, paper: string): PaperProblem[] {
  if (!ste.checked) return [];
  if (ste.sha256 !== sha256Hex(paper))
    return [{ line: null, problem: "the STE checker's result is not of this paper's text" }];
  if (ste.counts.error === 0) return [];
  const errors = ste.findings.filter((f) => f.severity === "error");
  return [
    {
      line: null,
      problem: `the STE checker found ${ste.counts.error} ${ste.counts.error === 1 ? "error" : "errors"}`,
    },
    ...errors.slice(0, 20).map((f) => ({
      line: f.line || null,
      problem: `STE ${f.rule}: ${clip(f.message, 300)}${f.text ? ` ("${clip(f.text, 80)}")` : ""}`,
    })),
    ...(errors.length > 20
      ? [{ line: null, problem: `and ${errors.length - 20} more STE errors` }]
      : []),
  ];
}

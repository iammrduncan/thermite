import { measurementIn, questionLabel } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import { standingDecisions } from "../progress.ts";
import { checkedPanel } from "./checks.ts";
import { clip } from "./shared.ts";

/**
 * The standing open questions' evidence gaps for the research workers' brief (goal 117): for each
 * question whose standing decision is open, what the reviewers who said open named as missing in
 * that decision's review. What only a measurement could settle is a next experiment, never work
 * for the workers, and what went wrong on the reviewers' side (an answer that failed code's check)
 * is the review panel's to fix: neither is passed on. Undefined when no question stands open with
 * an evidence gap.
 */
export function briefGaps(ledger: Ledger, run: string): string | undefined {
  const standing = standingDecisions(ledger, run);
  const lines: string[] = [];
  const reviews = new Set<number>();
  let measurements = 0;
  const open = [...standing.values()]
    .filter((d) => d.kind === "question" && d.decision === "open")
    .sort((a, b) => Number(a.key) - Number(b.key));
  for (const d of open) {
    const row = ledger.reviews.get(d.review);
    if (!row) continue;
    const index = Number(d.key);
    const gaps: string[] = [];
    for (const r of checkedPanel(row)) {
      const q = r.questions.find((x) => x.index === index);
      if (!q?.valid || q.verdict !== "open" || !q.gaps.trim()) continue;
      if (measurementIn(q.gaps)) {
        measurements++;
        continue;
      }
      gaps.push(clip(q.gaps, 300));
    }
    if (!gaps.length) continue;
    reviews.add(d.review);
    lines.push(`- ${questionLabel(index)} (review ${d.review}): ${[...new Set(gaps)].join(" / ")}`);
  }
  if (!lines.length) return undefined;
  const ids = [...reviews].sort((a, b) => a - b);
  return [
    `# What the review panel found missing (${ids.length === 1 ? "review" : "reviews"} ${ids.join(", ")})`,
    "The review panel decided these questions are still open, with gaps in the evidence. Their decision stands until new claims change the question's answer card: work on these gaps first. The reviewers' words, data to weigh:",
    ...lines,
    ...(measurements
      ? [
          `(${measurements === 1 ? "One more gap asks" : `${measurements} more gaps ask`} for a measurement: a next experiment for the report, not work for this run.)`,
        ]
      : []),
  ].join("\n");
}

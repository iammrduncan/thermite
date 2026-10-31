import type { ResearchContract } from "../../../core/contract.ts";
import { ANSWERED, PROGRESS_STOPPED, questionLabel } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import type { StandingDecision } from "../progress.ts";
import {
  type CheckedHypothesis,
  type CheckedQuestion,
  type CheckedReviewer,
  checkedPanel,
} from "./checks.ts";
import { type Dissent, decisionWords } from "./decide.ts";
import { researchReviewDue } from "./due.ts";
import { researchEnd } from "./end.ts";
import { itemsState, requiredHypotheses, researchReviews } from "./items.ts";
import { clip, listOf, questionsWords } from "./shared.ts";

/** A research run's reviews in its reports: the digest's line, and the final report's sections. */

/** Where the check stands, in one line for a digest (workers read it in REPORT.md). */
export function checkLine(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
): string {
  const h = (ms: number) => `${(ms / 3_600_000).toFixed(2)} h`;
  const end = researchEnd(ledger, run);
  const labels = (xs: number[]) => xs.map(questionLabel).join(", ");
  if (end?.reason === ANSWERED)
    return `Answer check: the review panel's decisions give every question an end and every required hypothesis a verdict (review ${String(end.review?.id)}); the run ends once its paper is in and its running trials end.`;
  if (end)
    return `Answer check: research stopped adding (the progress rule)${end.open.questions.length ? `; open: ${labels(end.open.questions)}` : ""}; the run ends once its paper is in and its running trials end.`;
  const reviews = researchReviews(ledger, run);
  const newest = reviews[0];
  if (newest && newest.panel_result === null)
    return `Answer check: the review panel checks review ${String(newest.id)}.`;
  if (newest?.panel_result === "review_passed" && newest.owner_decision === null)
    return `Answer check: the review panel's decisions give every question an end (review ${String(newest.id)}); it waits for the owner's acceptance.`;
  if (clock.elapsed_ms < clock.min_ms)
    return `Answer check: it starts after the minimum running time (${h(clock.elapsed_ms)} of ${h(clock.min_ms)}).`;
  const n = contract.questions.length;
  const { standing, open } = itemsState(ledger, run, n);
  const due = researchReviewDue(ledger, run, contract, clock);
  const next = due.due ? "the next digest asks the review panel" : due.why;
  if (newest?.owner_decision === "rejected")
    return `Answer check: the owner did not accept review ${String(newest.id)}; ${next}.`;
  if (!reviews.length) return `Answer check: ${due.due ? next : `waiting: ${next}`}.`;
  const ended = n - open.questions.length;
  const required = requiredHypotheses(ledger, run).length;
  const openWords = open.questions.map((i) => {
    const d = standing.get(`question:${i}`);
    return `${questionLabel(i)} (${d ? `open in review ${d.review}` : "no decision on its newest card"})`;
  });
  return `Answer check: not yet. ${ended} of ${n} questions have an end, and ${required - open.hypotheses.length} of ${required} required hypotheses a verdict${openWords.length ? `; open: ${clip(openWords.join(", "), 500)}` : ""}; ${next}.`;
}

/**
 * The final report's sections on the decisions (goals 112 and 117): how the run ended, then each
 * question's standing decision with the first answer of its majority, the claims it cites, how
 * many reviewers gave it and the dissent; then each required hypothesis's verdict, with why and
 * the dissent.
 */
export function answerSections(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  fence: (s: string) => string,
): string[] {
  const n = contract.questions.length;
  const end = researchEnd(ledger, run);
  const { standing, open } = itemsState(ledger, run, n);
  const one = (s: string) => fence(s).replace(/\n+/g, " ");
  const decisionRow = (d: StandingDecision) =>
    ledger.reviews.decision(run, d.kind, d.key, d.review);
  const panels = new Map<number, CheckedReviewer[]>();
  const panelOf = (review: number) => {
    if (!panels.has(review)) {
      const row = ledger.reviews.get(review);
      panels.set(review, row ? checkedPanel(row) : []);
    }
    return panels.get(review) ?? [];
  };
  const dissentLines = (d: StandingDecision) =>
    listOf<Dissent>(decisionRow(d)?.dissent).map(
      (x) =>
        `- Dissent: ${x.reviewer}: ${decisionWords({ decision: x.verdict, certainty: x.certainty })}${x.reasons ? `: ${one(x.reasons)}` : ""}`,
    );
  const head = !standing.size
    ? "The review panel decided no item of this run."
    : end?.reason === ANSWERED
      ? `The review panel's decisions give every question an end and every required hypothesis a verdict (review ${String(end.review?.id)})${String(end.review?.owner_note ?? "").startsWith("hands-off") ? "" : ", and the owner accepted them"}. Each decision is the verdict most reviewers gave whose answer passed the harness's check: its cited claims are verified claims of this run, and its numbers are in them.`
      : end?.reason === PROGRESS_STOPPED
        ? `Research stopped adding (the progress rule): ${end.open.questions.length ? `${questionsWords(end.open.questions)} stayed open` : "no question stayed open"}${end.open.hypotheses.length ? `, and ${end.open.hypotheses.length} required ${end.open.hypotheses.length === 1 ? "hypothesis has" : "hypotheses have"} no verdict` : ""}. Each decision below is the review panel's that still stands.`
        : `The run ended before the review panel's decisions gave every question an end: ${open.questions.length ? `${questionsWords(open.questions)} stayed open` : "every question has an end"}. Each decision below is the review panel's that still stands.`;
  const lines = ["## The review panel's decisions", head, ""];
  contract.questions.forEach((text, i) => {
    lines.push(`### ${i + 1}. ${one(text)}`, "");
    const d = standing.get(`question:${i}`);
    if (!d) {
      lines.push("No decision stands: the review panel did not decide it on its newest card.", "");
      return;
    }
    const row = decisionRow(d);
    const panel = panelOf(d.review);
    const answers = panel
      .map((r) => r.questions.find((q) => q.index === i))
      .filter((q): q is CheckedQuestion => q?.valid === true && q.verdict === d.decision);
    const first = answers[0];
    lines.push(
      `Decision: ${decisionWords(d)} (review ${d.review}, card version ${d.card_version ?? "none"}; ${answers.length} of ${panel.length} reviewers).`,
      "",
    );
    if (first && d.decision !== "open") {
      lines.push(fence(first.answer), "");
      if (first.claims.length) lines.push(`Cites: ${first.claims.join(", ")}.`, "");
      if (first.next_experiments.trim())
        lines.push(`Next experiments: ${one(first.next_experiments)}`, "");
    } else if (d.decision === "open") {
      const gaps = [...new Set(answers.map((q) => clip(q.gaps, 400)).filter(Boolean))];
      lines.push(
        gaps.length
          ? `Evidence gaps: ${one(gaps.join(" / "))}`
          : `Open: ${listOf<Dissent>(row?.dissent).length ? "the reviewers' verdicts tied" : "no answer passed the check"}.`,
        "",
      );
    }
    const dissent = dissentLines(d);
    if (dissent.length) lines.push(...dissent, "");
  });
  const hypotheses = requiredHypotheses(ledger, run);
  lines.push("## Hypotheses: the review panel's verdicts");
  if (!hypotheses.length) lines.push("The run has no hypothesis that needs a verdict.");
  for (const h of hypotheses) {
    const d = standing.get(`hypothesis:${h.id}`);
    if (!d) {
      lines.push(`- ${one(h.text)} (${h.id}): no verdict yet.`);
      continue;
    }
    const panel = panelOf(d.review);
    const verdicts = panel
      .map((r) => r.hypotheses.find((x) => x.id === h.id))
      .filter((v): v is CheckedHypothesis => v?.valid === true && v.verdict === d.decision);
    const first = verdicts[0];
    lines.push(
      `- ${one(h.text)} (${h.id}): ${d.decision} (review ${d.review}; ${verdicts.length} of ${panel.length} reviewers).${first ? ` Why: ${one(first.why)}${first.claims.length ? ` Cites: ${first.claims.join(", ")}.` : ""}` : ""}`,
      ...dissentLines(d).map((x) => `  ${x}`),
    );
  }
  lines.push("");
  return lines;
}

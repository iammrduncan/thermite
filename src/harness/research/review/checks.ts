import type {
  AnswerCertainty,
  HypothesisDecision,
  QuestionDecision,
  ResearchVerdicts,
} from "../../../core/api/harness/research.ts";
import { questionName } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import { checkCited } from "../checks.ts";
import { type ResearchPackage, toDecide } from "./package.ts";
import { clip, type Row } from "./shared.ts";

/** Each reviewer's answers to a research review, checked by code, and kept as checked. */

/** One reviewer's answer to a question, with the harness's check. */
export interface CheckedQuestion {
  index: number;
  /** The card version it decided on; null when the package showed no card. */
  card_version: number | null;
  /** What the reviewer said; null: no answer. */
  verdict: QuestionDecision | null;
  /** For answered only. */
  certainty: AnswerCertainty | null;
  answer: string;
  claims: string[];
  /** The evidence gaps it names (open). */
  gaps: string;
  /** What only a measurement could settle (insufficient, and answered when it names some). */
  next_experiments: string;
  /** The answer passed the check: it counts in the decision. */
  valid: boolean;
  problems: string[];
}

/** One reviewer's verdict on a hypothesis, with the harness's check. */
export interface CheckedHypothesis {
  id: string;
  verdict: HypothesisDecision | null;
  why: string;
  claims: string[];
  valid: boolean;
  problems: string[];
}

/** One reviewer's research review, as the harness checked and keeps it. */
export interface CheckedReviewer {
  reviewer: string;
  /** The reviewer's own pass or fail: kept, it decides nothing (the items' decisions do). */
  said_pass: boolean;
  reasons: string;
  /** Its answers to the questions to decide, as checked. */
  questions: CheckedQuestion[];
  /** Its verdicts on the hypotheses to decide, as checked. */
  hypotheses: CheckedHypothesis[];
}

/**
 * Each reviewer's answers to the items to decide, checked by code. A question's answer counts
 * only when it passes: answered needs its certainty (high, moderate or low), words and at least
 * one cited claim; insufficient needs its best answer and what is missing in next_experiments;
 * open needs the evidence gaps it names. Every cited id must be a verified claim of the run, and
 * every number in an answered or insufficient answer must be in the claims it cites. A supported
 * or refuted verdict needs at least one cited claim and the same check of its why; an undecided
 * one needs its why. An item a reviewer gave no answer counts as no answer.
 */
export function checkResearchPanel(
  ledger: Ledger,
  run: string,
  pkg: Partial<Pick<ResearchPackage, "decide">> & {
    questions?: { index: number; card?: { version: number } | null }[];
    hypotheses?: { id: string }[];
  },
  results: {
    reviewer: string;
    pass: boolean;
    reasons: string;
    research?: ResearchVerdicts | undefined;
  }[],
): CheckedReviewer[] {
  const items = toDecide(pkg);
  const version = (i: number) => pkg.questions?.find((q) => q.index === i)?.card?.version ?? null;
  return results.map((r) => {
    const said = r.research ?? { questions: [], hypotheses: [] };
    const questions = items.questions.map((index): CheckedQuestion => {
      const a = said.questions.find((x) => x.index === index);
      const base = { index, card_version: version(index) };
      if (!a)
        return {
          ...base,
          verdict: null,
          certainty: null,
          answer: "",
          claims: [],
          gaps: "",
          next_experiments: "",
          valid: false,
          problems: ["the reviewer gave no answer to this question"],
        };
      const problems: string[] = [];
      const claims = [...new Set(a.claims)];
      if (a.verdict === "answered") {
        if (!a.certainty)
          problems.push("an answered verdict needs its certainty: high, moderate or low");
        if (!a.answer.trim()) problems.push("the answer is empty");
        if (!claims.length) problems.push("the answer cites no claim");
        problems.push(...checkCited(ledger, run, claims, [a.answer]).problems);
      } else if (a.verdict === "insufficient") {
        if (!a.answer.trim()) problems.push("an insufficient verdict needs the best answer");
        if (!a.next_experiments.trim())
          problems.push(
            "an insufficient verdict names what is missing, which only a measurement could settle, in next_experiments",
          );
        problems.push(...checkCited(ledger, run, claims, [a.answer]).problems);
      } else {
        if (!a.gaps.trim()) problems.push("an open verdict names the evidence gaps");
        // Claims it names must still be the run's verified claims; its words are not an answer.
        problems.push(...checkCited(ledger, run, claims, []).problems);
      }
      return {
        ...base,
        verdict: a.verdict,
        certainty: a.verdict === "answered" ? a.certainty : null,
        answer: a.answer.slice(0, 8000),
        claims,
        gaps: a.gaps.slice(0, 4000),
        next_experiments: a.next_experiments.slice(0, 4000),
        valid: problems.length === 0,
        problems,
      };
    });
    const hypotheses = items.hypotheses.map((id): CheckedHypothesis => {
      const v = said.hypotheses.find((x) => x.id === id);
      if (!v)
        return {
          id,
          verdict: null,
          why: "",
          claims: [],
          valid: false,
          problems: ["the reviewer gave no verdict on this hypothesis"],
        };
      const problems: string[] = [];
      if (v.verdict === "undecided") {
        if (!v.why.trim()) problems.push("an undecided verdict needs its why");
        problems.push(...checkCited(ledger, run, v.claims, []).problems);
      } else {
        if (!v.claims.length) problems.push(`a ${v.verdict} verdict cites no claim`);
        problems.push(...checkCited(ledger, run, v.claims, [v.why]).problems);
      }
      return {
        id,
        verdict: v.verdict,
        why: v.why.slice(0, 4000),
        claims: [...new Set(v.claims)],
        valid: problems.length === 0,
        problems,
      };
    });
    return {
      reviewer: r.reviewer,
      said_pass: r.pass,
      reasons: r.reasons.slice(0, 4000),
      questions,
      hypotheses,
    };
  });
}

/**
 * What one reviewer found open or could not get past the check, a line each, in plain words.
 * Questions are named for people, "Question 1" (the journal), or with `questionLabel` where agents
 * read it too ("Question 1 (index 0)": the digest's line in REPORT.md).
 */
export function reviewerGaps(
  r: CheckedReviewer,
  n = 300,
  name: (index: number) => string = questionName,
): string[] {
  const out: string[] = [];
  for (const q of r.questions) {
    if (q.valid && q.verdict !== "open") continue;
    if (q.valid) out.push(`${name(q.index)}: open: ${clip(q.gaps, n)}`);
    else if (q.verdict)
      out.push(
        `${name(q.index)}: the ${q.verdict} verdict did not pass the check (${clip(q.problems.join("; "), n)})`,
      );
    else out.push(`${name(q.index)}: no answer`);
  }
  for (const h of r.hypotheses) {
    if (h.valid) continue;
    out.push(
      `Hypothesis ${h.id}: ${h.verdict ? `the ${h.verdict} verdict did not pass the check (${clip(h.problems.join("; "), n)})` : "no verdict"}`,
    );
  }
  return out;
}

/** A review's checked results, as stored in its panel column. */
export function checkedPanel(row: Row): CheckedReviewer[] {
  if (row.panel === null || row.panel === undefined) return [];
  try {
    const xs = JSON.parse(String(row.panel)) as unknown;
    return Array.isArray(xs)
      ? (xs as Partial<CheckedReviewer>[]).map((r) => ({
          reviewer: String(r.reviewer ?? ""),
          said_pass: r.said_pass === true,
          reasons: String(r.reasons ?? ""),
          questions: Array.isArray(r.questions) ? r.questions : [],
          hypotheses: Array.isArray(r.hypotheses) ? r.hypotheses : [],
        }))
      : [];
  } catch {
    return [];
  }
}

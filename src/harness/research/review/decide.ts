import type {
  AnswerCertainty,
  HypothesisDecision,
  QuestionDecision,
} from "../../../core/api/harness/research.ts";
import type { CheckedQuestion, CheckedReviewer } from "./checks.ts";
import { type ResearchPackage, toDecide } from "./package.ts";
import { clip } from "./shared.ts";

/** The review panel's decision on each item, from its reviewers' checked answers. */

/** The most characters of each reviewer's reasons for an item in its event; the table keeps more. */
export const ITEM_REASONS_EVENT = 1000;
export const ITEM_REASONS_MAX = 12_000;
/** The most characters of a dissent's reasons. */
export const DISSENT_REASONS = 300;

/** A dissent from an item's decision: a reviewer whose answer passed the check, with another verdict. */
export interface Dissent {
  reviewer: string;
  verdict: string;
  certainty: string | null;
  reasons: string;
}

/** The panel's decision on one item. */
export interface ItemDecision {
  kind: "question" | "hypothesis";
  key: string;
  card_version: number | null;
  decision: QuestionDecision | HypothesisDecision;
  certainty: AnswerCertainty | null;
  /**
   * The reviewers who gave the decision's verdict with an answer that passed the check (with no
   * majority, decided as open or undecided, those who said so, if any).
   */
  majority: string[];
  /** How many reviewers' answers passed the check. */
  counted: number;
  /** Why it is open or undecided when no verdict won: no majority, or no answer that passed. */
  why?: "no majority" | "no answer passed the check";
  dissent: Dissent[];
}

/** A question's answer as one text: the answer, then its evidence gaps and next experiments. */
export function questionReasons(q: Pick<CheckedQuestion, "answer" | "gaps" | "next_experiments">) {
  return [
    q.answer.trim(),
    q.gaps.trim() ? `Evidence gaps: ${q.gaps.trim()}` : "",
    q.next_experiments.trim() ? `Next experiments: ${q.next_experiments.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const CERTAINTY_ORDER: AnswerCertainty[] = ["low", "moderate", "high"];

/** The median of certainties: the middle one, or the lower of the two middle ones. */
export function medianCertainty(xs: AnswerCertainty[]): AnswerCertainty | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => CERTAINTY_ORDER.indexOf(a) - CERTAINTY_ORDER.indexOf(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** The verdict more than half of the voters gave; undefined with no such majority or no voter. */
function winner(verdicts: string[]): string | undefined {
  const tally = new Map<string, number>();
  for (const v of verdicts) tally.set(v, (tally.get(v) ?? 0) + 1);
  for (const [v, n] of tally) if (n * 2 > verdicts.length) return v;
  return undefined;
}

/**
 * The panel's decision on each item it was asked to decide, from the reviewers' checked answers:
 * the verdict that more than half of the reviewers whose answer passed the check gave (the owner's
 * "a majority"); for an answered question, the median of their certainties. No such majority, or
 * no answer that passed, is open (a hypothesis: undecided). Every reviewer whose answer passed with another verdict than the
 * decision is a dissent, with its verdict, certainty and short reasons.
 */
export function decideItems(
  pkg: Partial<Pick<ResearchPackage, "decide">> & {
    questions?: { index: number; card?: { version: number } | null }[];
    hypotheses?: { id: string }[];
  },
  checked: CheckedReviewer[],
): ItemDecision[] {
  const items = toDecide(pkg);
  const version = (i: number) => pkg.questions?.find((q) => q.index === i)?.card?.version ?? null;
  const out: ItemDecision[] = [];
  for (const index of items.questions) {
    const votes = checked.flatMap((r) => {
      const q = r.questions.find((x) => x.index === index);
      return q?.valid && q.verdict ? [{ reviewer: r.reviewer, q }] : [];
    });
    const won = winner(votes.map((v) => String(v.q.verdict))) as QuestionDecision | undefined;
    const decision: QuestionDecision = won ?? "open";
    const majority = votes.filter((v) => v.q.verdict === decision);
    out.push({
      kind: "question",
      key: String(index),
      card_version: version(index),
      decision,
      certainty:
        decision === "answered"
          ? medianCertainty(majority.flatMap((v) => (v.q.certainty ? [v.q.certainty] : [])))
          : null,
      majority: majority.map((v) => v.reviewer),
      counted: votes.length,
      ...(won
        ? {}
        : {
            why: votes.length ? ("no majority" as const) : ("no answer passed the check" as const),
          }),
      dissent: votes
        .filter((v) => v.q.verdict !== decision)
        .map((v) => ({
          reviewer: v.reviewer,
          verdict: String(v.q.verdict),
          certainty: v.q.certainty,
          reasons: clip(questionReasons(v.q), DISSENT_REASONS),
        })),
    });
  }
  for (const id of items.hypotheses) {
    const votes = checked.flatMap((r) => {
      const h = r.hypotheses.find((x) => x.id === id);
      return h?.valid && h.verdict ? [{ reviewer: r.reviewer, h }] : [];
    });
    const won = winner(votes.map((v) => String(v.h.verdict))) as HypothesisDecision | undefined;
    const decision: HypothesisDecision = won ?? "undecided";
    out.push({
      kind: "hypothesis",
      key: id,
      card_version: null,
      decision,
      certainty: null,
      majority: votes.filter((v) => v.h.verdict === decision).map((v) => v.reviewer),
      counted: votes.length,
      ...(won
        ? {}
        : {
            why: votes.length ? ("no majority" as const) : ("no answer passed the check" as const),
          }),
      dissent: votes
        .filter((v) => v.h.verdict !== decision)
        .map((v) => ({
          reviewer: v.reviewer,
          verdict: String(v.h.verdict),
          certainty: null,
          reasons: clip(v.h.why, DISSENT_REASONS),
        })),
    });
  }
  return out;
}

/** A decision in words, for people: "answered, certainty high", "insufficient", "open". */
export function decisionWords(d: { decision: string; certainty: string | null }): string {
  if (d.decision === "answered") return `answered, certainty ${d.certainty ?? "unknown"}`;
  if (d.decision === "insufficient") return "insufficient (the best answer sources allow)";
  return d.decision;
}

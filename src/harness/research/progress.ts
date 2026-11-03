import { PROGRESS_SHARE, SATURATION_TASKS } from "../../core/research-check.ts";
import type { Ledger } from "../ledger/index.ts";
import type { TaskYield } from "../queue.ts";

/**
 * Where a research run stands with its items (goal 117): the panel's standing decision on each
 * question and each required hypothesis, whether each question is saturated, and when the run
 * last improved. The review (part B2), the plan (part B1) and the end rules read these; nothing
 * here writes. The rule's limits are in core/research-check.ts.
 */

/**
 * How good a decision is, to tell an improvement: for a question, open 0, insufficient 1,
 * answered at low 2, moderate 3, high 4; for a hypothesis, undecided 0, supported or refuted 1.
 */
export function decisionRank(
  kind: "question" | "hypothesis",
  decision: string,
  certainty?: string | null,
): number {
  if (kind === "hypothesis") return decision === "supported" || decision === "refuted" ? 1 : 0;
  if (decision === "insufficient") return 1;
  if (decision !== "answered") return 0;
  return certainty === "high" ? 4 : certainty === "moderate" ? 3 : 2;
}

/** A card's certainty as a rank, to tell an improvement: none 0 … high 4. */
export function certaintyRank(certainty: string): number {
  return { none: 0, insufficient: 1, low: 2, moderate: 3, high: 4 }[certainty] ?? 0;
}

export interface StandingDecision {
  kind: "question" | "hypothesis";
  key: string;
  decision: string;
  certainty: string | null;
  review: number;
  card_version: number | null;
  decided_at: string;
}

/**
 * The panel's decisions that still stand, by `kind:key`: the newest decision of each item, unless
 * it is a question's and the question has a newer card than the one it decided on. A question
 * with a newer card is an item to review again.
 */
export function standingDecisions(ledger: Ledger, run: string): Map<string, StandingDecision> {
  const cards = ledger.cards.newestVersions(run);
  const out = new Map<string, StandingDecision>();
  for (const d of ledger.reviews.newestDecisions(run)) {
    if (d.kind === "question" && (cards.get(Number(d.key)) ?? 0) > (d.card_version ?? 0)) continue;
    out.set(`${d.kind}:${d.key}`, {
      kind: d.kind,
      key: d.key,
      decision: d.decision,
      certainty: d.certainty,
      review: d.review,
      card_version: d.card_version,
      decided_at: d.decided_at,
    });
  }
  return out;
}

/** Whether a question has an end: a standing decision of answered or insufficient. */
export function questionEnded(d: StandingDecision | undefined): boolean {
  return d !== undefined && (d.decision === "answered" || d.decision === "insufficient");
}

/**
 * Whether a question is saturated: its last SATURATION_TASKS finished tasks added no verified
 * claim from a new registrable domain, and its card's certainty did not rise while they ran. A
 * card rewritten at the same certainty is no progress, as for the last improvement: the
 * synthesizer rewrites a card each round its claims change, so a card that only changed would
 * keep a question from saturating, and its run from ending, for good. Fewer tasks than that:
 * not saturated.
 */
export function questionSaturated(ledger: Ledger, run: string, question: number): boolean {
  const tasks = ledger.experiments.yields(run, question, SATURATION_TASKS);
  if (tasks.length < SATURATION_TASKS) return false;
  for (const t of tasks) {
    let y: TaskYield | undefined;
    try {
      y = JSON.parse(t.yield) as TaskYield;
    } catch {
      return false;
    }
    if ((y.by_question ?? []).some((b) => b.question === question && b.new_domain_claims > 0))
      return false;
  }
  const since = tasks.reduce(
    (a, t) => (t.created_at < a ? t.created_at : a),
    tasks[0]?.created_at ?? "",
  );
  let before = 0;
  for (const c of ledger.cards.history(run, question)) {
    const rank = certaintyRank(c.certainty);
    if (c.created_at >= since && rank > before) return false;
    before = rank;
  }
  return true;
}

/**
 * When the run last improved: the newest decision that ranked above the item's decision before
 * it (an item's first decision counts when it is better than nothing), or the newest card whose
 * certainty ranked above the question's previous card. Null: never.
 */
export function lastImprovement(ledger: Ledger, run: string): string | null {
  let last: string | null = null;
  const later = (at: string) => {
    if (last === null || at > last) last = at;
  };
  const before = new Map<string, number>();
  for (const d of ledger.reviews.decisions(run)) {
    const k = `${d.kind}:${d.key}`;
    const rank = decisionRank(d.kind, d.decision, d.certainty);
    if (rank > (before.get(k) ?? 0)) later(d.decided_at);
    before.set(k, rank);
  }
  const card = new Map<number, number>();
  for (const c of ledger.cards.versions(run)) {
    const rank = certaintyRank(c.certainty);
    if (rank > (card.get(c.question) ?? 0)) later(c.created_at);
    card.set(c.question, rank);
  }
  return last;
}

/**
 * The progress rule (goal 117, the owner's words): a run whose open questions are all saturated,
 * and which has improved no item for a quarter of its running time (and for at least a quarter of
 * its minimum), has stopped adding. `clock` is the run's research clock, read now and as it stood
 * at a moment. Open: the questions with no end.
 */
export function progressStopped(
  ledger: Ledger,
  run: string,
  questions: number,
  clock: (at?: number) => { elapsed_ms: number; min_ms: number },
): { stopped: boolean; open: number[]; since_ms: number; needed_ms: number } {
  const standing = standingDecisions(ledger, run);
  const open = Array.from({ length: questions }, (_, i) => i).filter(
    (i) => !questionEnded(standing.get(`question:${i}`)),
  );
  const now = clock();
  const last = lastImprovement(ledger, run);
  const at = last === null ? 0 : now.elapsed_ms - clock(Date.parse(last)).elapsed_ms;
  const since = last === null ? now.elapsed_ms : at;
  const needed = Math.max(PROGRESS_SHARE * now.elapsed_ms, PROGRESS_SHARE * now.min_ms);
  const stopped =
    now.elapsed_ms >= now.min_ms &&
    open.every((q) => questionSaturated(ledger, run, q)) &&
    since >= needed;
  return { stopped, open, since_ms: since, needed_ms: needed };
}

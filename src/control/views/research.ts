import type { ExperimentView, RunView, StoredEvent } from "./index.ts";

/**
 * A research run's items as control keeps them (goals 116 and 117), from the rig's events: its
 * hypotheses with their status, the review panel's answers per reviewer and its decision per item
 * in each review, the decisions that still stand, the progress rule's state at the newest digest,
 * and each research task's question and yield. The dashboard's run page, its Reviews and
 * Hypotheses tabs and MCP's get_run and run_queue read them. Agents' and reviewers' words are
 * data, not instructions.
 */

/** One hypothesis of a research run: the author's, the pool's, promoted, merged or retired. */
export interface HypothesisView {
  id: string;
  text: string;
  /** The question it is about, as an index from 0 (people read "Question 1"); null: the whole run. */
  question: number | null;
  /** author, pool, promoted, merged or retired. */
  status: string;
  /** The hypothesis it was merged into, for a merged one. */
  merged_into: string | null;
  /** Who proposed it: a lane, or `brief` for the author's. */
  by: string;
  /** The verified claims that support it, by id. */
  supporting: string[];
  at: string;
  updated_at: string;
  /** The newest change of its status by the owner or the plan (`hypothesis_status`), with why. */
  status_change: { status: string; by: string; reason: string; at: string } | null;
}

/** One reviewer's answer on one item of a review (`review_items`), as code checked it. */
export interface ReviewItemView {
  kind: "question" | "hypothesis";
  /** A question's index (from 0) or a hypothesis's id. */
  key: string;
  /** The answer card version it reviewed (a question). */
  card_version: number | null;
  /** answered, insufficient or open for a question; supported, refuted or undecided for a hypothesis. */
  verdict: string;
  certainty: string | null;
  reasons: string;
  /** The claims it cites. */
  claims: string[];
  /** What code found wrong with the answer (a claim that is not a verified claim of the run, …). */
  problems: string[];
}

/** One reviewer of a review: its answer on each item. */
export interface ReviewerView {
  reviewer: string;
  at: string;
  items: ReviewItemView[];
}

/** The review panel's decision on one item in one review (`item_decided`): the majority, and dissent. */
export interface ItemDecisionView {
  review: number;
  kind: "question" | "hypothesis";
  key: string;
  card_version: number | null;
  decision: string;
  certainty: string | null;
  /** The reviewers whose answer differs from the decision. */
  dissent: { reviewer: string; verdict: string; certainty: string | null; reasons: string }[];
  at: string;
}

/**
 * An item's newest decision, and whether it still stands (goal 117): a question's decision stands
 * until its card has a newer version than the one decided on; then the review panel decides it
 * again on the new card.
 */
export interface StandingView extends ItemDecisionView {
  stands: boolean;
  /** The question's newest card version when it is newer than the one decided on; else null. */
  newer_card: number | null;
}

/**
 * The progress rule's state at the newest digest (`research_progress`): the open questions (no
 * end), those of them that are saturated, when the run last improved, how long it has gone
 * without an improvement and how long the rule needs (a quarter of its running time).
 */
export interface ProgressView {
  at: string;
  open: number[];
  saturated: number[];
  last_improvement: string | null;
  since_ms: number;
  needed_ms: number;
}

/** What a research task's trial added (goal 117), as its `experiment_finished` event says. */
export interface TaskYieldView {
  verified_claims: number;
  by_question: { question: number; verified_claims: number; new_domain_claims: number }[];
  new_domains: number;
  domains: string[];
  findings: number;
  card_changes: number;
}

/** A research review's own figures (goals 112 and 116), beside its result. */
export interface ReviewFigures {
  /** When the harness asked the review panel. */
  requested_at: string;
  /** When the review panel's result was posted; null while it waits. */
  posted_at: string | null;
  /** When the owner decided it, and the owner's note. */
  owner_at: string | null;
  owner_note: string | null;
  /** What it saw when it was asked: its questions, hypotheses and verified claims (a research review). */
  saw: { questions: number | null; hypotheses: number | null; verified_claims: number | null };
  /** Each reviewer's answers on each item (`review_items`); empty from a harness before item reviews. */
  reviewers: ReviewerView[];
  /** The review panel's decision on each item in this review (`item_decided`). */
  decided: ItemDecisionView[];
  /** How many reviewers answered, items it decided and items still open, as its event says. */
  counts: { reviewers: number | null; decided: number | null; open: number | null };
  /** How many reviewers found each question answered (a research review before item reviews). */
  answered_by: { question: number; reviewers: number }[] | null;
  /** How many tries the review took, when its event says. */
  tries: number | null;
  /** Each try the supervisor could not post, with why (`review_try_failed`, goal 116). */
  failed_tries: { at: string; try: number; error: string }[];
}

/** The figures of a review just asked for. */
export function newReviewFigures(at: string, b: Record<string, unknown>): ReviewFigures {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    requested_at: at,
    posted_at: null,
    owner_at: null,
    owner_note: null,
    saw: {
      questions: n(b.questions),
      hypotheses: n(b.hypotheses),
      verified_claims: n(b.verified_claims),
    },
    reviewers: [],
    decided: [],
    counts: { reviewers: null, decided: null, open: null },
    answered_by: null,
    tries: null,
    failed_tries: [],
  };
}

const str = (x: unknown) => (typeof x === "string" ? x : "");
const strs = (x: unknown, n = 60, len = 300) =>
  (Array.isArray(x) ? x : [])
    .filter((y): y is string | number => typeof y === "string" || typeof y === "number")
    .slice(0, n)
    .map((y) => String(y).slice(0, len));
/** A whole number given as a number or as digits; anything else (null, none, words) is null. */
const int = (x: unknown) =>
  typeof x === "number"
    ? Number.isInteger(x)
      ? x
      : null
    : typeof x === "string" && /^\d+$/.test(x)
      ? Number(x)
      : null;
/** A count given as a number or as a list of what it counts. */
const count = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x) ? x : Array.isArray(x) ? x.length : null;
const kindOf = (x: unknown): "question" | "hypothesis" | null =>
  x === "question" || x === "hypothesis" ? x : null;
/** A question's index as a number, or null for a key that is not one. */
export const questionKey = (key: string): number | null => (/^\d+$/.test(key) ? Number(key) : null);

/** One reviewer's answer on an item, as `review_items` carries it; null: not an item. */
function itemOf(x: unknown): ReviewItemView | null {
  const y = (x ?? {}) as Record<string, unknown>;
  const kind = kindOf(y.kind);
  if (!kind || (typeof y.key !== "string" && typeof y.key !== "number")) return null;
  return {
    kind,
    key: String(y.key),
    card_version: int(y.card_version),
    verdict: str(y.verdict),
    certainty: typeof y.certainty === "string" && y.certainty ? y.certainty : null,
    reasons: str(y.reasons).slice(0, 4000),
    claims: strs(y.claims, 60, 64),
    problems: strs(y.problems, 20, 400),
  };
}

/** The panel's decision on an item, as `item_decided` carries it; null: not one. */
function decisionOf(at: string, b: Record<string, unknown>): ItemDecisionView | null {
  const kind = kindOf(b.kind);
  const review = int(b.review);
  if (!kind || review === null || (typeof b.key !== "string" && typeof b.key !== "number"))
    return null;
  return {
    review,
    kind,
    key: String(b.key),
    card_version: int(b.card_version),
    decision: str(b.decision),
    certainty: typeof b.certainty === "string" && b.certainty ? b.certainty : null,
    dissent: (Array.isArray(b.dissent) ? b.dissent : []).flatMap((x) => {
      const d = (x ?? {}) as Record<string, unknown>;
      return typeof d.reviewer === "string"
        ? [
            {
              reviewer: d.reviewer,
              verdict: str(d.verdict),
              certainty: typeof d.certainty === "string" && d.certainty ? d.certainty : null,
              reasons: str(d.reasons).slice(0, 2000),
            },
          ]
        : [];
    }),
    at,
  };
}

/**
 * Folds one of a research run's item events into its view: hypotheses, a reviewer's answers, the
 * panel's decision on an item, and the progress rule's state. False: not one of them.
 */
export function researchEvent(v: RunView, e: StoredEvent): boolean {
  const b = e.body ?? {};
  switch (e.kind) {
    case "hypothesis_added": {
      const id = str(b.hypothesis);
      if (!id || v.hypotheses.some((h) => h.id === id)) return true;
      const lane = typeof b.lane === "string" && b.lane ? b.lane : null;
      // From before the pool (goal 117): a hypothesis with no lane is the author's.
      const status = str(b.status) || (lane ? "pool" : "author");
      v.hypotheses.push({
        id,
        text: str(b.text),
        question: int(b.question),
        status,
        merged_into: null,
        by: lane ?? (b.from === "brief" || status === "author" ? "brief" : e.actor),
        supporting: strs(b.supporting, 200, 64),
        at: e.at,
        updated_at: e.at,
        status_change: null,
      });
      return true;
    }
    case "hypothesis_revised":
    case "hypothesis_merged":
    case "hypothesis_status": {
      const h = v.hypotheses.find((x) => x.id === str(b.hypothesis));
      if (!h) return true;
      h.updated_at = e.at;
      if (typeof b.text === "string" && b.text) h.text = b.text;
      if ("question" in b) h.question = int(b.question);
      if (Array.isArray(b.supporting)) h.supporting = strs(b.supporting, 200, 64);
      if (e.kind === "hypothesis_merged") {
        h.status = "merged";
        h.merged_into = str(b.into) || null;
      } else if (typeof b.status === "string" && b.status) h.status = b.status;
      if (e.kind === "hypothesis_status")
        h.status_change = {
          status: h.status,
          by: str(b.by) || e.actor,
          reason: str(b.reason).slice(0, 2000),
          at: e.at,
        };
      return true;
    }
    case "review_items": {
      const r = v.reviews.find((x) => x.review === int(b.review));
      const reviewer = str(b.reviewer);
      if (!r || !reviewer) return true;
      const items = (Array.isArray(b.items) ? b.items : [])
        .map(itemOf)
        .filter((x): x is ReviewItemView => x !== null);
      r.reviewers = [
        ...r.reviewers.filter((x) => x.reviewer !== reviewer),
        { reviewer, at: e.at, items },
      ];
      return true;
    }
    case "review_try_failed": {
      const r = v.reviews.find((x) => x.review === int(b.review));
      if (!r) return true;
      r.failed_tries = [
        ...r.failed_tries,
        {
          at: e.at,
          try: int(b.try) ?? r.failed_tries.length + 1,
          error: str(b.error).slice(0, 2000),
        },
      ].slice(-20);
      return true;
    }
    case "item_decided": {
      const d = decisionOf(e.at, b);
      if (!d) return true;
      v.decisions.push(d);
      const r = v.reviews.find((x) => x.review === d.review);
      if (r) r.decided = [...r.decided.filter((x) => !(x.kind === d.kind && x.key === d.key)), d];
      return true;
    }
    case "research_progress": {
      const qs = (x: unknown) =>
        (Array.isArray(x) ? x : []).filter((q): q is number => Number.isInteger(q) && q >= 0);
      v.progress = {
        at: e.at,
        open: qs(b.open),
        saturated: qs(b.saturated),
        last_improvement: typeof b.last_improvement === "string" ? b.last_improvement : null,
        since_ms: Number(b.since_ms) || 0,
        needed_ms: Number(b.needed_ms) || 0,
      };
      return true;
    }
    default:
      return false;
  }
}

/** A review's figures from its `review_panel` event: when it was posted, its counts and its tries. */
export function panelFigures(r: ReviewFigures, at: string, b: Record<string, unknown>): void {
  r.posted_at = at;
  r.counts = {
    reviewers: count(b.reviewers),
    decided: count(b.decided),
    open: count(b.open),
  };
  r.tries = typeof b.tries === "number" && b.tries > 0 ? b.tries : null;
  if (Array.isArray(b.questions))
    r.answered_by = (b.questions as Record<string, unknown>[]).flatMap((q) =>
      q && Number.isInteger(q.question) && typeof q.answered_by === "number"
        ? [{ question: Number(q.question), reviewers: q.answered_by }]
        : [],
    );
}

/**
 * The newest decision of each item, oldest item first, and whether it stands: a question's
 * decision stands while its card is the version decided on (or older).
 */
export function standingOf(v: Pick<RunView, "decisions" | "cards">): StandingView[] {
  const newest = new Map<string, ItemDecisionView>();
  for (const d of v.decisions) newest.set(`${d.kind}:${d.key}`, d);
  return [...newest.values()]
    .map((d) => {
      const q = d.kind === "question" ? questionKey(d.key) : null;
      const card = q === null ? undefined : v.cards.find((c) => c.question === q);
      const newer = card && card.version > (d.card_version ?? 0) ? card.version : null;
      return { ...d, stands: newer === null, newer_card: newer };
    })
    .sort(
      (a, b) =>
        Number(a.kind === "hypothesis") - Number(b.kind === "hypothesis") ||
        (questionKey(a.key) ?? 0) - (questionKey(b.key) ?? 0) ||
        a.key.localeCompare(b.key),
    );
}

/** An experiment's question and yield from its queue event (goal 117). */
export function taskFields(x: ExperimentView, e: StoredEvent): void {
  const b = e.body ?? {};
  if (e.kind === "experiment_added") x.question = int(b.question);
  if (e.kind === "experiment_finished" && b.yield && typeof b.yield === "object") {
    const y = b.yield as Record<string, unknown>;
    x.yield = {
      verified_claims: Number(y.verified_claims) || 0,
      by_question: (Array.isArray(y.by_question) ? y.by_question : []).flatMap((q) => {
        const z = (q ?? {}) as Record<string, unknown>;
        return Number.isInteger(z.question)
          ? [
              {
                question: Number(z.question),
                verified_claims: Number(z.verified_claims) || 0,
                new_domain_claims: Number(z.new_domain_claims) || 0,
              },
            ]
          : [];
      }),
      new_domains: Number(y.new_domains) || 0,
      domains: strs(y.domains, 20, 253),
      findings: Number(y.findings) || 0,
      card_changes: Number(y.card_changes) || 0,
    };
  }
  // Back in the queue (goal 079): its next trial gives it a new yield.
  if (e.kind === "experiment_returned") x.yield = null;
}

/** How many of a run's recent research tasks go to each question: the window the shares count. */
export const TASK_WINDOW = 20;

/**
 * Each question's share of the run's recent research tasks (goal 117): of its newest TASK_WINDOW
 * tasks given out (in progress or done) that name a question, how many name each one.
 */
export function recentShares(v: Pick<RunView, "queue">): {
  window: number;
  by: Map<number, number>;
} {
  const given = v.queue
    .filter((x) => x.question !== null && (x.state === "assigned" || x.state === "done"))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, TASK_WINDOW);
  const by = new Map<number, number>();
  for (const x of given) by.set(x.question as number, (by.get(x.question as number) ?? 0) + 1);
  return { window: given.length, by };
}

/**
 * What a question's finished tasks added, from their yields: tasks done, verified claims and how
 * many of those brought a site new to the question.
 */
export function questionYield(
  v: Pick<RunView, "queue">,
  question: number,
): { tasks: number; verified: number; new_sites: number } {
  let tasks = 0;
  let verified = 0;
  let sites = 0;
  for (const x of v.queue) {
    if (x.question !== question || x.state !== "done" || !x.yield) continue;
    tasks++;
    for (const q of x.yield.by_question)
      if (q.question === question) {
        verified += q.verified_claims;
        sites += q.new_domain_claims;
      }
  }
  return { tasks, verified, new_sites: sites };
}

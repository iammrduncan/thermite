import type { GoalContract } from "../core/contract.ts";
import { ITEM_DECIDED, questionName, REVIEW_ITEMS } from "../core/research-check.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";
import {
  type CheckedReviewer,
  decideItems,
  ITEM_REASONS_EVENT,
  ITEM_REASONS_MAX,
  type ItemDecision,
  itemsState,
  questionReasons,
  RESEARCH_REVIEW,
  type ResearchPackage,
} from "./research/index.ts";

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Subjective goals (verify type `review`). The champion's artifact goes to the supervisor's
 * model panel as a package: the goal, its criteria and the change from the seed, with nothing
 * about which lane or model wrote it. A pass is recorded as review_passed, and needs an
 * acceptance to make the goal met: the harness's, hands-off by default (goal 079, the owner's
 * decision of 2026-10-22), or the owner's where the run asks (`ask_owner.reviews`). A panel of
 * at least two reviewers, every one passing it, and the judge's other checks stay.
 *
 * Reviews are per champion commit: a new champion needs a new review.
 *
 * A research run's review (goal 112, research/review.ts) is a row here too, with the reserved goal
 * name `research` and a marker of the evidence it saw in place of a commit. It is given only to a
 * supervisor that asks for research reviews, so a supervisor from before it never gets one.
 */

type Row = Record<string, unknown>;

/** At least this many reviewers on the review panel, all passing, for review_passed. */
export const MIN_PANEL = 2;

export interface ReviewPackage {
  id: number;
  run: string;
  goal: string;
  description: string;
  criteria: string[];
  deliverable: string;
  insufficient: string[];
  commit: string;
  diff: string;
  requested_at: string;
}

/** A research review as the review panel gets it (goal 112): the run's evidence, no lane or model. */
export type ResearchReviewPackage = ResearchPackage & {
  id: number;
  run: string;
  requested_at: string;
};

/** The kinds of review a supervisor may ask for: goal reviews, and research reviews (goal 112). */
export type ReviewKind = "goal" | "research";

export class Reviews {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  get(run: string, goal: string, commit: string): Row | undefined {
    return this.ledger.reviews.forCommit(run, goal, commit);
  }

  /** Requests a review of a champion for a goal (once per commit). Returns its id. */
  request(input: {
    run: string;
    goal: string;
    attempt: string | null;
    commit: string;
    contract: GoalContract;
    diff: string;
    by: string;
  }): number {
    const existing = this.get(input.run, input.goal, input.commit);
    if (existing) return Number(existing.id);
    const g = input.contract.goals.find((x) => x.id === input.goal);
    if (g?.verify.type !== "review")
      throw new LedgerError("invalid", `${input.goal} is not a review goal`);
    const pkg = {
      goal: g.id,
      description: g.description,
      criteria: g.verify.criteria,
      deliverable: input.contract.deliverable,
      insufficient: input.contract.insufficient,
      // Capped: a reviewer reads the change, not a whole repository.
      diff: input.diff.slice(0, 200_000),
    };
    return this.ledger.tx(() => {
      const id = this.ledger.reviews.add({
        run: input.run,
        goal: input.goal,
        attempt: input.attempt,
        commit: input.commit,
        pkg,
        at: new Date().toISOString(),
      });
      this.ledger.appendEvent(input.by, "review_requested", input.run, {
        review: id,
        goal: input.goal,
        commit: input.commit,
      });
      return id;
    });
  }

  byId(id: number): Row | undefined {
    return this.ledger.reviews.get(id);
  }

  /**
   * Requests a research review of a run (goal 112): once for each marker of the evidence it saw
   * (research/review.ts decides when). Returns its id.
   */
  requestResearch(input: {
    run: string;
    marker: string;
    pkg: ResearchPackage;
    by: string;
  }): number {
    const existing = this.get(input.run, RESEARCH_REVIEW, input.marker);
    if (existing) return Number(existing.id);
    return this.ledger.tx(() => {
      const id = this.ledger.reviews.add({
        run: input.run,
        goal: RESEARCH_REVIEW,
        attempt: null,
        commit: input.marker,
        pkg: input.pkg,
        at: new Date().toISOString(),
      });
      this.ledger.appendEvent(input.by, "review_requested", input.run, {
        review: id,
        goal: RESEARCH_REVIEW,
        commit: input.marker,
        questions: input.pkg.questions.length,
        hypotheses: input.pkg.hypotheses.length,
        verified_claims: input.pkg.corpus.verified_claims,
      });
      return id;
    });
  }

  /**
   * Reviews waiting for the panel, as packages (no lane, model or attempt id in them): goal
   * reviews, and research reviews only when asked for (goal 112), so a supervisor from before
   * them never gets one it cannot answer.
   */
  pending(): ReviewPackage[];
  pending(kinds: readonly ReviewKind[]): (ReviewPackage | ResearchReviewPackage)[];
  pending(kinds: readonly ReviewKind[] = ["goal"]): (ReviewPackage | ResearchReviewPackage)[] {
    return this.ledger.reviews
      .awaitingPanel()
      .filter((r) => kinds.includes(r.goal === RESEARCH_REVIEW ? "research" : "goal"))
      .map((r): ReviewPackage | ResearchReviewPackage => {
        if (r.goal === RESEARCH_REVIEW)
          return {
            ...(JSON.parse(String(r.package)) as ResearchPackage),
            id: Number(r.id),
            run: String(r.run),
            requested_at: String(r.requested_at),
          };
        const pkg = JSON.parse(String(r.package)) as Omit<
          ReviewPackage,
          "id" | "run" | "commit" | "requested_at"
        >;
        return {
          ...pkg,
          id: Number(r.id),
          run: String(r.run),
          commit: String(r.commit_sha),
          requested_at: String(r.requested_at),
        };
      });
  }

  /** At least MIN_PANEL reviewers, each once. */
  private static panelSize(reviewers: string[]): void {
    if (reviewers.length < MIN_PANEL) {
      throw new LedgerError("invalid", `the review panel needs at least ${MIN_PANEL} reviewers`);
    }
    if (new Set(reviewers).size !== reviewers.length) {
      throw new LedgerError("invalid", "each reviewer counts once");
    }
  }

  /** A review the panel may still decide: it exists, is undecided, and its run is running. */
  private undecided(id: number): Row {
    const row = this.byId(id);
    if (!row) throw new LedgerError("not_found", `no review ${id}`);
    if (row.panel_result !== null)
      throw new LedgerError("conflict", `review ${id} is already decided`);
    const inst = this.ledger.runs.get(String(row.run));
    if (inst?.status !== "running")
      throw new LedgerError("invalid", `run ${String(row.run)} is not running`);
    return row;
  }

  /**
   * A research review's results (goals 112 and 117), as code checked them (research/review.ts),
   * written once. Each reviewer's checked answer to each item it was asked to decide is a
   * `review_item` row, and each item's decision (research/review.ts decideItems) an
   * `item_decision` row. The review passes when, after it, every question has an end (a standing
   * decision of answered or insufficient) and every required hypothesis an end (hypothesis-evidence.ts).
   * Events: `review_items` for each reviewer, `item_decided` for each item, and `review_panel`
   * with how many reviewers gave each question an end, the open questions' gaps, how many items
   * it decided and the questions still open.
   */
  recordResearchPanel(
    id: number,
    checked: CheckedReviewer[],
    by: string,
  ): {
    result: "review_passed" | "review_failed";
    decided: ItemDecision[];
    open: { questions: number[]; hypotheses: string[] };
  } {
    Reviews.panelSize(checked.map((r) => r.reviewer));
    return this.ledger.tx(() => {
      const row = this.undecided(id);
      if (row.goal !== RESEARCH_REVIEW)
        throw new LedgerError("invalid", `review ${id} is not a research review`);
      const run = String(row.run);
      const pkg = JSON.parse(String(row.package)) as ResearchPackage;
      const decided = decideItems(pkg, checked);
      const now = new Date().toISOString();
      for (const r of checked) {
        const items = [
          ...r.questions.map((q) => ({
            kind: "question" as const,
            key: String(q.index),
            card_version: q.card_version,
            verdict: q.verdict ?? "none",
            certainty: q.certainty,
            reasons: questionReasons(q),
            claims: q.claims,
            problems: q.problems,
          })),
          ...r.hypotheses.map((h) => ({
            kind: "hypothesis" as const,
            key: h.id,
            card_version: null,
            verdict: h.verdict ?? "none",
            certainty: null,
            reasons: h.why,
            claims: h.claims,
            problems: h.problems,
          })),
        ];
        this.ledger.reviews.addItems(
          id,
          r.reviewer,
          items.map((it) => ({ ...it, reasons: it.reasons.slice(0, ITEM_REASONS_MAX) })),
          now,
        );
        this.ledger.appendEvent(by, REVIEW_ITEMS, run, {
          review: id,
          reviewer: r.reviewer,
          items: items.map((it) => ({
            ...it,
            reasons: clip(it.reasons, ITEM_REASONS_EVENT),
          })),
        });
      }
      this.ledger.reviews.addDecisions(run, id, decided, now);
      for (const d of decided) {
        this.ledger.appendEvent(by, ITEM_DECIDED, run, {
          review: id,
          kind: d.kind,
          key: d.key,
          card_version: d.card_version,
          decision: d.decision,
          certainty: d.certainty,
          dissent: d.dissent,
        });
      }
      const { open } = itemsState(this.ledger, run, pkg.questions.length);
      const outcome =
        open.questions.length === 0 && open.hypotheses.length === 0
          ? "review_passed"
          : "review_failed";
      this.ledger.reviews.setPanel(id, checked, outcome, now);
      // Each question decided here: how many reviewers gave it an end, and the first answer of
      // its majority, short: what the owner reads before accepting, and what the knowledge base
      // keeps. The gaps: what the reviewers who said open named, for each question decided open.
      const questions = decided.filter((d) => d.kind === "question");
      const answerOf = (d: ItemDecision) =>
        d.decision === "open"
          ? undefined
          : checked
              .map((r) => r.questions.find((q) => String(q.index) === d.key))
              .find((q) => q?.valid && q.verdict === d.decision);
      const gaps = [
        ...new Set(
          decided.flatMap((d) => {
            if (d.kind === "hypothesis")
              return d.decision === "undecided" && d.why
                ? [`Hypothesis ${d.key}: undecided (${d.why})`]
                : [];
            if (d.decision !== "open") return [];
            const name = questionName(Number(d.key));
            const said = checked.flatMap((r) => {
              const q = r.questions.find((x) => String(x.index) === d.key);
              return q?.valid && q.verdict === "open" && q.gaps.trim() ? [clip(q.gaps, 200)] : [];
            });
            return said.length
              ? said.map((g) => `${name}: ${g}`)
              : [`${name}: open (${d.why ?? "open"})`];
          }),
        ),
      ];
      this.ledger.appendEvent(by, "review_panel", run, {
        review: id,
        goal: row.goal,
        result: outcome,
        reviewers: checked.length,
        questions: questions.map((d) => {
          const first = answerOf(d);
          return {
            question: Number(d.key),
            answered_by: checked.filter((r) =>
              r.questions.some(
                (q) =>
                  String(q.index) === d.key &&
                  q.valid &&
                  (q.verdict === "answered" || q.verdict === "insufficient"),
              ),
            ).length,
            decision: d.decision,
            certainty: d.certainty,
            ...(first
              ? { answer: first.answer.slice(0, 500), claims: first.claims.slice(0, 10) }
              : {}),
          };
        }),
        gaps: gaps.slice(0, 20),
        ...(gaps.length > 20 ? { more_gaps: gaps.length - 20 } : {}),
        decided: decided.length,
        open: open.questions,
      });
      return { result: outcome, decided, open };
    });
  }

  /** The panel's results, written once: review_passed only if every reviewer passes it. */
  recordPanel(
    id: number,
    results: { reviewer: string; pass: boolean; reasons: string }[],
    by: string,
  ): "review_passed" | "review_failed" {
    Reviews.panelSize(results.map((r) => r.reviewer));
    const outcome = results.every((r) => r.pass) ? "review_passed" : "review_failed";
    this.ledger.tx(() => {
      const row = this.undecided(id);
      if (row.goal === RESEARCH_REVIEW)
        throw new LedgerError(
          "invalid",
          `review ${id} is a research review: it is recorded with each reviewer's answers`,
        );
      // Only for a running campaign's current champion: a stale review is not recorded.
      if (this.ledger.champions.current(String(row.run)).commit_sha !== String(row.commit_sha))
        throw new LedgerError(
          "stale",
          `review ${id} is of a commit that is no longer the champion`,
        );
      this.ledger.reviews.setPanel(
        id,
        results.map((r) => ({ ...r, reasons: r.reasons.slice(0, 4000) })),
        outcome,
        new Date().toISOString(),
      );
      this.ledger.appendEvent(by, "review_panel", String(row.run), {
        review: id,
        goal: row.goal,
        result: outcome,
        reviewers: results.length,
      });
    });
    return outcome;
  }

  /** The owner's final word on a goal (or a research run's answers) the panel passed. */
  ownerDecision(
    id: number,
    run: string,
    accept: boolean,
    note: string | undefined,
    by: string,
  ): Row {
    return this.ledger.tx(() => {
      const row = this.ledger.reviews.get(id);
      if (!row || String(row.run) !== run)
        throw new LedgerError("not_found", `no review ${id} in ${run}`);
      if (row.panel_result !== "review_passed")
        throw new LedgerError("invalid", `review ${id} has not passed the review panel`);
      if (row.owner_decision !== null)
        throw new LedgerError("conflict", `review ${id} is already decided`);
      const decision = accept ? "accepted" : "rejected";
      this.ledger.reviews.setOwnerDecision(
        id,
        decision,
        note?.slice(0, 2000) ?? null,
        new Date().toISOString(),
      );
      this.ledger.appendEvent(by, "review_decided", run, {
        review: id,
        goal: row.goal,
        decision,
        ...(note?.trim() ? { note: note.slice(0, 2000) } : {}),
      });
      return row;
    });
  }

  /** A review goal's status for a commit: met only with the owner's acceptance. */
  status(
    run: string,
    goal: string,
    commit: string,
  ): { status: "met" | "unmet" | "not_runnable"; reasons: string } {
    const r = this.get(run, goal, commit);
    if (!r) return { status: "not_runnable", reasons: "no review requested for this commit" };
    if (r.owner_decision === "accepted")
      return {
        status: "met",
        reasons: String(r.owner_note ?? "").startsWith("hands-off")
          ? "the review panel passed it, and it was accepted with no owner step"
          : "the review panel passed it and the owner accepted it",
      };
    if (r.owner_decision === "rejected")
      return { status: "unmet", reasons: "the owner did not accept it" };
    if (r.panel_result === "review_failed")
      return { status: "unmet", reasons: "the review panel did not pass it" };
    if (r.panel_result === "review_passed")
      return {
        status: "not_runnable",
        reasons: "review_passed: waiting for the owner's acceptance",
      };
    return { status: "not_runnable", reasons: "waiting for the review panel" };
  }
}

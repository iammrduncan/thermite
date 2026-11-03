import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** A panel's decision on an item of a run as its row holds it; its dissent is JSON, as stored. */
export interface DecisionRow {
  id: number;
  run: string;
  kind: "question" | "hypothesis";
  key: string;
  review: number;
  card_version: number | null;
  decision: string;
  certainty: string | null;
  dissent: string;
  decided_at: string;
}

function toDecision(r: Row): DecisionRow {
  return {
    id: Number(r.id),
    run: String(r.run),
    kind: String(r.kind) as DecisionRow["kind"],
    key: String(r.key),
    review: Number(r.review),
    card_version: r.card_version === null ? null : Number(r.card_version),
    decision: String(r.decision),
    certainty: r.certainty === null ? null : String(r.certainty),
    dissent: String(r.dissent),
    decided_at: String(r.decided_at),
  };
}

/** A reviewer's checked answer on one item, as a review records it. */
export interface ReviewItemInput {
  kind: "question" | "hypothesis";
  key: string;
  card_version: number | null;
  verdict: string;
  certainty: string | null;
  reasons: string;
  claims: readonly string[];
  problems: readonly string[];
}

/** An item's decision from a review, as it is recorded. */
export interface DecisionInput {
  kind: "question" | "hypothesis";
  key: string;
  card_version: number | null;
  decision: string;
  certainty: string | null;
  dissent: unknown;
}

/**
 * The `review`, `review_item` and `item_decision` tables: the reviews the panel is asked for (of a
 * goal at a champion commit, or of a research run's evidence), each reviewer's checked answer on
 * each item of a research review, and the panel's decision on each item (append-only).
 */
export class LedgerReviews extends LedgerPart {
  /** A review, requested at `at`: its id. */
  add(r: {
    run: string;
    goal: string;
    attempt: string | null;
    commit: string;
    pkg: unknown;
    at: string;
  }): number {
    return this.execute(
      "insert into review (run, goal, attempt, commit_sha, package, requested_at) values (?, ?, ?, ?, ?, ?)",
      r.run,
      r.goal,
      r.attempt,
      r.commit,
      canonicalJson(r.pkg),
      r.at,
    ).id;
  }

  get(id: number): Row | undefined {
    return this.row<Row>("select * from review where id = ?", id);
  }

  /** The run's review of a goal at a commit (a research review: at its marker), if any. */
  forCommit(run: string, goal: string, commit: string): Row | undefined {
    return this.row<Row>(
      "select * from review where run = ? and goal = ? and commit_sha = ?",
      run,
      goal,
      commit,
    );
  }

  /** The run's reviews of a goal, the newest first. */
  ofGoal(run: string, goal: string): Row[] {
    return this.rows<Row>(
      "select * from review where run = ? and goal = ? order by id desc",
      run,
      goal,
    );
  }

  /** The reviews the panel has not decided, of running runs, oldest first. */
  awaitingPanel(): Row[] {
    return this.rows<Row>(
      `select r.* from review r join run i on i.id = r.run
           where r.panel_result is null and i.status = 'running' order by r.id`,
    );
  }

  /** The panel's results and its outcome, at `at`. */
  setPanel(id: number, panel: unknown, result: string, at: string): void {
    this.execute(
      "update review set panel = ?, panel_result = ?, panel_at = ? where id = ?",
      canonicalJson(panel),
      result,
      at,
      id,
    );
  }

  /** The owner's decision on a review the panel passed, at `at`. */
  setOwnerDecision(id: number, decision: string, note: string | null, at: string): void {
    this.execute(
      "update review set owner_decision = ?, owner_note = ?, owner_at = ? where id = ?",
      decision,
      note,
      at,
      id,
    );
  }

  /** A reviewer's checked answers on a review's items, recorded at `at`. */
  addItems(review: number, reviewer: string, items: readonly ReviewItemInput[], at: string): void {
    const add = this.db.prepare(
      "insert into review_item (review, reviewer, kind, key, card_version, verdict, certainty, reasons, claims, problems, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const it of items)
      add.run(
        review,
        reviewer,
        it.kind,
        it.key,
        it.card_version,
        it.verdict,
        it.certainty,
        it.reasons,
        JSON.stringify(it.claims),
        JSON.stringify(it.problems),
        at,
      );
  }

  /**
   * The reviewers' verdicts on the run's hypotheses that passed the check (a verdict, no problems),
   * each with the claims it cites, as stored JSON.
   */
  hypothesisCitations(run: string): { key: string; claims: string }[] {
    return this.rows<Row>(
      `select i.key as key, i.claims as claims from review_item i join review r on r.id = i.review
         where r.run = ? and i.kind = 'hypothesis' and i.verdict != 'none' and i.problems = '[]'`,
      run,
    ).map((r) => ({ key: String(r.key), claims: String(r.claims) }));
  }

  /** The decisions a review made on the run's items, recorded at `at`. */
  addDecisions(run: string, review: number, decided: readonly DecisionInput[], at: string): void {
    const add = this.db.prepare(
      "insert into item_decision (run, kind, key, review, card_version, decision, certainty, dissent, decided_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const d of decided)
      add.run(
        run,
        d.kind,
        d.key,
        review,
        d.card_version,
        d.decision,
        d.certainty,
        JSON.stringify(d.dissent),
        at,
      );
  }

  /** The run's decisions on its items, oldest first. */
  decisions(run: string): DecisionRow[] {
    return this.rows<Row>("select * from item_decision where run = ? order by id", run).map(
      toDecision,
    );
  }

  /** The newest decision on each of the run's items. */
  newestDecisions(run: string): DecisionRow[] {
    return this.rows<Row>(
      `select d.* from item_decision d
         join (select kind, key, max(id) as id from item_decision where run = ? group by kind, key) n
           on n.id = d.id`,
      run,
    ).map(toDecision);
  }

  /** The newest decision a review made on an item of the run, if it made one. */
  decision(run: string, kind: string, key: string, review: number): DecisionRow | undefined {
    const r = this.row<Row>(
      "select * from item_decision where run = ? and kind = ? and key = ? and review = ? order by id desc limit 1",
      run,
      kind,
      key,
      review,
    );
    return r ? toDecision(r) : undefined;
  }
}

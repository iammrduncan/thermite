import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** A hypothesis as its row holds it; its supporting claims are JSON, as stored. */
export interface HypothesisRow {
  id: string;
  run: string;
  lane: string | null;
  text: string;
  supporting: string;
  question: number | null;
  status: string;
  merged_into: string | null;
  created_at: string;
  updated_at: string | null;
}

const textOrNull = (v: unknown) => (v === null ? null : String(v));

function toHypothesis(r: Row): HypothesisRow {
  return {
    id: String(r.id),
    run: String(r.run),
    lane: textOrNull(r.lane),
    text: String(r.text),
    supporting: String(r.supporting),
    question: r.question === null ? null : Number(r.question),
    status: String(r.status),
    merged_into: textOrNull(r.merged_into),
    created_at: String(r.created_at),
    updated_at: textOrNull(r.updated_at),
  };
}

/**
 * The `hypothesis` table: each run's hypotheses, the author's from the campaign's brief and the
 * workers' pool, with their status, their question and the verified claims behind them.
 */
export class LedgerHypotheses extends LedgerPart {
  /** A hypothesis, recorded now: the author's (no lane) or one for the pool. */
  add(h: {
    id: string;
    run: string;
    lane: string | null;
    question: number | null;
    text: string;
    supporting: readonly string[];
    status: "author" | "pool";
  }): void {
    const now = this.now();
    this.execute(
      "insert into hypothesis (id, run, lane, question, text, supporting, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      h.id,
      h.run,
      h.lane,
      h.question,
      h.text,
      canonicalJson(h.supporting),
      h.status,
      now,
      now,
    );
  }

  get(run: string, id: string): HypothesisRow | undefined {
    const r = this.row<Row>("select * from hypothesis where run = ? and id = ?", run, id);
    return r ? toHypothesis(r) : undefined;
  }

  /** The run's hypotheses, oldest first. */
  list(run: string): HypothesisRow[] {
    return this.rows<Row>(
      "select * from hypothesis where run = ? order by created_at, rowid",
      run,
    ).map(toHypothesis);
  }

  /** The run's hypotheses, in no set order. */
  ofRun(run: string): HypothesisRow[] {
    return this.rows<Row>("select * from hypothesis where run = ?", run).map(toHypothesis);
  }

  /** The run's hypotheses with one of these statuses, oldest first. */
  withStatus(run: string, statuses: readonly string[]): HypothesisRow[] {
    return this.rows<Row>(
      `select * from hypothesis where run = ? and status in (${statuses.map(() => "?").join(", ")}) order by created_at, rowid`,
      run,
      ...statuses,
    ).map(toHypothesis);
  }

  /**
   * The run's hypotheses, those that need a verdict first: the author's, then promoted ones, the
   * pool, and the rest; each oldest first.
   */
  byStatus(run: string): HypothesisRow[] {
    return this.rows<Row>(
      "select * from hypothesis where run = ? order by case status when 'author' then 0 when 'promoted' then 1 when 'pool' then 2 else 3 end, created_at, rowid",
      run,
    ).map(toHypothesis);
  }

  /** One page of the run's hypotheses, the newest first. */
  page(run: string, limit: number, offset: number): HypothesisRow[] {
    return this.rows<Row>(
      "select * from hypothesis where run = ? order by created_at desc, id desc limit ? offset ?",
      run,
      limit,
      offset,
    ).map(toHypothesis);
  }

  /** How many hypotheses the run has. */
  count(run: string): number {
    const r = this.row<Row>("select count(*) as n from hypothesis where run = ?", run);
    return Number(r?.n ?? 0);
  }

  setStatus(id: string, status: string): void {
    this.execute(
      "update hypothesis set status = ?, updated_at = ? where id = ?",
      status,
      this.now(),
      id,
    );
  }

  /** A hypothesis's new text, question and supporting claims. */
  revise(id: string, h: { text: string; question: number | null; supporting: string[] }): void {
    this.execute(
      "update hypothesis set text = ?, question = ?, supporting = ?, updated_at = ? where id = ?",
      h.text,
      h.question,
      canonicalJson(h.supporting),
      this.now(),
      id,
    );
  }

  /** A hypothesis revised into the words of another (`into`): merged into it. */
  merge(
    id: string,
    h: { text: string; question: number | null; supporting: string[] },
    into: string,
  ): void {
    this.execute(
      "update hypothesis set text = ?, question = ?, supporting = ?, status = 'merged', merged_into = ?, updated_at = ? where id = ?",
      h.text,
      h.question,
      canonicalJson(h.supporting),
      into,
      this.now(),
      id,
    );
  }
}

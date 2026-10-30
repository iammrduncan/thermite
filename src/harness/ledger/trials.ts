import { canonicalJson, sha256Hex } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** A family's standing in the direction registry. */
export type FamilyStatus = "live" | "blocked" | "exhausted";

/** Who planned an epoch: the planner, or the rules in code. */
export type EpochSource = "planner" | "fallback";

/** A trial as its row holds it, without its token's hash. */
export interface TrialRow {
  id: string;
  run: string;
  lane: string;
  epoch: number;
  family: string | null;
  parent_commit: string;
  attempt: string | null;
  stopped: string | null;
  turns: number | null;
  tool_calls: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

/** An open trial with its run's mode, and the title and question of its experiment. */
export interface OpenTrialRow {
  id: string;
  run: string;
  lane: string;
  started_at: string;
  turns: number | null;
  tool_calls: number | null;
  tokens_in: number | null;
  mode: string | null;
  title: string | null;
  question: number | null;
}

const textOrNull = (v: unknown) => (v === null ? null : String(v));
const numberOrNull = (v: unknown) => (v === null ? null : Number(v));

function toTrial(r: Row): TrialRow {
  return {
    id: String(r.id),
    run: String(r.run),
    lane: String(r.lane),
    epoch: Number(r.epoch),
    family: textOrNull(r.family),
    parent_commit: String(r.parent_commit),
    attempt: textOrNull(r.attempt),
    stopped: textOrNull(r.stopped),
    turns: numberOrNull(r.turns),
    tool_calls: numberOrNull(r.tool_calls),
    tokens_in: numberOrNull(r.tokens_in),
    tokens_out: numberOrNull(r.tokens_out),
    error: textOrNull(r.error),
    started_at: String(r.started_at),
    ended_at: textOrNull(r.ended_at),
  };
}

const TRIAL_COLS = `id, run, lane, epoch, family, parent_commit, attempt, stopped, turns, tool_calls,
  tokens_in, tokens_out, error, started_at, ended_at`;

/**
 * Ledger migration 26: the tokens the model proxy saw in the provider's answers to a trial's calls,
 * for a trial whose program reaches its provider through the proxy (OpenCode, Codex). Null for
 * any other trial, whose own counters count.
 */
export const TRIAL_PROXY_TOKENS = `
alter table trial add column proxy_tokens_in integer;
alter table trial add column proxy_tokens_out integer;
`;

/**
 * The `trial`, `lane`, `epoch` and `family` tables: the workers' trials, each lane's retained
 * best, the planner's epochs and the direction registry's families.
 */
export class LedgerTrials extends LedgerPart {
  /** A new trial. Only its token's hash is stored. */
  startTrial(t: {
    id: string;
    run: string;
    lane: string;
    epoch: number;
    family: string;
    parent: string;
    token?: string | undefined;
  }): void {
    this.execute(
      "insert into trial (id, run, lane, epoch, family, parent_commit, token_sha, started_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      t.id,
      t.run,
      t.lane,
      t.epoch,
      t.family,
      t.parent,
      t.token ? sha256Hex(t.token) : null,
      this.now(),
    );
  }

  get(id: string): TrialRow | undefined {
    const r = this.row<Row>(`select ${TRIAL_COLS} from trial where id = ?`, id);
    return r ? toTrial(r) : undefined;
  }

  /** The trial a worker's token belongs to, ended or not. */
  byToken(token: string): TrialRow | undefined {
    const r = this.row<Row>(
      `select ${TRIAL_COLS} from trial where token_sha = ?`,
      sha256Hex(token),
    );
    return r ? toTrial(r) : undefined;
  }

  /** Links a submission to its trial, unless the trial has one: whether it did. */
  linkAttempt(trial: string, attempt: string): boolean {
    return (
      this.execute("update trial set attempt = ? where id = ? and attempt is null", attempt, trial)
        .changes > 0
    );
  }

  /** The counters a running trial's worker reports; an ended trial keeps its own. */
  setCounters(
    id: string,
    c: { turns: number; tool_calls: number; tokens_in: number; tokens_out: number },
  ): void {
    this.execute(
      "update trial set turns = ?, tool_calls = ?, tokens_in = ?, tokens_out = ? where id = ? and ended_at is null",
      c.turns,
      c.tool_calls,
      c.tokens_in,
      c.tokens_out,
      id,
    );
  }

  /** Ends a trial: how it stopped, its counters, and its submission if it had none yet. */
  finishTrial(
    id: string,
    r: {
      attempt?: string | undefined;
      stopped: string;
      turns: number;
      toolCalls: number;
      tokensIn: number;
      tokensOut: number;
      error?: string | undefined;
    },
  ): void {
    this.execute(
      `update trial set attempt = coalesce(attempt, ?), stopped = ?, turns = ?, tool_calls = ?, tokens_in = ?,
         tokens_out = ?, error = ?, ended_at = ? where id = ?`,
      r.attempt ?? null,
      r.stopped,
      r.turns,
      r.toolCalls,
      r.tokensIn,
      r.tokensOut,
      r.error?.slice(0, 1000) ?? null,
      this.now(),
      id,
    );
  }

  /** The trials that have not ended. */
  open(): TrialRow[] {
    return this.rows<Row>(`select ${TRIAL_COLS} from trial where ended_at is null`).map(toTrial);
  }

  /** How many trials have not ended. */
  countOpen(): number {
    const r = this.row<Row>("select count(*) as n from trial where ended_at is null");
    return Number(r?.n ?? 0);
  }

  /** The first `limit` open trials, oldest first, with their run's mode and their experiment. */
  openWithTasks(limit: number): OpenTrialRow[] {
    return this.rows<OpenTrialRow>(
      `select t.id, t.run, t.lane, t.started_at, t.turns, t.tool_calls, t.tokens_in,
         r.mode, x.title, x.question
       from trial t left join run r on r.id = t.run
         left join experiment x on x.trial = t.id
       where t.ended_at is null order by t.started_at limit ?`,
      limit,
    );
  }

  /** A run's newest finished trials (on one lane, when given), the newest first. */
  recent(
    run: string,
    lane: string | null,
    n: number,
  ): { stopped: string; attempt: string | null; ended_at: string; error: string | null }[] {
    const rows = lane
      ? this.rows<Row>(
          "select stopped, attempt, ended_at, error from trial where run = ? and lane = ? and ended_at is not null order by ended_at desc limit ?",
          run,
          lane,
          n,
        )
      : this.rows<Row>(
          "select stopped, attempt, ended_at, error from trial where run = ? and ended_at is not null order by ended_at desc limit ?",
          run,
          n,
        );
    return rows.map((r) => ({
      stopped: String(r.stopped),
      attempt: textOrNull(r.attempt),
      ended_at: String(r.ended_at),
      error: textOrNull(r.error),
    }));
  }

  /** A lane's trials in an epoch (finished or running), oldest first. */
  ofLane(
    run: string,
    lane: string,
    epoch: number,
  ): { id: string; attempt: string | null; ended: boolean }[] {
    return this.rows<Row>(
      "select id, attempt, ended_at from trial where run = ? and lane = ? and epoch = ? order by started_at",
      run,
      lane,
      epoch,
    ).map((r) => ({
      id: String(r.id),
      attempt: textOrNull(r.attempt),
      ended: r.ended_at !== null,
    }));
  }

  /** A lane's newest trial, if it had one. */
  lastOfLane(run: string, lane: string): TrialRow | undefined {
    const r = this.row<Row>(
      `select ${TRIAL_COLS} from trial where run = ? and lane = ? order by started_at desc limit 1`,
      run,
      lane,
    );
    return r ? toTrial(r) : undefined;
  }

  /**
   * A trial whose program reaches its provider through the model proxy: from now on, its tokens are
   * those the proxy sees in the provider's answers (proxySaw), whatever its program reports.
   */
  countByProxy(id: string): void {
    this.execute(
      `update trial set proxy_tokens_in = coalesce(proxy_tokens_in, 0),
         proxy_tokens_out = coalesce(proxy_tokens_out, 0) where id = ?`,
      id,
    );
  }

  /** The tokens one of the provider's answers to a trial's call reported, as the proxy saw it. */
  proxySaw(id: string, t: { in: number; out: number }): void {
    this.execute(
      `update trial set proxy_tokens_in = coalesce(proxy_tokens_in, 0) + ?,
         proxy_tokens_out = coalesce(proxy_tokens_out, 0) + ? where id = ?`,
      t.in,
      t.out,
      id,
    );
  }

  /**
   * The tokens a run's trials used: what the model proxy saw of a trial through it, else what the
   * trial reported.
   */
  tokens(run: string): { in: number; out: number } {
    const r = this.row<Row>(
      `select coalesce(sum(coalesce(proxy_tokens_in, tokens_in)), 0) as i,
         coalesce(sum(coalesce(proxy_tokens_out, tokens_out)), 0) as o from trial where run = ?`,
      run,
    );
    return { in: Number(r?.i ?? 0), out: Number(r?.o ?? 0) };
  }

  // Each lane's retained best.

  /** The names of a run's lanes that have a row (one whose best was ever set). */
  lanes(run: string): string[] {
    return this.rows<Row>("select id from lane where run = ?", run).map((r) =>
      String(r.id).slice(run.length + 1),
    );
  }

  /** The attempt a lane keeps as its best, if any. */
  laneBest(run: string, lane: string): string | null {
    const r = this.row<Row>("select lane_best_attempt from lane where id = ?", `${run}:${lane}`);
    return r?.lane_best_attempt ? String(r.lane_best_attempt) : null;
  }

  setLaneBest(run: string, lane: string, attempt: string): void {
    this.execute(
      `insert into lane (id, run, lane_best_attempt, created_at) values (?, ?, ?, ?)
       on conflict (id) do update set lane_best_attempt = excluded.lane_best_attempt`,
      `${run}:${lane}`,
      run,
      attempt,
      this.now(),
    );
  }

  /** Clears a lane's best: whether it had one. */
  clearLaneBest(run: string, lane: string): boolean {
    return (
      this.execute(
        "update lane set lane_best_attempt = null where id = ? and lane_best_attempt is not null",
        `${run}:${lane}`,
      ).changes > 0
    );
  }

  // The planner's epochs.

  /** A run's newest `limit` epochs as stored, the newest first. */
  newestEpochs(run: string, limit: number): Row[] {
    return this.rows<Row>("select * from epoch where run = ? order by n desc limit ?", run, limit);
  }

  /** Whether the run has an epoch numbered `n`. */
  hasEpoch(run: string, n: number): boolean {
    return this.row<Row>("select 1 from epoch where n = ? and run = ?", n, run) !== undefined;
  }

  startEpoch(e: {
    run: string;
    n: number;
    source: EpochSource;
    tries: number;
    valid: boolean;
    rawViolations: string[];
    assignments: readonly unknown[];
    directives?: number[] | undefined;
    notes?: string | undefined;
  }): void {
    this.execute(
      `insert into epoch (run, n, source, planner_tries, planner_valid, raw_violations, assignments, directives, notes, started_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.run,
      e.n,
      e.source,
      e.tries,
      e.valid ? 1 : 0,
      canonicalJson(e.rawViolations),
      canonicalJson(e.assignments),
      canonicalJson(e.directives ?? []),
      e.notes?.slice(0, 2000) ?? null,
      this.now(),
    );
  }

  /** Ends an epoch, unless it has ended. */
  endEpoch(run: string, n: number): void {
    this.execute(
      "update epoch set ended_at = ? where run = ? and n = ? and ended_at is null",
      this.now(),
      run,
      n,
    );
  }

  // The direction registry's families.

  /** Adds a family to a run's registry, unless the run has it: whether it did. */
  addFamily(run: string, id: string, description: string, by: string): boolean {
    return (
      this.execute(
        "insert or ignore into family (run, id, description, created_by, created_at) values (?, ?, ?, ?, ?)",
        run,
        id,
        description.slice(0, 500),
        by,
        this.now(),
      ).changes > 0
    );
  }

  /** Sets a family's status; with `from`, only when it has that one. Whether it changed. */
  setFamilyStatus(run: string, id: string, status: FamilyStatus, from?: FamilyStatus): boolean {
    const r =
      from === undefined
        ? this.execute("update family set status = ? where run = ? and id = ?", status, run, id)
        : this.execute(
            "update family set status = ? where run = ? and id = ? and status = ?",
            status,
            run,
            id,
            from,
          );
    return r.changes > 0;
  }

  /** A run's families with their status, oldest first. */
  families(run: string): { id: string; description: string; status: FamilyStatus }[] {
    return this.rows<Row>(
      "select id, description, status from family where run = ? order by created_at",
      run,
    ).map((f) => ({
      id: String(f.id),
      description: String(f.description),
      status: String(f.status) as FamilyStatus,
    }));
  }

  /** A run's families and what each tries, in no set order. */
  familyDescriptions(run: string): { id: string; description: string }[] {
    return this.rows<Row>("select id, description from family where run = ?", run).map((f) => ({
      id: String(f.id),
      description: String(f.description),
    }));
  }
}

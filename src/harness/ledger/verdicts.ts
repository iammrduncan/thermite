import { canonicalJson } from "../../core/canonical.ts";
import type { EventBodies } from "../../core/events/bodies.ts";
import { toFraction } from "../../core/stats.ts";
import { clipReason, REASONS_CHARS } from "../judge/index.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";

export interface InvalidationResult {
  /** The invalidation's id in the `invalidation` table. */
  id: number;
  attempts: string[];
  verdictsSuperseded: number[];
  championsReopened: { run: string; seq: number }[];
}

/**
 * What an invalidation would reach, read without changing anything: the attempts in the order the
 * walk meets them, why each is reached and its current verdict, and the champions that rest on
 * them. invalidate() walks the same way, so a preview is what the invalidation then does.
 */
export interface InvalidationWalk {
  /** The run of the subject; null for a job no run owns. */
  run: string | null;
  attempts: {
    attempt: string;
    why: "subject" | "evidence" | "lineage";
    parent: string | null;
    current: { id: number; verdict: string } | undefined;
  }[];
  champions: { run: string; seq: number; attempt: string }[];
}

/** A verdict as recorded. */
export interface VerdictRow {
  id: number;
  attempt: string;
  verdict: string;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** The guards' estimates, as JSON. */
  guards: string;
  reasons: string;
  created_at: string;
}

const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

/**
 * The guards for the verdict's event (goal 184): each guard's status, its change against the
 * champion and the interval's ends as fractions in its direction (positive is better), its
 * measured values, and at confirmation its change against the starting point. The ledger's row
 * keeps them as the judge gave them, as log ratios.
 */
function guardsForEvent(guards: unknown): NonNullable<EventBodies["verdict"]["guards"]> {
  const frac = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? toFraction(x) : null);
  return (Array.isArray(guards) ? guards : []).flatMap((x) => {
    const g = (x ?? {}) as Record<string, unknown>;
    if (typeof g.metric !== "string") return [];
    const s = g.vs_start as Record<string, unknown> | undefined;
    return [
      {
        metric: g.metric,
        status: String(g.status),
        change: frac(g.estimate),
        low: frac(g.low),
        high: frac(g.high),
        ...(g.values ? { values: g.values } : {}),
        // A guard of the metric roles (goal 209): its bound, which a page says in words.
        ...(g.rule ? { rule: g.rule } : {}),
        ...(s ? { vs_start: { change: frac(s.estimate), spent: s.spent === true } } : {}),
      },
    ];
  });
}

function toVerdict(r: Row): VerdictRow {
  return {
    id: Number(r.id),
    attempt: String(r.attempt),
    verdict: String(r.verdict),
    delta: num(r.delta),
    ci_low: num(r.ci_low),
    ci_high: num(r.ci_high),
    guards: String(r.guards),
    reasons: String(r.reasons),
    created_at: String(r.created_at),
  };
}

/** The `verdict` and `invalidation` tables: the verdicts, and invalidation. */
export class LedgerVerdicts extends LedgerPart {
  record(v: {
    attempt: string;
    verdict: string;
    delta?: number | null | undefined;
    ciLow?: number | null | undefined;
    ciHigh?: number | null | undefined;
    guards?: unknown;
    dependsOnJobs?: number[] | undefined;
    reasons: string;
    judgedBy: string;
    supersedes?: number | undefined;
    /** The main metric's measured values (goal 133): in the event only, for control's pages. */
    values?: unknown;
    /** The plan's other metrics' values (goal 209): in the event only, as values are. */
    metrics?: unknown;
  }): number {
    return this.tx(() => {
      const a = this.ledger.attempts.get(v.attempt);
      if (!a) throw new LedgerError("not_found", `no attempt ${v.attempt}`);
      if (a.invalidated_by !== null && v.verdict !== "invalidated") {
        throw new LedgerError("invalid", `attempt ${v.attempt} is invalidated`);
      }
      return this.insert(v);
    });
  }

  private insert(v: Parameters<LedgerVerdicts["record"]>[0]): number {
    const id = this.execute(
      `insert into verdict (attempt, verdict, delta, ci_low, ci_high, guards, depends_on_jobs, reasons,
         judged_by, supersedes, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.attempt,
      v.verdict,
      v.delta ?? null,
      v.ciLow ?? null,
      v.ciHigh ?? null,
      canonicalJson(v.guards ?? []),
      canonicalJson(v.dependsOnJobs ?? []),
      v.reasons,
      v.judgedBy,
      v.supersedes ?? null,
      this.now(),
    ).id;
    this.ledger.appendEvent(v.judgedBy, "verdict", v.attempt, {
      id,
      verdict: v.verdict,
      delta: v.delta ?? null,
      // The interval and the judge's reasons, so a reader sees how sure the verdict is and why.
      ci_low: v.ciLow ?? null,
      ci_high: v.ciHigh ?? null,
      reasons: clipReason(v.reasons, REASONS_CHARS),
      supersedes: v.supersedes ?? null,
      ...(v.values ? { values: v.values } : {}),
      ...(Array.isArray(v.metrics) && v.metrics.length ? { metrics: v.metrics } : {}),
      ...(Array.isArray(v.guards) && v.guards.length ? { guards: guardsForEvent(v.guards) } : {}),
    });
    return id;
  }

  /**
   * Each standing champion's guards (goal 184), sent once as a `verdict_guards` event when its
   * confirmed win's event did not carry them (a harness before goal 184 judged it): the ledger's
   * record of the guards, as fractions, without their values. Control's charts place such a
   * champion from its change against the starting point. Returns how many it sent.
   */
  sendChampionGuards(judgedBy: string): number {
    let sent = 0;
    for (const run of this.ledger.runs.list()) {
      if (run.mode !== "hill_climb") continue;
      for (const c of this.ledger.champions.newest(run.id, 500)) {
        if (!c.attempt || c.seq <= 1) continue;
        const v = this.confirmedWin(c.attempt);
        const guards = v ? (JSON.parse(v.guards) as unknown[]) : [];
        if (!v || !Array.isArray(guards) || !guards.length) continue;
        const carried = this.ledger.events
          .list("verdict", { subject: c.attempt })
          .some(
            (e) =>
              Number((e.body as { id?: unknown }).id) === v.id &&
              (e.body as { guards?: unknown }).guards,
          );
        if (carried) continue;
        if (this.ledger.events.newest("verdict_guards", { subject: c.attempt, body: { id: v.id } }))
          continue;
        this.ledger.appendEvent(judgedBy, "verdict_guards", c.attempt, {
          id: v.id,
          guards: guardsForEvent(guards),
        });
        sent++;
      }
    }
    return sent;
  }

  /** A verdict, by its id. */
  get(id: number): VerdictRow | undefined {
    const r = this.row<Row>("select * from verdict where id = ?", id);
    return r ? toVerdict(r) : undefined;
  }

  /** The newest confirmed win of an attempt, if it has one. */
  confirmedWin(attempt: string): VerdictRow | undefined {
    const r = this.row<Row>(
      "select * from verdict where attempt = ? and verdict = 'win_confirmed' order by id desc limit 1",
      attempt,
    );
    return r ? toVerdict(r) : undefined;
  }

  /** The changes of a run's confirmed wins that stand, but `except`'s. */
  confirmedDeltas(run: string, except: string): number[] {
    return this.rows<{ delta: number }>(
      `select v.delta as delta from verdict v join attempt a on a.id = v.attempt
       where a.run = ? and a.id != ? and v.verdict = 'win_confirmed' and v.delta is not null
         and not exists (select 1 from verdict s where s.supersedes = v.id)`,
      run,
      except,
    ).map((r) => Number(r.delta));
  }

  /** The newest verdict for an attempt that no later verdict supersedes. */
  current(attempt: string): { id: number; verdict: string; depends_on_jobs: number[] } | undefined {
    const r = this.row<Row>(
      `select id, verdict, depends_on_jobs from verdict v where attempt = ?
         and not exists (select 1 from verdict s where s.supersedes = v.id)
       order by id desc limit 1`,
      attempt,
    );
    return r
      ? {
          id: Number(r.id),
          verdict: String(r.verdict),
          depends_on_jobs: JSON.parse(String(r.depends_on_jobs)) as number[],
        }
      : undefined;
  }

  /**
   * What invalidating a job's evidence or a whole attempt would reach (the walk), with nothing
   * changed. An invalidated attempt (and everything built on it) is invalid for good. Attempts
   * whose current verdict rests on an invalidated job may be measured again; their descendants
   * are judged again too.
   */
  walk(subject: { kind: "job" | "attempt"; id: string }): InvalidationWalk {
    const out: InvalidationWalk = { run: null, attempts: [], champions: [] };
    let frontier: {
      attempt: string;
      why: "subject" | "evidence" | "lineage";
      parent: string | null;
    }[] = [];
    if (subject.kind === "attempt") {
      const a = this.row<Row>("select run from attempt where id = ?", subject.id);
      out.run = typeof a?.run === "string" ? a.run : null;
      frontier = [{ attempt: subject.id, why: "subject", parent: null }];
    } else {
      const jobId = Number(subject.id);
      const job = this.row<Row>(
        `select coalesce(a.run, json_extract(j.spec, '$.run')) as run from job j
           left join attempt a on a.id = j.attempt where j.id = ?`,
        jobId,
      );
      out.run = typeof job?.run === "string" ? job.run : null;
      for (const r of this.rows<Row>("select distinct attempt from verdict order by attempt")) {
        const current = this.current(String(r.attempt));
        if (current?.depends_on_jobs.includes(jobId))
          frontier.push({ attempt: String(r.attempt), why: "evidence", parent: null });
      }
    }
    const seen = new Set<string>();
    while (frontier.length) {
      const next = frontier.shift() as (typeof frontier)[number];
      if (seen.has(next.attempt)) continue;
      seen.add(next.attempt);
      const current = this.current(next.attempt);
      out.attempts.push({
        ...next,
        current: current ? { id: current.id, verdict: current.verdict } : undefined,
      });
      for (const c of this.rows<Row>(
        "select run, seq from champion where attempt = ? and reopened = 0 order by seq",
        next.attempt,
      ))
        out.champions.push({ run: String(c.run), seq: Number(c.seq), attempt: next.attempt });
      for (const child of this.rows<Row>(
        "select id from attempt where parent_attempt = ? order by created_at, id",
        next.attempt,
      ))
        frontier.push({ attempt: String(child.id), why: "lineage", parent: next.attempt });
    }
    return out;
  }

  /**
   * Invalidates a job's evidence or a whole attempt, as walk() reaches it. Never deletes: the
   * current verdicts are superseded by an `invalidated` verdict, champions built on them are marked
   * reopened, and attempts derived from an invalidated attempt are invalidated in turn.
   */
  invalidate(input: {
    subjectKind: "job" | "attempt";
    subjectId: string;
    reason: string;
    actor: string;
  }): InvalidationResult {
    return this.tx(() => {
      const at = this.now();
      const walk = this.walk({ kind: input.subjectKind, id: input.subjectId });
      const invalidationId = this.execute(
        "insert into invalidation (subject_kind, subject_id, reason, actor, created_at) values (?, ?, ?, ?, ?)",
        input.subjectKind,
        input.subjectId,
        input.reason,
        input.actor,
        at,
      ).id;
      const result: InvalidationResult = {
        id: invalidationId,
        attempts: [],
        verdictsSuperseded: [],
        championsReopened: [],
      };
      // An invalidated attempt (and everything built on it) is invalid for good. Attempts whose
      // job evidence was invalidated may be measured again; their descendants are re-judged too.
      const permanent = input.subjectKind === "attempt";
      for (const { attempt, current } of walk.attempts) {
        result.attempts.push(attempt);
        if (permanent) {
          this.execute(
            "update attempt set invalidated_by = coalesce(invalidated_by, ?), updated_at = ? where id = ?",
            invalidationId,
            at,
            attempt,
          );
        }
        if (current?.verdict !== "invalidated") {
          const id = this.insert({
            attempt,
            verdict: "invalidated",
            reasons:
              attempt === input.subjectId || input.subjectKind === "job"
                ? input.reason
                : `lineage of invalidated evidence: ${input.reason}`,
            judgedBy: input.actor,
            supersedes: current?.id,
          });
          result.verdictsSuperseded.push(id);
        }
        for (const c of walk.champions.filter((x) => x.attempt === attempt)) {
          this.execute("update champion set reopened = 1 where run = ? and seq = ?", c.run, c.seq);
          result.championsReopened.push({ run: c.run, seq: c.seq });
          this.ledger.appendEvent(input.actor, "champion_reopened", c.run, {
            seq: c.seq,
            attempt,
            reason: input.reason,
          });
        }
      }
      this.ledger.appendEvent(input.actor, "invalidation", input.subjectId, {
        id: invalidationId,
        run: walk.run,
        kind: input.subjectKind,
        reason: input.reason,
        attempts: result.attempts,
        verdicts: result.verdictsSuperseded,
        champions: result.championsReopened.map((c) => c.seq),
      });
      return result;
    });
  }

  /**
   * An attempt built on one invalidated for good is invalid with it, from the moment it is
   * recorded (lineage): marked with the same invalidation and given an `invalidated` verdict.
   * False when its parent stands.
   */
  inherit(attempt: string, parent: string, actor: string): boolean {
    return this.tx(() => {
      const p = this.ledger.attempts.get(parent);
      if (!p || p.invalidated_by === null) return false;
      const from = this.row<Row>(
        "select reason from invalidation where id = ?",
        Number(p.invalidated_by),
      );
      this.execute(
        "update attempt set invalidated_by = ?, updated_at = ? where id = ?",
        Number(p.invalidated_by),
        this.now(),
        attempt,
      );
      this.insert({
        attempt,
        verdict: "invalidated",
        reasons: `lineage of invalidated evidence: built on ${parent}, which was withdrawn: ${String(from?.reason ?? "")}`,
        judgedBy: actor,
      });
      return true;
    });
  }
}

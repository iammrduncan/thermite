import { canonicalJson } from "../../core/canonical.ts";
import { shownViolations, violationsOf } from "../v0.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";
import type { AttemptInput } from "./rows.ts";

/** The `attempt` table: the attempts and their lifecycles. */
export class LedgerAttempts extends LedgerPart {
  record(a: AttemptInput, actor: string): void {
    this.tx(() => {
      const at = this.now();
      this.execute(
        `insert into attempt (id, run, lane, origin, parent_ref, parent_commit, parent_attempt,
           baseline_champion_seq, commit_sha, ref, diff_sha, normalized_diff_sha, lifecycle, hypothesis,
           claim, known_flaws, v0, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.run,
        a.lane ?? null,
        a.origin ?? "local",
        a.parentRef,
        a.parentCommit,
        a.parentAttempt ?? null,
        a.baselineChampionSeq,
        a.commitSha,
        a.ref,
        a.diffSha,
        a.normalizedDiffSha,
        a.lifecycle,
        a.hypothesis ?? null,
        a.claim ?? null,
        canonicalJson(a.knownFlaws ?? []),
        a.v0 === undefined ? null : canonicalJson(a.v0),
        at,
        at,
      );
      this.ledger.appendEvent(actor, "attempt_recorded", a.id, {
        run: a.run,
        lane: a.lane ?? null,
        lifecycle: a.lifecycle,
        commit: a.commitSha,
        parent: a.parentCommit,
        hypothesis: a.hypothesis?.slice(0, 500) ?? null,
        known_flaws: a.knownFlaws ?? [],
        // What changed, bounded: the first 50 files and how many there were in all.
        ...(a.files ? { files: a.files.slice(0, 50), files_total: a.files.length } : {}),
        // Why the static checks refused it, bounded (goal 082): control, the knowledge base and
        // the owner see what the submitting trial saw. The record keeps them all.
        ...(() => {
          const refused = violationsOf(a.v0);
          if (!refused.length) return {};
          const shown = shownViolations(refused);
          return { violations: shown.violations, violations_total: shown.total };
        })(),
      });
    });
  }

  get(id: string): Row | undefined {
    return this.row<Row>("select * from attempt where id = ?", id);
  }

  /**
   * An earlier attempt in the same run with an identical normalized change, if any.
   * Attempts lost to infrastructure (errored, crash_infra) or invalidated do not count, so the
   * same change can be measured again.
   */
  findDuplicate(run: string, normalizedDiffSha: string): string | undefined {
    const rows = this.rows<Row>(
      `select id from attempt where run = ? and normalized_diff_sha = ? and lifecycle != 'errored'
         and invalidated_by is null order by created_at`,
      run,
      normalizedDiffSha,
    );
    for (const r of rows) {
      const v = this.ledger.verdicts.current(String(r.id))?.verdict;
      if (v !== "crash_infra" && v !== "invalidated") return String(r.id);
    }
    return undefined;
  }

  /** The newest attempt in a run whose commit is `commit`, if any (for lineage). */
  byCommit(run: string, commit: string): string | undefined {
    const r = this.row<Row>(
      "select id from attempt where run = ? and commit_sha = ? order by created_at desc limit 1",
      run,
      commit,
    );
    return r ? String(r.id) : undefined;
  }

  setLifecycle(id: string, lifecycle: string, actor: string): void {
    this.tx(() => {
      const r = this.execute(
        "update attempt set lifecycle = ?, updated_at = ? where id = ?",
        lifecycle,
        this.now(),
        id,
      );
      if (r.changes === 0) throw new LedgerError("not_found", `no attempt ${id}`);
      this.ledger.appendEvent(actor, "attempt_lifecycle", id, { lifecycle });
    });
  }

  /** How many of a run's attempts are in each lifecycle. */
  lifecycles(run: string): Record<string, number> {
    const rows = this.rows<Row>(
      "select lifecycle, count(*) as n from attempt where run = ? group by lifecycle",
      run,
    );
    return Object.fromEntries(rows.map((r) => [String(r.lifecycle), Number(r.n)]));
  }

  /** The ids of a run's attempts in a family, oldest first. */
  ofFamily(run: string, family: string): string[] {
    return this.rows<Row>(
      "select id from attempt where run = ? and family = ? order by created_at",
      run,
      family,
    ).map((r) => String(r.id));
  }

  /** The families a run's attempts were tagged with. */
  families(run: string): string[] {
    return this.rows<Row>(
      "select distinct family from attempt where run = ? and family is not null",
      run,
    ).map((r) => String(r.family));
  }

  /** Tags an attempt with the family it was judged in. */
  setFamily(attempt: string, family: string): void {
    this.execute("update attempt set family = ? where id = ?", family, attempt);
  }

  /** A run's newest attempts (on one lane, when given), the newest first. */
  newest(run: string, limit: number, lane?: string): Row[] {
    return lane
      ? this.rows<Row>(
          "select * from attempt where run = ? and lane = ? order by created_at desc limit ?",
          run,
          lane,
          limit,
        )
      : this.rows<Row>(
          "select * from attempt where run = ? order by created_at desc limit ?",
          run,
          limit,
        );
  }

  /** How many of a run's attempts are in these lifecycles. */
  countIn(run: string, lifecycles: readonly string[]): number {
    const r = this.row<Row>(
      `select count(*) as n from attempt where run = ? and lifecycle in (${lifecycles.map(() => "?").join(",")})`,
      run,
      ...lifecycles,
    );
    return Number(r?.n ?? 0);
  }
}

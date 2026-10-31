import { PROMOTABLE_VERDICTS } from "../../core/verdicts.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";

export type PromoteResult = { ok: true; seq: number } | { ok: false; currentSeq: number };

/** The `champion` table: each run's champions, promotion and the starting point. */
export class LedgerChampions extends LedgerPart {
  /**
   * The effective champion: the newest one not reopened by invalidation. The seed (seq 1) has
   * no attempt and is never reopened, so there always is one.
   */
  current(run: string): { seq: number; commit_sha: string; attempt: string | null } {
    const r = this.row<Row>(
      "select seq, commit_sha, attempt from champion where run = ? and reopened = 0 order by seq desc limit 1",
      run,
    );
    if (!r) throw new LedgerError("not_found", `no champion for ${run}`);
    return {
      seq: Number(r.seq),
      commit_sha: String(r.commit_sha),
      attempt: r.attempt === null ? null : String(r.attempt),
    };
  }

  /**
   * Promotes an attempt by compare-and-swap on the run's champion: the champion, its event, the
   * acceptance of its declared flaws by `acceptFlaws` (who accepts them, when nobody has yet)
   * and its lifecycle, in one transaction (goal 163). It succeeds only when the effective
   * champion's seq is `expectedSeq`, the one the judge measured against; a lost race changes
   * nothing and returns the current seq. An attempt that is not promotable is a LedgerError.
   */
  promote(input: {
    run: string;
    expectedSeq: number;
    attempt: string;
    commitSha: string;
    by: string;
    acceptFlaws?: string | undefined;
  }): PromoteResult {
    return this.tx(() => {
      const a = this.ledger.attempts.get(input.attempt);
      if (!a || String(a.run) !== input.run) {
        throw new LedgerError("invalid", `attempt ${input.attempt} is not in ${input.run}`);
      }
      if (String(a.commit_sha) !== input.commitSha) {
        throw new LedgerError(
          "invalid",
          `commit ${input.commitSha} is not attempt ${input.attempt}'s`,
        );
      }
      if (a.invalidated_by !== null) {
        throw new LedgerError("invalid", `attempt ${input.attempt} is invalidated`);
      }
      const verdict = this.ledger.verdicts.current(input.attempt)?.verdict;
      if (!verdict || !PROMOTABLE_VERDICTS.includes(verdict)) {
        throw new LedgerError(
          "invalid",
          `attempt ${input.attempt} has verdict ${verdict ?? "none"}`,
        );
      }
      const open =
        (JSON.parse(String(a.known_flaws)) as unknown[]).length > 0 && !a.flaws_cleared_by;
      if (open && !input.acceptFlaws) {
        throw new LedgerError("invalid", `attempt ${input.attempt} has open known flaws`);
      }
      const current = this.current(input.run).seq;
      if (current !== input.expectedSeq) return { ok: false, currentSeq: current };
      if (open) {
        this.execute(
          "update attempt set flaws_cleared_by = ? where id = ?",
          input.acceptFlaws ?? null,
          input.attempt,
        );
        this.ledger.appendEvent(input.by, "flaws_accepted", input.attempt, {
          by: input.acceptFlaws,
        });
      }
      const top = this.row<Row>("select max(seq) as m from champion where run = ?", input.run);
      const seq = Number(top?.m) + 1;
      this.execute(
        "insert into champion (run, seq, attempt, commit_sha, promoted_by, promoted_at) values (?, ?, ?, ?, ?, ?)",
        input.run,
        seq,
        input.attempt,
        input.commitSha,
        input.by,
        this.now(),
      );
      this.ledger.appendEvent(input.by, "champion_promoted", input.run, {
        seq,
        attempt: input.attempt,
        commit: input.commitSha,
      });
      this.ledger.attempts.setLifecycle(input.attempt, "promoted", input.by);
      return { ok: true, seq };
    });
  }

  /**
   * A hill climb's setup change that the judge measured becomes the run's starting point (goal
   * 115): a champion like a promotion's, by compare-and-swap on the champion the judge read, with
   * `promoted_by` ending in `:setup` (SETUP_MARK) and `setup: true` in its event, so readers start
   * the cumulative gain again from it. It needs no promotable verdict: the judge's baseline job,
   * not a comparison with a champion, decided it.
   */
  setStartingPoint(input: {
    run: string;
    expectedSeq: number;
    attempt: string;
    commitSha: string;
    by: string;
  }): PromoteResult {
    return this.tx(() => {
      const a = this.ledger.attempts.get(input.attempt);
      if (!a || String(a.run) !== input.run) {
        throw new LedgerError("invalid", `attempt ${input.attempt} is not in ${input.run}`);
      }
      if (String(a.commit_sha) !== input.commitSha) {
        throw new LedgerError(
          "invalid",
          `commit ${input.commitSha} is not attempt ${input.attempt}'s`,
        );
      }
      if (a.invalidated_by !== null) {
        throw new LedgerError("invalid", `attempt ${input.attempt} is invalidated`);
      }
      const current = this.current(input.run).seq;
      if (current !== input.expectedSeq) return { ok: false, currentSeq: current };
      const top = this.row<Row>("select max(seq) as m from champion where run = ?", input.run);
      const seq = Number(top?.m) + 1;
      this.execute(
        "insert into champion (run, seq, attempt, commit_sha, promoted_by, promoted_at) values (?, ?, ?, ?, ?, ?)",
        input.run,
        seq,
        input.attempt,
        input.commitSha,
        `${input.by}:setup`,
        this.now(),
      );
      this.ledger.appendEvent(input.by, "champion_promoted", input.run, {
        seq,
        attempt: input.attempt,
        commit: input.commitSha,
        setup: true,
      });
      return { ok: true, seq };
    });
  }

  /**
   * The run's champion once the champions `seqs` are reopened: the newest of the others that
   * stands. The seed (seq 1) is never reopened, so there always is one.
   */
  currentWithout(
    run: string,
    seqs: readonly number[],
  ): { seq: number; commit_sha: string; attempt: string | null } {
    const r = this.row<Row>(
      `select seq, commit_sha, attempt from champion where run = ? and reopened = 0
         ${seqs.length ? `and seq not in (${seqs.map(() => "?").join(", ")})` : ""}
       order by seq desc limit 1`,
      run,
      ...seqs,
    );
    if (!r) throw new LedgerError("not_found", `no champion for ${run}`);
    return {
      seq: Number(r.seq),
      commit_sha: String(r.commit_sha),
      attempt: r.attempt === null ? null : String(r.attempt),
    };
  }

  /** The seqs of a run's champions that invalidation reopened. */
  reopened(run: string): number[] {
    return this.rows<Row>(
      "select seq from champion where run = ? and reopened = 1 order by seq",
      run,
    ).map((r) => Number(r.seq));
  }

  /** The attempts of a run's champions after `seq` that stand, oldest first. */
  attemptsAfter(run: string, seq: number): string[] {
    return this.rows<Row>(
      "select attempt from champion where run = ? and reopened = 0 and attempt is not null and seq > ? order by seq",
      run,
      seq,
    ).map((r) => String(r.attempt));
  }

  /** When a run's champion `seq` was promoted, if it was. */
  promotedAt(run: string, seq: number): string | undefined {
    const r = this.row<Row>("select promoted_at from champion where run = ? and seq = ?", run, seq);
    return r ? String(r.promoted_at) : undefined;
  }

  /** A run's newest champions that stand, the newest first. */
  newest(run: string, n: number): { seq: number; attempt: string | null; commit_sha: string }[] {
    return this.rows<Row>(
      "select seq, attempt, commit_sha from champion where run = ? and reopened = 0 order by seq desc limit ?",
      run,
      n,
    ).map((r) => ({
      seq: Number(r.seq),
      attempt: r.attempt === null ? null : String(r.attempt),
      commit_sha: String(r.commit_sha),
    }));
  }

  /** The newest of a run's champions from `from` up to (not with) `below` that is this commit. */
  seqOfCommit(run: string, commit: string, from: number, below: number): number | undefined {
    const r = this.row<Row>(
      "select seq from champion where run = ? and commit_sha = ? and seq < ? and seq >= ? order by seq desc limit 1",
      run,
      commit,
      below,
      from,
    );
    return r ? Number(r.seq) : undefined;
  }

  /** Whether an attempt is one of its run's champions that stand: its change is in them. */
  holds(attempt: string): boolean {
    return !!this.row<Row>("select 1 from champion where attempt = ? and reopened = 0", attempt);
  }

  /**
   * The newest champion that stands among the starting point (seq 1) and those promoted by a
   * name ending in `mark`, if any.
   */
  newestMarked(
    run: string,
    mark: string,
  ): { seq: number; commit_sha: string; attempt: string | null } | undefined {
    const r = this.row<Row>(
      `select seq, commit_sha, attempt from champion where run = ? and reopened = 0
         and (seq = 1 or promoted_by like ?) order by seq desc limit 1`,
      run,
      `%${mark}`,
    );
    return r
      ? {
          seq: Number(r.seq),
          commit_sha: String(r.commit_sha),
          attempt: r.attempt === null ? null : String(r.attempt),
        }
      : undefined;
  }
}

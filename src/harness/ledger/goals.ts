import { canonicalJson } from "../../core/canonical.ts";
import type { Contract } from "../../core/contract.ts";
import { clipReason, REASONS_CHARS } from "../judge/index.ts";
import { LedgerPart, type Row } from "./part.ts";

/** What a goal's check found, and the goal's status it leads to. */
const STATUS_OF = {
  met: "verified",
  unmet: "unmet",
  inconclusive: "attempted",
  not_runnable: "not_runnable",
} as const;

/** The `goal` and `goal_check` tables: a goal run's goals, and every check of one. */
export class LedgerGoals extends LedgerPart {
  /** A goal run's goal tree, from its contract, when the run is created. */
  create(run: string, goals: Extract<Contract, { mode: "goal" }>["goals"]): void {
    for (const g of goals)
      this.execute(
        "insert into goal (run, id, parent, priority, required, verify) values (?, ?, ?, ?, ?, ?)",
        run,
        g.id,
        g.parent ?? null,
        g.priority,
        g.required ? 1 : 0,
        canonicalJson(g.verify),
      );
  }

  /** Each of a run's goals, with its status. */
  statuses(run: string): Map<string, string> {
    const rows = this.rows<Row>("select id, status from goal where run = ?", run);
    return new Map(rows.map((g) => [String(g.id), String(g.status)]));
  }

  /**
   * A check of a goal on a commit; with `updateStatus`, the goal's status follows what it found.
   * Called inside the judge's fenced transaction.
   */
  recordCheck(
    c: { run: string; goal: string; attempt: string | null; job: number; commit: string },
    r: { status: keyof typeof STATUS_OF; reasons: string },
    updateStatus: boolean,
  ): void {
    this.execute(
      "insert into goal_check (run, goal, attempt, job, commit_sha, result, detail, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      c.run,
      c.goal,
      c.attempt,
      c.job,
      c.commit,
      r.status,
      clipReason(r.reasons, REASONS_CHARS),
      this.now(),
    );
    if (updateStatus)
      this.execute(
        "update goal set status = ? where run = ? and id = ?",
        STATUS_OF[r.status],
        c.run,
        c.goal,
      );
  }
}

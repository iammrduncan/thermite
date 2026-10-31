import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/**
 * The `conclusion` table: the harness's proposals to end a goal campaign as not possible, each
 * with its evidence, and the decision on each.
 */
export class LedgerConclusions extends LedgerPart {
  /** A "not possible" proposal for the run, made at `at` from this evidence: its id. */
  add(run: string, evidence: unknown, at: string): number {
    return this.execute(
      "insert into conclusion (run, kind, evidence, proposed_at) values (?, 'not_possible', ?, ?)",
      run,
      canonicalJson(evidence),
      at,
    ).id;
  }

  get(run: string, id: number): Row | undefined {
    return this.row<Row>("select * from conclusion where id = ? and run = ?", id, run);
  }

  /** The run's proposal still waiting for a decision, if any. */
  open(run: string): Row | undefined {
    return this.row<Row>("select * from conclusion where run = ? and decision is null", run);
  }

  /** The evidence of the run's newest rejected proposal, as stored JSON, if one was rejected. */
  rejectedEvidence(run: string): string | undefined {
    const r = this.row<Row>(
      "select evidence from conclusion where run = ? and decision = 'rejected' order by id desc limit 1",
      run,
    );
    return r ? String(r.evidence) : undefined;
  }

  /** The decision on a proposal, at `at`. */
  decide(id: number, decision: "accepted" | "rejected", note: string | null, at: string): void {
    this.execute(
      "update conclusion set decision = ?, note = ?, decided_at = ? where id = ?",
      decision,
      note,
      at,
      id,
    );
  }
}

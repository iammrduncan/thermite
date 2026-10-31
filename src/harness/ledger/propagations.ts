import { LedgerPart, type Row } from "./part.ts";

/**
 * The `propagation` table: the champions other rigs published that this rig received, each as the
 * attempt its own judge judges, and how each settled.
 */
export class LedgerPropagations extends LedgerPart {
  /** A propagation received at `at`, judged here as `attempt`. */
  add(p: {
    attempt: string;
    run: string;
    sourceRig: string;
    sourceRun: string;
    sourceSeq: number;
    tree: string;
    at: string;
  }): void {
    this.execute(
      `insert into propagation (attempt, run, source_rig, source_run, source_seq, tree, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      p.attempt,
      p.run,
      p.sourceRig,
      p.sourceRun,
      p.sourceSeq,
      p.tree,
      p.at,
    );
  }

  /** The propagations not settled yet, and those rejected (an owner may promote one later). */
  unsettledOrRejected(): Row[] {
    return this.rows<Row>(
      "select * from propagation where result is null or result like 'rejected:%'",
    );
  }

  /** How a propagated attempt settled (accepted, or rejected: with the verdict), at `at`. */
  settle(attempt: string, result: string, at: string): void {
    this.execute(
      "update propagation set result = ?, decided_at = ? where attempt = ?",
      result,
      at,
      attempt,
    );
  }
}

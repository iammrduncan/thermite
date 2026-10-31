import { LedgerPart, type Row } from "./part.ts";

/** A file a lane wrote, as its newest record holds it. */
export interface LaneFileRow {
  lane: string;
  path: string;
  bytes: number;
  trial: string | null;
  recorded_at: string;
}

/** A change to a lane's file since the lane's files were last saved: its size and hash when written. */
export interface LaneFileChange {
  path: string;
  change: "written" | "removed";
  bytes: number | null;
  sha256: string | null;
}

/**
 * The `research_file` table: what each lane wrote in its research folder, one record for each file
 * written or removed when the lane's files are saved, so who wrote what, and when, is kept.
 */
export class LedgerLaneFiles extends LedgerPart {
  /** The changes to a lane's files that its trial left (`trial`), in order, recorded now. */
  record(
    run: string,
    lane: string,
    trial: string | null,
    changes: readonly LaneFileChange[],
  ): void {
    const at = this.now();
    const add = this.db.prepare(
      "insert into research_file (run, lane, trial, path, change, bytes, sha256, recorded_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of changes) add.run(run, lane, trial, c.path, c.change, c.bytes, c.sha256, at);
  }

  /**
   * Each lane's files now: the newest record of each path, when it was written (not removed); by
   * lane and path, or the newest first.
   */
  current(run: string, order: "path" | "newest"): LaneFileRow[] {
    return this.rows<Row>(
      `select f.lane, f.path, f.bytes, f.trial, f.recorded_at from research_file f
        where f.run = ? and f.change = 'written' and f.id = (
          select max(g.id) from research_file g where g.run = f.run and g.lane = f.lane and g.path = f.path)
        order by ${order === "path" ? "f.lane, f.path" : "f.recorded_at desc, f.id desc"}`,
      run,
    ).map((f) => ({
      lane: String(f.lane),
      path: String(f.path),
      bytes: Number(f.bytes),
      trial: f.trial === null ? null : String(f.trial),
      recorded_at: String(f.recorded_at),
    }));
  }
}

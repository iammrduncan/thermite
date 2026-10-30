import type { DatabaseSync } from "node:sqlite";

/**
 * The files the knowledge base holds, each once by its SHA-256 (the kb_file table; control's
 * kb/files.ts keeps the bytes in its state): which it holds, a file kept, and the orphans, files
 * no version of any item names, which control removes only when the owner sets a time for them.
 */

/** A file control holds, as its row records it. */
export interface KbFileRow {
  sha256: string;
  bytes: number;
  stored_at: string;
}

export class KbFileRows {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Whether control holds the file with this SHA-256. */
  has(sha256: string): boolean {
    return this.db.prepare("select 1 from kb_file where sha256 = ?").get(sha256) !== undefined;
  }

  /** A file control now holds, once: every item that names its SHA-256 has it from now on. */
  kept(sha256: string, bytes: number, at = new Date().toISOString()): void {
    this.db
      .prepare(
        "insert into kb_file (sha256, bytes, stored_at) values (?, ?, ?) on conflict do nothing",
      )
      .run(sha256, bytes, at);
  }

  /**
   * The files kept before `before` that no version of any item names, the newest one included:
   * a file whose item never arrived, or was refused. Oldest first, at most `limit`. Versions are
   * never removed, so a file an item named once is never among them.
   */
  orphans(before: string, limit: number): KbFileRow[] {
    return (
      this.db
        .prepare(
          `select sha256, bytes, stored_at from kb_file
           where stored_at < ?
             and sha256 not in (select file_sha256 from kb_version where file_sha256 is not null)
           order by stored_at limit ?`,
        )
        .all(before, limit) as { sha256: string; bytes: number; stored_at: string }[]
    ).map((r) => ({ sha256: r.sha256, bytes: Number(r.bytes), stored_at: r.stored_at }));
  }

  /** Forgets a file control removed from its state; an item that names it later waits for it again. */
  removed(sha256: string): void {
    this.db.prepare("delete from kb_file where sha256 = ?").run(sha256);
  }
}

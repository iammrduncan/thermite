import { type Row, StorePart } from "./part.ts";

/**
 * The dashboard's sign-in sessions (goal 125, T6): each by its id's hash, with its token's
 * fingerprint and when it ends.
 */

export class UiSessions extends StorePart {
  create(idHash: string, tokenFp: string, expiresAt: number): void {
    const now = Date.now();
    this.db.prepare("delete from ui_session where expires_at <= ?").run(now);
    this.db
      .prepare(
        "insert into ui_session (id_hash, token_fp, created_at, expires_at) values (?, ?, ?, ?)",
      )
      .run(idHash, tokenFp, new Date(now).toISOString(), expiresAt);
  }

  get(idHash: string): { tokenFp: string; expiresAt: number } | undefined {
    const r = this.db
      .prepare("select token_fp, expires_at from ui_session where id_hash = ?")
      .get(idHash) as Row | undefined;
    return r ? { tokenFp: String(r.token_fp), expiresAt: Number(r.expires_at) } : undefined;
  }

  extend(idHash: string, expiresAt: number): void {
    this.db
      .prepare("update ui_session set expires_at = ? where id_hash = ?")
      .run(expiresAt, idHash);
  }

  delete(idHash: string): void {
    this.db.prepare("delete from ui_session where id_hash = ?").run(idHash);
  }
}

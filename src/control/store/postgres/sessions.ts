import type { UiSessions } from "../sessions.ts";
import { PgPart, type Row } from "./part.ts";

/** UiSessions on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresUiSessions extends PgPart implements UiSessions {
  async create(idHash: string, tokenFp: string, expiresAt: number): Promise<void> {
    const now = Date.now();
    await this.q.run("delete from ui_session where expires_at <= ?", now);
    await this.q.run(
      "insert into ui_session (id_hash, token_fp, created_at, expires_at) values (?, ?, ?, ?)",
      idHash,
      tokenFp,
      new Date(now).toISOString(),
      expiresAt,
    );
  }

  async get(idHash: string): Promise<{ tokenFp: string; expiresAt: number } | undefined> {
    const r = (await this.q.get(
      "select token_fp, expires_at from ui_session where id_hash = ?",
      idHash,
    )) as Row | undefined;
    return r ? { tokenFp: String(r.token_fp), expiresAt: Number(r.expires_at) } : undefined;
  }

  async extend(idHash: string, expiresAt: number): Promise<void> {
    await this.q.run("update ui_session set expires_at = ? where id_hash = ?", expiresAt, idHash);
  }

  async delete(idHash: string): Promise<void> {
    await this.q.run("delete from ui_session where id_hash = ?", idHash);
  }
}

import { type GitAccess, type GitAccessStore, gitAccessOf } from "../git-access.ts";
import { PgPart, type Row } from "./part.ts";

/** GitAccessStore on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresGitAccessStore extends PgPart implements GitAccessStore {
  /** Adds Git access; a name is used once (delete it to make another). */
  async add(g: GitAccess & { secret_sealed: string; by: string }): Promise<void> {
    await this.q.run(
      `insert into git_access (name, kind, public_key, fingerprint, secret_sealed, hint, username, host, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.name,
      g.kind,
      g.public_key,
      g.fingerprint,
      g.secret_sealed,
      g.hint,
      g.username,
      g.host,
      new Date().toISOString(),
      g.by,
    );
    await this.store.auditLog.add(g.by, "git_access_added", {
      name: g.name,
      kind: g.kind,
      hint: g.hint,
      host: g.host,
    });
  }

  /** Binds a Git access to the host it is for; false when there is no such access. */
  async setHost(name: string, host: string, by: string): Promise<boolean> {
    const r = await this.q.run("update git_access set host = ? where name = ?", host, name);
    if (Number(r.changes)) await this.store.auditLog.add(by, "git_access_host_set", { name, host });
    return Number(r.changes) > 0;
  }

  /** Git access by name, with its sealed secret (for control's own use only). */
  async get(name: string): Promise<(GitAccess & { secret_sealed: string }) | undefined> {
    const r = (await this.q.get("select * from git_access where name = ?", name)) as
      | Row
      | undefined;
    return r ? { ...gitAccessOf(r), secret_sealed: String(r.secret_sealed) } : undefined;
  }

  /** Every Git access, without secrets. */
  async list(): Promise<GitAccess[]> {
    return ((await this.q.all("select * from git_access order by name")) as Row[]).map(gitAccessOf);
  }

  /** A token replaced in place: same name, so campaigns that name it keep working. */
  async replaceToken(
    name: string,
    secretSealed: string,
    hint: string,
    by: string,
  ): Promise<boolean> {
    const r = await this.q.run(
      "update git_access set secret_sealed = ?, hint = ? where name = ? and kind = 'token'",
      secretSealed,
      hint,
      name,
    );
    if (Number(r.changes))
      await this.store.auditLog.add(by, "git_access_token_replaced", { name, hint });
    return Number(r.changes) > 0;
  }

  async delete(name: string, by: string): Promise<boolean> {
    const r = await this.q.run("delete from git_access where name = ?", name);
    if (Number(r.changes)) await this.store.auditLog.add(by, "git_access_deleted", { name });
    return Number(r.changes) > 0;
  }
}

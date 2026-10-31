import type { DatabaseSync } from "node:sqlite";
import { gitHost } from "../../common/git-auth.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Git access (goal 125, T6): an SSH key or a token, its secret only sealed, bound to the one host
 * it is for.
 */

/** Git access as listed (never its secret). */
export interface GitAccess {
  name: string;
  kind: "ssh" | "token";
  public_key: string | null;
  fingerprint: string | null;
  hint: string;
  username: string | null;
  /** The host it is for, such as github.com: control uses it for no other. Null: not set yet. */
  host: string | null;
}

/** A host a Git access is bound to: a host name, in lowercase. */
export const GIT_HOST =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** What GIT_HOST asks for, in words. */
export const GIT_HOST_WORDS =
  "Name the host the Git access is for, such as github.com: the server's name alone, with no https://, user, port or path.";

function gitAccessOf(r: Row): GitAccess {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    name: String(r.name),
    kind: r.kind === "token" ? "token" : "ssh",
    public_key: opt(r.public_key),
    fingerprint: opt(r.fingerprint),
    hint: String(r.hint),
    username: opt(r.username),
    host: opt(r.host),
  };
}

/**
 * Each Git access's host (store migration 15). An access that every assignment and saved campaign
 * naming it fetches from one host is bound to that host; one they name on more hosts, or nowhere,
 * is bound to none, and control uses it nowhere until the owner sets its host in Settings.
 */
export function gitAccessHost(db: DatabaseSync): void {
  const cols = db.prepare("pragma table_info(git_access)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "host")) db.exec("alter table git_access add column host text");
  const hosts = new Map<string, Set<string>>();
  const saw = (access: unknown, url: unknown) => {
    if (typeof access !== "string" || typeof url !== "string") return;
    const set = hosts.get(access) ?? new Set<string>();
    set.add(gitHost(url) ?? "");
    hosts.set(access, set);
  };
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  type Source = { git?: unknown; access?: unknown } | undefined;
  for (const r of db.prepare("select signed from command where kind = 'assign_campaign'").all() as {
    signed: string;
  }[]) {
    const p = json(r.signed) as { envelope?: { payload?: { imports?: { source?: Source }[] } } };
    for (const i of p?.envelope?.payload?.imports ?? []) saw(i?.source?.access, i?.source?.git);
  }
  for (const r of db.prepare("select sources from campaign_version").all() as {
    sources: string;
  }[]) {
    const s = json(r.sources) as { project?: { url?: unknown; access?: unknown }; kit?: Source };
    saw(s?.project?.access, s?.project?.url);
    saw(s?.kit?.access, s?.kit?.git);
  }
  const bind = db.prepare("update git_access set host = ? where name = ? and host is null");
  for (const [name, set] of hosts) {
    const [host] = [...set];
    if (set.size === 1 && host) bind.run(host, name);
  }
}

export class GitAccessStore extends StorePart {
  /** Adds Git access; a name is used once (delete it to make another). */
  add(g: GitAccess & { secret_sealed: string; by: string }): void {
    this.db
      .prepare(
        `insert into git_access (name, kind, public_key, fingerprint, secret_sealed, hint, username, host, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    this.store.auditLog.add(g.by, "git_access_added", {
      name: g.name,
      kind: g.kind,
      hint: g.hint,
      host: g.host,
    });
  }

  /** Binds a Git access to the host it is for; false when there is no such access. */
  setHost(name: string, host: string, by: string): boolean {
    const r = this.db.prepare("update git_access set host = ? where name = ?").run(host, name);
    if (Number(r.changes)) this.store.auditLog.add(by, "git_access_host_set", { name, host });
    return Number(r.changes) > 0;
  }

  /** Git access by name, with its sealed secret (for control's own use only). */
  get(name: string): (GitAccess & { secret_sealed: string }) | undefined {
    const r = this.db.prepare("select * from git_access where name = ?").get(name) as
      | Row
      | undefined;
    return r ? { ...gitAccessOf(r), secret_sealed: String(r.secret_sealed) } : undefined;
  }

  /** Every Git access, without secrets. */
  list(): GitAccess[] {
    return (this.db.prepare("select * from git_access order by name").all() as Row[]).map(
      gitAccessOf,
    );
  }

  /** A token replaced in place: same name, so campaigns that name it keep working. */
  replaceToken(name: string, secretSealed: string, hint: string, by: string): boolean {
    const r = this.db
      .prepare(
        "update git_access set secret_sealed = ?, hint = ? where name = ? and kind = 'token'",
      )
      .run(secretSealed, hint, name);
    if (Number(r.changes)) this.store.auditLog.add(by, "git_access_token_replaced", { name, hint });
    return Number(r.changes) > 0;
  }

  delete(name: string, by: string): boolean {
    const r = this.db.prepare("delete from git_access where name = ?").run(name);
    if (Number(r.changes)) this.store.auditLog.add(by, "git_access_deleted", { name });
    return Number(r.changes) > 0;
  }
}

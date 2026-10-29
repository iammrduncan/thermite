import { log } from "../../common/env.ts";
import { type McpStatus, type McpTool, orNull, type Row, str } from "../mcp-servers/index.ts";
import { keyHint, type SecretBox } from "../secrets.ts";
import { StorePart } from "./part.ts";

/**
 * MCP servers' rows in control's store (goal 068; goal 125, T6): each server, its secrets sealed
 * with control's secret box, its state and its tools as last read, and the OAuth sign-ins started
 * on servers' pages. McpServers (mcp-servers.ts) is their interface; it seals and opens.
 */

const SCHEMA = `
-- MCP servers (goal 068): the server, how it signs Thermite in (its secrets sealed with control's
-- secret box), its state, its last error and its tools as last read.
create table if not exists mcp_server (
  name text primary key,
  url text not null,
  auth text not null,
  header text,
  client_id text,
  scope text,
  secret_sealed text,
  secret_hint text,
  login_sealed text,
  status text not null default 'unchecked',
  last_error text,
  tools text,
  tools_at text,
  checked_at text,
  migrated_from text,
  created_at text not null,
  created_by text not null,
  updated_at text not null
);
-- OAuth sign-ins started and not finished yet: their state (hashed), the PKCE verifier (sealed).
create table if not exists mcp_sign_in (
  state_hash text primary key,
  name text not null,
  verifier_sealed text not null,
  redirect_uri text not null,
  expires_at text not null,
  started_by text not null
);
`;

export class McpServerRows extends StorePart {
  /** The servers' tables, made when missing: control's checks read them before anything made them. */
  ensureTables(): void {
    this.db.exec(SCHEMA);
  }

  /** The names of the servers in Settings. */
  names(): Set<string> {
    this.ensureTables();
    return new Set(
      (this.db.prepare("select name from mcp_server").all() as Row[]).map((r) => str(r.name)),
    );
  }

  /** Each server's tools' names, by server; null for a server whose tools were never read. */
  toolNames(): Map<string, string[] | null> {
    this.ensureTables();
    return new Map(
      (this.db.prepare("select name, tools from mcp_server").all() as Row[]).map((r) => {
        let tools: string[] | null = null;
        try {
          tools = r.tools ? (JSON.parse(str(r.tools)) as McpTool[]).map((t) => t.name) : null;
        } catch {
          tools = null;
        }
        return [str(r.name), tools] as const;
      }),
    );
  }

  /** Every server's row, by name. */
  list(): Row[] {
    return this.db.prepare("select * from mcp_server order by name").all() as Row[];
  }

  /** A server's row, by its name. */
  row(name: string): Row | undefined {
    return this.db.prepare("select * from mcp_server where name = ?").get(name) as Row | undefined;
  }

  /** A server added, or changed: a change keeps its row's tools and when they were read. */
  put(s: {
    name: string;
    url: string;
    auth: string;
    header: string | null;
    clientId: string | null;
    scope: string | null;
    secretSealed: string | null;
    secretHint: string | null;
    loginSealed: string | null;
    status: McpStatus;
    now: string;
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into mcp_server (name, url, auth, header, client_id, scope, secret_sealed, secret_hint,
           login_sealed, status, created_at, created_by, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (name) do update set url = excluded.url, auth = excluded.auth,
           header = excluded.header, client_id = excluded.client_id, scope = excluded.scope,
           secret_sealed = excluded.secret_sealed, secret_hint = excluded.secret_hint,
           login_sealed = excluded.login_sealed, status = excluded.status, last_error = null,
           updated_at = excluded.updated_at`,
      )
      .run(
        s.name,
        s.url,
        s.auth,
        s.header,
        s.clientId,
        s.scope,
        s.secretSealed,
        s.secretHint,
        s.loginSealed,
        s.status,
        s.now,
        s.by,
        s.now,
      );
  }

  /** Forgets a server: its sign-ins started, then its row. */
  delete(name: string): void {
    this.db.prepare("delete from mcp_sign_in where name = ?").run(name);
    this.db.prepare("delete from mcp_server where name = ?").run(name);
  }

  /** A server's state and its last error. */
  setState(name: string, status: McpStatus, error: string | null): void {
    this.db
      .prepare("update mcp_server set status = ?, last_error = ? where name = ?")
      .run(status, error, name);
  }

  /** A server's sign-in, sealed. */
  setLogin(name: string, sealed: string): void {
    this.db.prepare("update mcp_server set login_sealed = ? where name = ?").run(sealed, name);
  }

  /** When control last tried to read a server's tools. */
  setCheckedAt(name: string, at: string): void {
    this.db.prepare("update mcp_server set checked_at = ? where name = ?").run(at, name);
  }

  /** A server's tools as read now (JSON): it works. */
  setTools(name: string, tools: string, at: string): void {
    this.db
      .prepare(
        "update mcp_server set status = 'ok', last_error = null, tools = ?, tools_at = ?, checked_at = ? where name = ?",
      )
      .run(tools, at, at, name);
  }

  /** A server whose tools could not be read: its state, why in words, and when. */
  setCheckFailed(name: string, status: McpStatus, words: string, at: string): void {
    this.db
      .prepare("update mcp_server set status = ?, last_error = ?, checked_at = ? where name = ?")
      .run(status, words, at, name);
  }

  /** Forgets the sign-ins started that ended before `now`. */
  dropEndedSignIns(now: string): void {
    this.db.prepare("delete from mcp_sign_in where expires_at < ?").run(now);
  }

  /** An OAuth sign-in started: its state's hash, its sealed verifier and when it ends. */
  addSignIn(s: {
    stateHash: string;
    name: string;
    verifierSealed: string;
    redirectUri: string;
    expiresAt: string;
    by: string;
  }): void {
    this.db
      .prepare(
        "insert into mcp_sign_in (state_hash, name, verifier_sealed, redirect_uri, expires_at, started_by) values (?, ?, ?, ?, ?, ?)",
      )
      .run(s.stateHash, s.name, s.verifierSealed, s.redirectUri, s.expiresAt, s.by);
  }

  /** The server of a sign-in started, by its state's hash. */
  signInName(stateHash: string): Row | undefined {
    return this.db.prepare("select name from mcp_sign_in where state_hash = ?").get(stateHash) as
      | Row
      | undefined;
  }

  /** A sign-in started, by its state's hash. */
  signIn(stateHash: string): Row | undefined {
    return this.db.prepare("select * from mcp_sign_in where state_hash = ?").get(stateHash) as
      | Row
      | undefined;
  }

  /** A sign-in started is used, or given up: its state no longer works. */
  deleteSignIn(stateHash: string): void {
    this.db.prepare("delete from mcp_sign_in where state_hash = ?").run(stateHash);
  }

  /**
   * Goal 065's outside knowledge bases become ordinary MCP servers, once, at the update: each one
   * a server with a key (Authorization: Bearer and its token, kept). Copies of campaigns' collections
   * stop (the pages already written stay on the server), and the campaigns' grants to search them
   * go: a kit names a server now. The audit says what each became and what stopped. The grants
   * are the knowledge base's rows, removed here as part of this one migration.
   */
  migrateOutsideKb(secrets: SecretBox): void {
    const has = (t: string) =>
      Boolean(
        this.db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t),
      );
    if (!has("outside_kb")) return;
    const rows = this.db.prepare("select * from outside_kb order by name").all() as Row[];
    const copies = has("outside_kb_copy")
      ? (this.db.prepare("select kb, campaign from outside_kb_copy").all() as Row[])
      : [];
    const grants = has("kb_read")
      ? (this.db
          .prepare("select campaign, reads from kb_read where reads like 'outside:%'")
          .all() as Row[])
      : [];
    this.tx(() => {
      for (const k of rows) {
        const old = str(k.name);
        let name =
          old
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "kb";
        if (!/^[a-z0-9]/.test(name)) name = `kb-${name}`;
        name = name.slice(0, 64);
        for (let n = 2; this.row(name); n++) name = `${name.slice(0, 60)}-${n}`;
        let token: string | undefined;
        try {
          token = secrets.open(str(k.token_sealed));
        } catch {
          token = undefined;
        }
        const value = token ? `Bearer ${token}` : undefined;
        let tools: McpTool[] | null = null;
        try {
          const names = k.tools ? (JSON.parse(str(k.tools)) as string[]) : null;
          tools = names ? names.map((n) => ({ name: n, description: "", reads: false })) : null;
        } catch {
          tools = null;
        }
        const now = new Date().toISOString();
        this.db
          .prepare(
            `insert into mcp_server (name, url, auth, header, secret_sealed, secret_hint, status, last_error,
           tools, tools_at, migrated_from, created_at, created_by, updated_at)
         values (?, ?, 'key', 'Authorization', ?, ?, ?, ?, ?, ?, 'outside_kb', ?, ?, ?)`,
          )
          .run(
            name,
            str(k.mcp_url),
            value ? secrets.seal(value) : null,
            token ? keyHint(token) : null,
            value ? "unchecked" : "failing",
            value ? null : "Its token could not be opened at the update. Enter the key again.",
            tools ? JSON.stringify(tools) : null,
            tools ? orNull(k.checked_at) : null,
            orNull(k.created_at) ?? now,
            orNull(k.created_by) ?? "control",
            now,
          );
        this.store.auditLog.add("control", "outside_kb_migrated", {
          outside_kb: old,
          mcp_server: name,
          token: token ? "kept" : "could not be opened",
          copies_stopped: copies.filter((c) => str(c.kb) === old).map((c) => str(c.campaign)),
          grants_removed: grants
            .filter((g) => str(g.reads) === `outside:${old}`)
            .map((g) => str(g.campaign)),
        });
        log("control", "outside knowledge base kept as an MCP server", { from: old, name });
      }
      if (grants.length) {
        if (has("kb_grant_item"))
          this.db.prepare("delete from kb_grant_item where reads like 'outside:%'").run();
        this.db.prepare("delete from kb_read where reads like 'outside:%'").run();
      }
      this.db.exec("drop table if exists outside_kb_copy");
      this.db.exec("drop table outside_kb");
    });
  }
}

import { type McpStatus, type McpTool, type Row, str } from "../mcp-servers/index.ts";
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
}

import type { McpServerRows } from "../mcp-servers.ts";
import { PgPart } from "./part.ts";

/** A row of a server or of a sign-in, as its interface gives it. */
type Row = NonNullable<Awaited<ReturnType<McpServerRows["row"]>>>;
/** A server's state, as its interface takes it. */
type McpStatus = Parameters<McpServerRows["setState"]>[1];
/** A value as text; nothing as no text. */
const str = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);

/**
 * MCP servers' rows in control's store (goal 068; goal 125, T6): each server, its secrets sealed
 * with control's secret box, its state and its tools as last read, and the OAuth sign-ins started
 * on servers' pages. McpServers (mcp-servers.ts) is their interface; it seals and opens.
 */

/** McpServerRows on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresMcpServerRows extends PgPart implements McpServerRows {
  /** The names of the servers in Settings. */
  async names(): Promise<Set<string>> {
    return new Set(
      ((await this.q.all("select name from mcp_server")) as Row[]).map((r) => str(r.name)),
    );
  }

  /** Each server's tools' names, by server; null for a server whose tools were never read. */
  async toolNames(): Promise<Map<string, string[] | null>> {
    return new Map(
      ((await this.q.all("select name, tools from mcp_server")) as Row[]).map((r) => {
        let tools: string[] | null = null;
        try {
          tools = r.tools
            ? (JSON.parse(str(r.tools)) as { name: string }[]).map((t) => t.name)
            : null;
        } catch {
          tools = null;
        }
        return [str(r.name), tools] as const;
      }),
    );
  }

  /** Every server's row, by name. */
  async list(): Promise<Row[]> {
    return (await this.q.all("select * from mcp_server order by name")) as Row[];
  }

  /** A server's row, by its name. */
  async row(name: string): Promise<Row | undefined> {
    return (await this.q.get("select * from mcp_server where name = ?", name)) as Row | undefined;
  }

  /** A server added, or changed: a change keeps its row's tools and when they were read. */
  async put(s: {
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
  }): Promise<void> {
    await this.q.run(
      `insert into mcp_server (name, url, auth, header, client_id, scope, secret_sealed, secret_hint,
           login_sealed, status, created_at, created_by, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (name) do update set url = excluded.url, auth = excluded.auth,
           header = excluded.header, client_id = excluded.client_id, scope = excluded.scope,
           secret_sealed = excluded.secret_sealed, secret_hint = excluded.secret_hint,
           login_sealed = excluded.login_sealed, status = excluded.status, last_error = null,
           updated_at = excluded.updated_at`,
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
  async delete(name: string): Promise<void> {
    await this.q.run("delete from mcp_sign_in where name = ?", name);
    await this.q.run("delete from mcp_server where name = ?", name);
  }

  /** A server's state and its last error. */
  async setState(name: string, status: McpStatus, error: string | null): Promise<void> {
    await this.q.run(
      "update mcp_server set status = ?, last_error = ? where name = ?",
      status,
      error,
      name,
    );
  }

  /** A server's sign-in, sealed. */
  async setLogin(name: string, sealed: string): Promise<void> {
    await this.q.run("update mcp_server set login_sealed = ? where name = ?", sealed, name);
  }

  /** When control last tried to read a server's tools. */
  async setCheckedAt(name: string, at: string): Promise<void> {
    await this.q.run("update mcp_server set checked_at = ? where name = ?", at, name);
  }

  /** A server's tools as read now (JSON): it works. */
  async setTools(name: string, tools: string, at: string): Promise<void> {
    await this.q.run(
      "update mcp_server set status = 'ok', last_error = null, tools = ?, tools_at = ?, checked_at = ? where name = ?",
      tools,
      at,
      at,
      name,
    );
  }

  /** A server whose tools could not be read: its state, why in words, and when. */
  async setCheckFailed(name: string, status: McpStatus, words: string, at: string): Promise<void> {
    await this.q.run(
      "update mcp_server set status = ?, last_error = ?, checked_at = ? where name = ?",
      status,
      words,
      at,
      name,
    );
  }

  /** Forgets the sign-ins started that ended before `now`. */
  async dropEndedSignIns(now: string): Promise<void> {
    await this.q.run("delete from mcp_sign_in where expires_at < ?", now);
  }

  /** An OAuth sign-in started: its state's hash, its sealed verifier and when it ends. */
  async addSignIn(s: {
    stateHash: string;
    name: string;
    verifierSealed: string;
    redirectUri: string;
    expiresAt: string;
    by: string;
  }): Promise<void> {
    await this.q.run(
      "insert into mcp_sign_in (state_hash, name, verifier_sealed, redirect_uri, expires_at, started_by) values (?, ?, ?, ?, ?, ?)",
      s.stateHash,
      s.name,
      s.verifierSealed,
      s.redirectUri,
      s.expiresAt,
      s.by,
    );
  }

  /** The server of a sign-in started, by its state's hash. */
  async signInName(stateHash: string): Promise<Row | undefined> {
    return (await this.q.get("select name from mcp_sign_in where state_hash = ?", stateHash)) as
      | Row
      | undefined;
  }

  /** A sign-in started, by its state's hash. */
  async signIn(stateHash: string): Promise<Row | undefined> {
    return (await this.q.get("select * from mcp_sign_in where state_hash = ?", stateHash)) as
      | Row
      | undefined;
  }

  /** A sign-in started is used, or given up: its state no longer works. */
  async deleteSignIn(stateHash: string): Promise<void> {
    await this.q.run("delete from mcp_sign_in where state_hash = ?", stateHash);
  }
}

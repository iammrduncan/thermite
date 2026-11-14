import { createHash } from "node:crypto";
import { canonicalJson } from "../../../core/canonical.ts";
import {
  type AuditEntry,
  type AuditFilter,
  type AuditLog,
  COLUMNS,
  RETENTION_REMOVED_ACTION,
} from "../audit.ts";
import { jsonText, PgPart, type Row } from "./part.ts";

/** Whether an action starts with these letters, as they are: `_` is itself. */
const starts = (letters: string) => `starts_with(action, '${letters}')`;
/** Whether an action holds these letters. */
const holds = (letters: string) => `strpos(action, '${letters}') > 0`;

/** The kind of actor an entry is by, from the actor's form (../audit.ts, AUDIT_ACTORS). */
const ACTOR_SQL = `case
  when starts_with(actor, 'owner') then 'owner'
  when starts_with(actor, 'operator') then 'operator'
  when starts_with(actor, 'agent') then 'agent'
  when starts_with(actor, 'rig:') then 'rig'
  else 'control' end`;

/** An entry's kind, as SQL works it out from its action; order matters. */
const KIND_SQL = `case
  when ${starts("mcp:")} then 'mcp'
  when ${starts("command_")} then 'command'
  when ${holds("refused")} or ${holds("throttled")} then 'refusal'
  when ${starts("export")} then 'export'
  when ${starts("kb_")} then 'kb'
  when ${starts("rig_")} or ${starts("runpod_")} or ${starts("machine_")}
    or ${starts("cluster_")} or ${starts("tunnel_")} or ${starts("join")} then 'rig'
  when ${starts("login")} or ${starts("session")} or ${starts("sign")} then 'session'
  else 'other' end`;

/** A filter as SQL: its condition and its values, in order. */
function filterSql(f: AuditFilter): { where: string; args: (string | number)[] } {
  const parts = [`(?::int = 1 or not ${starts("mcp:")})`, "strpos(action, ?) > 0"];
  const args: (string | number)[] = [f.mcp === false ? 0 : 1, f.action ?? ""];
  const among = (expr: string, values: readonly string[] | undefined) => {
    if (!values?.length) return;
    parts.push(`${expr} in (${values.map(() => "?").join(", ")})`);
    args.push(...values);
  };
  among(KIND_SQL, f.kinds);
  among(ACTOR_SQL, f.actors);
  among(jsonText("body", "rig"), f.rigs);
  if (f.words?.trim()) {
    parts.push("strpos(lower(action || ' ' || body), lower(?)) > 0");
    args.push(f.words.trim());
  }
  return { where: parts.join(" and "), args };
}

/** AuditLog on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresAuditLog extends PgPart implements AuditLog {
  /**
   * Every entry an audit-log policy may remove, as it reads them: its id, when it came and about
   * how many bytes it takes. A policy's removal's own entry is never one of them.
   */
  async retentionItems(): Promise<{ id: number; at: string; bytes: number }[]> {
    return (
      (await this.q.all(
        `select id, at, length(at) + length(actor) + length(action) + length(body) + 32 as bytes
           from audit where action != ? order by id`,
        RETENTION_REMOVED_ACTION,
      )) as Row[]
    ).map((r) => ({ id: Number(r.id), at: String(r.at), bytes: Number(r.bytes) }));
  }

  /** Removes the entries a policy covers, never a removal's own; how many went. */
  async removeEntries(ids: readonly number[]): Promise<number> {
    const del = "delete from audit where id = ? and action != ?";
    let n = 0;
    for (const id of ids)
      n += Number((await this.q.run(del, id, RETENTION_REMOVED_ACTION)).changes);
    return n;
  }

  async add(actor: string, action: string, body: unknown): Promise<void> {
    await this.q.run(
      "insert into audit (at, actor, action, body) values (?, ?, ?, ?)",
      new Date().toISOString(),
      actor,
      action,
      canonicalJson(body ?? {}),
    );
  }

  /**
   * The newest entry's number, 0 with none: it moves with every change the owner, an agent or
   * control makes, so the dashboard's stream can tell that something changed.
   */
  async newestId(): Promise<number> {
    const row = (await this.q.get("select max(id) as id from audit")) as Row | undefined;
    return Number(row?.id ?? 0);
  }

  /**
   * A refusal of a rig's or a token's call, written as add writes an entry, but once: a repeat
   * (the same actor, action and body, so the same route and reason) adds no entry. It counts on
   * the first one, and moves that one's last time.
   */
  async refusal(actor: string, action: string, body: unknown): Promise<void> {
    const text = canonicalJson(body ?? {});
    const repeat = createHash("sha256").update(text).digest("hex");
    await this.q.run(
      `insert into audit (at, actor, action, body, repeat) values (?, ?, ?, ?, ?)
        on conflict (actor, action, repeat) do update set count = audit.count + 1, last_at = excluded.at`,
      new Date().toISOString(),
      actor,
      action,
      text,
      repeat,
    );
  }

  /** The newest audit entries; `action` keeps those whose action contains it, `mcp` MCP reads. */
  async list(limit = 200, filter: AuditFilter = {}): Promise<AuditEntry[]> {
    return (await this.page(limit, filter)).entries;
  }

  /**
   * One page of the audit log, newest first (goal 015). With no cursor, the newest entries;
   * `before` keeps those older than it, `after` those newer. `older` and `newer` are the cursors
   * for the next page each way: give `older` as `before`, `newer` as `after`. Null when no entry
   * that matches is left that way.
   */
  async page(
    limit = 200,
    filter: AuditFilter = {},
    cursor: { before?: number | undefined; after?: number | undefined } = {},
  ): Promise<{ entries: AuditEntry[]; older: number | null; newer: number | null }> {
    const { where: match, args } = filterSql(filter);
    const { before, after } = cursor;
    const rows = (
      after !== undefined
        ? (
            (await this.q.all(
              `select ${COLUMNS} from audit where ${match} and id > ? order by id limit ?`,
              ...args,
              after,
              limit,
            )) as Row[]
          )
            // The entries just after the cursor, shown newest first like every page.
            .reverse()
        : ((await this.q.all(
            `select ${COLUMNS} from audit where ${match} and id < ? order by id desc limit ?`,
            ...args,
            before ?? Number.MAX_SAFE_INTEGER,
            limit,
          )) as Row[])
    ).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      body: JSON.parse(String(r.body)),
      count: Number(r.count),
      last_at: String(r.last_at),
    }));
    const any = async (where: string, id: number) =>
      (await this.q.get(
        `select 1 from audit where ${match} and id ${where} ? limit 1`,
        ...args,
        id,
      )) !== undefined;
    // The edges of this page; an empty page has them at its cursor.
    const hi = rows[0]?.id ?? (before !== undefined ? Math.max(0, before - 1) : after);
    const lo = rows.at(-1)?.id ?? (after !== undefined ? after + 1 : before);
    return {
      entries: rows,
      older: lo !== undefined && (await any("<", lo)) ? lo : null,
      newer: hi !== undefined && (await any(">", hi)) ? hi : null,
    };
  }

  /**
   * How many entries match: all of them, and those newer than `after` (where a page starts in the
   * list), for the audit log page's "1–50 of N".
   */
  async count(filter: AuditFilter = {}, after?: number): Promise<number> {
    const { where, args } = filterSql(filter);
    const more = after === undefined ? "" : " and id > ?";
    const r = (await this.q.get(
      `select count(*) as n from audit where ${where}${more}`,
      ...args,
      ...(after === undefined ? [] : [after]),
    )) as { n: number };
    return Number(r.n);
  }

  /**
   * The items control refused a writer of a run (`kb_item_refused`, goal 175), by its slot: how
   * many, and the newest `limit`, newest first, each with when and why.
   */
  /**
   * The writes control refused into the knowledge base (kb_item_refused), newest first: a page of
   * rows, each with how many times it came, and how many rows there are.
   */
  async kbRefusedPage(
    offset: number,
    limit: number,
  ): Promise<{
    total: number;
    rows: { at: string; rig: string; run: string; slot: string; why: string; count: number }[];
  }> {
    const where = "action = 'kb_item_refused'";
    const total = (await this.q.get(`select count(*) as n from audit where ${where}`)) as Row;
    const rows = (await this.q.all(
      `select at, body, count from audit where ${where} order by id desc limit ? offset ?`,
      limit,
      offset,
    )) as Row[];
    return {
      total: Number(total.n),
      rows: rows.map((r) => {
        const b = JSON.parse(String(r.body)) as Record<string, unknown>;
        const s = (v: unknown) => (typeof v === "string" ? v : "");
        return {
          at: String(r.at),
          rig: s(b.rig),
          run: s(b.run),
          slot: s(b.slot) || s(b.writer),
          why: s(b.why),
          count: Number(r.count ?? 1),
        };
      }),
    };
  }

  async kbRefusals(
    run: string,
    slot: string,
    limit: number,
  ): Promise<{ total: number; newest: { at: string; event: number | null; why: string }[] }> {
    const where = `action = 'kb_item_refused' and ${jsonText("body", "run")} = ?
      and (${jsonText("body", "slot")} = ? or ${jsonText("body", "writer")} = ?)`;
    const total = (await this.q.get(
      `select coalesce(sum(count), 0) as n from audit where ${where}`,
      run,
      slot,
      slot,
    )) as Row;
    const rows = (await this.q.all(
      `select at, body from audit where ${where} order by id desc limit ?`,
      run,
      slot,
      slot,
      limit,
    )) as Row[];
    return {
      total: Number(total.n),
      newest: rows.map((r) => {
        const b = JSON.parse(String(r.body)) as { event?: unknown; why?: unknown };
        return {
          at: String(r.at),
          event: typeof b.event === "number" ? b.event : null,
          why: String(b.why ?? ""),
        };
      }),
    };
  }

  /** The body of the newest audit entry by this actor with this action, if there is one. */
  async last(actor: string, action: string): Promise<unknown> {
    const r = (await this.q.get(
      "select body from audit where actor = ? and action = ? order by id desc limit 1",
      actor,
      action,
    )) as Row | undefined;
    return r ? JSON.parse(String(r.body)) : undefined;
  }
}

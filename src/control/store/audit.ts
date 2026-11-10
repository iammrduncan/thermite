import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../core/canonical.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Control's audit log (goal 125, T6): who did what, when, read a page at a time. Each entry is
 * kept until an audit-log retention policy the owner made removes it; never the entry of a
 * policy's removal (RETENTION_REMOVED_ACTION). A refusal that repeats (the same rig or token, route and reason) is one entry,
 * with how many times it came and its first and last time.
 */

/**
 * One entry of control's audit log. Its id is the cursor that pages through the log. `at` is
 * when it came first; `count` how many times it came (1 but for a repeated refusal), and
 * `last_at` when it came last (`at` when once).
 */
export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  body: unknown;
  count: number;
  last_at: string;
}

/**
 * Store migration 19: an entry may stand for repeats, with their count and the last one's time.
 * `repeat` names what repeats (a hash of the entry's body); the index finds a repeat's entry, and
 * an actor's newest entry of an action.
 */
export function auditRepeats(db: DatabaseSync): void {
  const cols = (db.prepare("pragma table_info(audit)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("count"))
    db.exec("alter table audit add column count integer not null default 1");
  if (!cols.includes("last_at")) db.exec("alter table audit add column last_at text");
  if (!cols.includes("repeat")) db.exec("alter table audit add column repeat text");
  db.exec("create unique index if not exists audit_repeat on audit (actor, action, repeat)");
}

/**
 * Which audit entries a list keeps: `action` those whose action contains it; `mcp` false, no MCP
 * calls; `kinds` those of these kinds (AUDIT_KINDS), `actors` those of these kinds of actor
 * (AUDIT_ACTORS), `rigs` those about these rigs (the entry's `rig`), `words` those whose action
 * or body holds them. An empty list keeps every entry.
 */
export interface AuditFilter {
  action?: string | undefined;
  mcp?: boolean | undefined;
  kinds?: readonly string[] | undefined;
  actors?: readonly string[] | undefined;
  rigs?: readonly string[] | undefined;
  words?: string | undefined;
}

/** The kinds of entry the audit log page filters by (goal 181), each from its action's form. */
export const AUDIT_KINDS = [
  "command",
  "refusal",
  "export",
  "rig",
  "kb",
  "session",
  "other",
  "mcp",
] as const;

/** An entry's kind, as SQL works it out from its action (GLOB: `_` is itself); order matters. */
const KIND_SQL = `case
  when action glob 'mcp:*' then 'mcp'
  when action glob 'command_*' then 'command'
  when action = 'refused' or action glob '*refused*' or action glob '*throttled*' then 'refusal'
  when action glob 'export*' then 'export'
  when action glob 'kb_*' then 'kb'
  when action glob 'rig_*' or action glob 'runpod_*' or action glob 'machine_*'
    or action glob 'cluster_*' or action glob 'tunnel_*' or action glob 'join*' then 'rig'
  when action glob 'login*' or action glob 'session*' or action glob 'sign*' then 'session'
  else 'other' end`;

/** The kinds of actor the audit log page filters by, from the actor's form. */
export const AUDIT_ACTORS = ["owner", "operator", "agent", "rig", "control"] as const;
const ACTOR_SQL = `case
  when actor glob 'owner*' then 'owner'
  when actor glob 'operator*' then 'operator'
  when actor glob 'agent*' then 'agent'
  when actor glob 'rig:*' then 'rig'
  else 'control' end`;

/** A filter as SQL: its condition and its values, in order. */
function filterSql(f: AuditFilter): { where: string; args: (string | number)[] } {
  const parts = ["(? or action not like 'mcp:%')", "instr(action, ?) > 0"];
  const args: (string | number)[] = [f.mcp === false ? 0 : 1, f.action ?? ""];
  const among = (expr: string, values: readonly string[] | undefined) => {
    if (!values?.length) return;
    parts.push(`${expr} in (${values.map(() => "?").join(", ")})`);
    args.push(...values);
  };
  among(KIND_SQL, f.kinds);
  among(ACTOR_SQL, f.actors);
  among("json_extract(body, '$.rig')", f.rigs);
  if (f.words?.trim()) {
    parts.push("instr(lower(action || ' ' || body), lower(?)) > 0");
    args.push(f.words.trim());
  }
  return { where: parts.join(" and "), args };
}

/** An audit page's cursor from a query string: a whole number of 0 or more, or none. */
export function cursorOf(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** What a page reads of each entry; an entry that came once has no last time of its own. */
const COLUMNS = "id, at, actor, action, body, count, coalesce(last_at, at) as last_at";

/** The action of a retention policy's removal: no policy removes its entry. */
export const RETENTION_REMOVED_ACTION = "retention_removed";

export class AuditLog extends StorePart {
  /**
   * Every entry an audit-log policy may remove, as it reads them: its id, when it came and about
   * how many bytes it takes. A policy's removal's own entry is never one of them.
   */
  retentionItems(): { id: number; at: string; bytes: number }[] {
    return (
      this.db
        .prepare(
          `select id, at, length(at) + length(actor) + length(action) + length(body) + 32 as bytes
           from audit where action != ? order by id`,
        )
        .all(RETENTION_REMOVED_ACTION) as Row[]
    ).map((r) => ({ id: Number(r.id), at: String(r.at), bytes: Number(r.bytes) }));
  }

  /** Removes the entries a policy covers, never a removal's own; how many went. */
  removeEntries(ids: readonly number[]): number {
    const del = this.db.prepare("delete from audit where id = ? and action != ?");
    let n = 0;
    for (const id of ids) n += Number(del.run(id, RETENTION_REMOVED_ACTION).changes);
    return n;
  }

  add(actor: string, action: string, body: unknown): void {
    this.db
      .prepare("insert into audit (at, actor, action, body) values (?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, canonicalJson(body ?? {}));
  }

  /**
   * The newest entry's number, 0 with none: it moves with every change the owner, an agent or
   * control makes, so the dashboard's stream can tell that something changed.
   */
  newestId(): number {
    const row = this.db.prepare("select max(id) as id from audit").get() as Row | undefined;
    return Number(row?.id ?? 0);
  }

  /**
   * A refusal of a rig's or a token's call, written as add writes an entry, but once: a repeat
   * (the same actor, action and body, so the same route and reason) adds no entry. It counts on
   * the first one, and moves that one's last time.
   */
  refusal(actor: string, action: string, body: unknown): void {
    const text = canonicalJson(body ?? {});
    const repeat = createHash("sha256").update(text).digest("hex");
    this.db
      .prepare(
        `insert into audit (at, actor, action, body, repeat) values (?, ?, ?, ?, ?)
        on conflict (actor, action, repeat) do update set count = count + 1, last_at = excluded.at`,
      )
      .run(new Date().toISOString(), actor, action, text, repeat);
  }

  /** The newest audit entries; `action` keeps those whose action contains it, `mcp` MCP reads. */
  list(limit = 200, filter: AuditFilter = {}): AuditEntry[] {
    return this.page(limit, filter).entries;
  }

  /**
   * One page of the audit log, newest first (goal 015). With no cursor, the newest entries;
   * `before` keeps those older than it, `after` those newer. `older` and `newer` are the cursors
   * for the next page each way: give `older` as `before`, `newer` as `after`. Null when no entry
   * that matches is left that way.
   */
  page(
    limit = 200,
    filter: AuditFilter = {},
    cursor: { before?: number | undefined; after?: number | undefined } = {},
  ): { entries: AuditEntry[]; older: number | null; newer: number | null } {
    const { where: match, args } = filterSql(filter);
    const { before, after } = cursor;
    const rows = (
      after !== undefined
        ? (
            this.db
              .prepare(`select ${COLUMNS} from audit where ${match} and id > ? order by id limit ?`)
              .all(...args, after, limit) as Row[]
          )
            // The entries just after the cursor, shown newest first like every page.
            .reverse()
        : (this.db
            .prepare(
              `select ${COLUMNS} from audit where ${match} and id < ? order by id desc limit ?`,
            )
            .all(...args, before ?? Number.MAX_SAFE_INTEGER, limit) as Row[])
    ).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      body: JSON.parse(String(r.body)),
      count: Number(r.count),
      last_at: String(r.last_at),
    }));
    const any = (where: string, id: number) =>
      this.db
        .prepare(`select 1 from audit where ${match} and id ${where} ? limit 1`)
        .get(...args, id) !== undefined;
    // The edges of this page; an empty page has them at its cursor.
    const hi = rows[0]?.id ?? (before !== undefined ? Math.max(0, before - 1) : after);
    const lo = rows.at(-1)?.id ?? (after !== undefined ? after + 1 : before);
    return {
      entries: rows,
      older: lo !== undefined && any("<", lo) ? lo : null,
      newer: hi !== undefined && any(">", hi) ? hi : null,
    };
  }

  /**
   * How many entries match: all of them, and those newer than `after` (where a page starts in the
   * list), for the audit log page's "1–50 of N".
   */
  count(filter: AuditFilter = {}, after?: number): number {
    const { where, args } = filterSql(filter);
    const more = after === undefined ? "" : " and id > ?";
    const r = this.db
      .prepare(`select count(*) as n from audit where ${where}${more}`)
      .get(...args, ...(after === undefined ? [] : [after])) as { n: number };
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
  kbRefusedPage(
    offset: number,
    limit: number,
  ): {
    total: number;
    rows: { at: string; rig: string; run: string; slot: string; why: string; count: number }[];
  } {
    const where = "action = 'kb_item_refused'";
    const total = this.db.prepare(`select count(*) as n from audit where ${where}`).get() as Row;
    const rows = this.db
      .prepare(`select at, body, count from audit where ${where} order by id desc limit ? offset ?`)
      .all(limit, offset) as Row[];
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

  kbRefusals(
    run: string,
    slot: string,
    limit: number,
  ): { total: number; newest: { at: string; event: number | null; why: string }[] } {
    const where = `action = 'kb_item_refused' and json_extract(body, '$.run') = ?
      and (json_extract(body, '$.slot') = ? or json_extract(body, '$.writer') = ?)`;
    const total = this.db
      .prepare(`select coalesce(sum(count), 0) as n from audit where ${where}`)
      .get(run, slot, slot) as Row;
    const rows = this.db
      .prepare(`select at, body from audit where ${where} order by id desc limit ?`)
      .all(run, slot, slot, limit) as Row[];
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
  last(actor: string, action: string): unknown {
    const r = this.db
      .prepare("select body from audit where actor = ? and action = ? order by id desc limit 1")
      .get(actor, action) as Row | undefined;
    return r ? JSON.parse(String(r.body)) : undefined;
  }
}

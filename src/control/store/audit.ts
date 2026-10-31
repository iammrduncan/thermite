import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../core/canonical.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Control's audit log (goal 125, T6): who did what, when, read a page at a time. Each entry is
 * kept for good. A refusal that repeats (the same rig or token, route and reason) is one entry,
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

/** Which audit entries a list keeps: `action` those whose action contains it; `mcp` false, no MCP calls. */
export interface AuditFilter {
  action?: string | undefined;
  mcp?: boolean | undefined;
}

/** An audit page's cursor from a query string: a whole number of 0 or more, or none. */
export function cursorOf(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** What a page reads of each entry; an entry that came once has no last time of its own. */
const COLUMNS = "id, at, actor, action, body, count, coalesce(last_at, at) as last_at";

export class AuditLog extends StorePart {
  add(actor: string, action: string, body: unknown): void {
    this.db
      .prepare("insert into audit (at, actor, action, body) values (?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, canonicalJson(body ?? {}));
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
    const match = "(? or action not like 'mcp:%') and instr(action, ?) > 0";
    const args = [filter.mcp === false ? 0 : 1, filter.action ?? ""] as const;
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
   * The items control refused a writer of a run (`kb_item_refused`, goal 175), by its slot: how
   * many, and the newest `limit`, newest first, each with when and why.
   */
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

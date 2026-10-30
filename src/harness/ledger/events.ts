import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { EventBodies } from "../../core/events/bodies.ts";
import type { EventKind } from "../../core/events/kinds.ts";
import { currentEvent, eventKinds } from "../../core/names.ts";

/**
 * The ledger's events, read (goal 125, T6): the one module that queries the event table for the
 * rest of the harness. Each read is typed by its kind's body, and reads events recorded before the
 * 2026-10-15 rename under the new kinds and keys (core/names.ts), as the ledger's own reads do.
 */

/** An event of one of `K`'s kinds, as read: one type for each kind, so its `kind` narrows it. */
export type ReadEvent<K extends EventKind> = K extends EventKind
  ? {
      id: number;
      at: string;
      actor: string;
      kind: K;
      subject: string | null;
      body: EventBodies[K];
      run: string | null;
    }
  : never;

/**
 * Which events: about `subject` (null: none), recorded by `actor`, after an event (`after`, its
 * id), or up to one (`through`), at `since` or later, and whose body has these top-level values
 * (`body`), values above these numbers (`above`), and a value at each of these keys (`has`).
 */
export interface EventQuery {
  subject?: string | null | undefined;
  actor?: string | undefined;
  after?: number | undefined;
  through?: number | undefined;
  since?: string | undefined;
  body?: Record<string, string | number | boolean | null> | undefined;
  above?: Record<string, number> | undefined;
  has?: readonly string[] | undefined;
}

/** A body key a query may name in SQL. */
function bodyKey(key: string): string {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`not a body key to match: ${key}`);
  return key;
}

export class LedgerEvents {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The `where` of a query over `kinds`, with its parameters. */
  private where(kinds: readonly EventKind[], q: EventQuery): [string, SQLInputValue[]] {
    const all = kinds.flatMap((k) => eventKinds(k));
    const parts = [`kind in (${all.map(() => "?").join(", ")})`];
    const args: SQLInputValue[] = [...all];
    const add = (part: string, ...values: SQLInputValue[]) => {
      parts.push(part);
      args.push(...values);
    };
    if (q.subject === null) add("subject is null");
    else if (q.subject !== undefined) add("subject = ?", q.subject);
    if (q.actor !== undefined) add("actor = ?", q.actor);
    if (q.after !== undefined) add("id > ?", q.after);
    if (q.through !== undefined) add("id <= ?", q.through);
    if (q.since !== undefined) add("at >= ?", q.since);
    for (const [key, value] of Object.entries(q.body ?? {})) {
      if (value === null) add(`json_extract(body, '$.${bodyKey(key)}') is null`);
      else
        add(
          `json_extract(body, '$.${bodyKey(key)}') = ?`,
          typeof value === "boolean" ? Number(value) : value,
        );
    }
    for (const [key, value] of Object.entries(q.above ?? {}))
      add(`json_extract(body, '$.${bodyKey(key)}') > ?`, value);
    for (const key of q.has ?? []) add(`json_extract(body, '$.${bodyKey(key)}') is not null`);
    return [parts.join(" and "), args];
  }

  private read<K extends EventKind>(rows: Record<string, SQLInputValue>[]): ReadEvent<K>[] {
    return rows.map(
      (r) =>
        currentEvent({
          id: Number(r.id),
          at: String(r.at),
          actor: String(r.actor),
          kind: String(r.kind),
          subject: r.subject === null ? null : String(r.subject),
          body: JSON.parse(String(r.body)),
          run: r.run === null || r.run === undefined ? null : String(r.run),
        }) as ReadEvent<K>,
    );
  }

  /** The newest event of `kind` (or of any of `kind`) that matches `q`, if any. */
  newest<K extends EventKind>(
    kind: K | readonly K[],
    q: EventQuery = {},
  ): ReadEvent<K> | undefined {
    const [where, args] = this.where(typeof kind === "string" ? [kind] : kind, q);
    const rows = this.db
      .prepare(`select * from event where ${where} order by id desc limit 1`)
      .all(...args) as Record<string, SQLInputValue>[];
    return this.read<K>(rows)[0];
  }

  /** Every event of `kind` (or of any of `kind`) that matches `q`, oldest first. */
  list<K extends EventKind>(kind: K | readonly K[], q: EventQuery = {}): ReadEvent<K>[] {
    const [where, args] = this.where(typeof kind === "string" ? [kind] : kind, q);
    const rows = this.db
      .prepare(`select * from event where ${where} order by id`)
      .all(...args) as Record<string, SQLInputValue>[];
    return this.read<K>(rows);
  }

  /** How many events of `kind` (or of any of `kind`) match `q`. */
  count(kind: EventKind | readonly EventKind[], q: EventQuery = {}): number {
    const [where, args] = this.where(typeof kind === "string" ? [kind] : kind, q);
    const r = this.db.prepare(`select count(*) as n from event where ${where}`).get(...args) as {
      n: number;
    };
    return Number(r.n);
  }

  /** The id of the newest event of `kind` (or of any of `kind`) that matches `q`; 0 when none. */
  lastId(kind: EventKind | readonly EventKind[], q: EventQuery = {}): number {
    const [where, args] = this.where(typeof kind === "string" ? [kind] : kind, q);
    const r = this.db.prepare(`select max(id) as id from event where ${where}`).get(...args) as {
      id: number | null;
    };
    return Number(r.id ?? 0);
  }

  /** When the newest event, of any kind, was recorded; none in an empty ledger. */
  lastAt(): string | undefined {
    const r = this.db.prepare("select at from event order by id desc limit 1").get() as
      | { at: string }
      | undefined;
    return r?.at;
  }

  /** The kind of the event with this id, if there is one. */
  kindOf(id: number): string | undefined {
    const r = this.db.prepare("select kind from event where id = ?").get(id) as
      | { kind: string }
      | undefined;
    return r ? currentEvent({ kind: r.kind, body: {} }).kind : undefined;
  }

  /** How many events of each kind were recorded after the event `after`. */
  countsByKind(after: number): Record<string, number> {
    const rows = this.db
      .prepare("select kind, count(*) as n from event where id > ? group by kind")
      .all(after) as { kind: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) {
      const kind = currentEvent({ kind: r.kind, body: {} }).kind;
      out[kind] = (out[kind] ?? 0) + Number(r.n);
    }
    return out;
  }
}

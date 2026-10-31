import type { DatabaseSync } from "node:sqlite";
import { type Row, StorePart } from "./part.ts";

/**
 * Control's events table, `rig_event`, as a store from before the message bus's events stream
 * holds it (goal 168, step 4). Control publishes every event of a report to the stream before it
 * answers (control/events), and keeps none here. A store from before that has its table moved to
 * the stream once, at control's start, and checked there (control/events/move.ts); store
 * migration 12 then drops the table, with a copy of the store kept. Until then, the move alone
 * reads it.
 */

/** The table's name. */
const TABLE = "rig_event";

/** Whether the store holds the events table. */
function hasTable(db: DatabaseSync): boolean {
  return Boolean(
    db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(TABLE),
  );
}

/** The table's rows and its last seq: 0 and 0 for a table with none, or none at all. */
function tableSize(db: DatabaseSync): { rows: number; lastSeq: number } {
  if (!hasTable(db)) return { rows: 0, lastSeq: 0 };
  const r = db.prepare(`select count(*) as rows, max(seq) as last from ${TABLE}`).get() as {
    rows: number;
    last: number | null;
  };
  return { rows: Number(r.rows), lastSeq: Number(r.last ?? 0) };
}

/**
 * A rig's events by ledger, in control's order (store migration 8): a view's pages of events
 * started at a seq and stopped after a page, where they read the whole ledger again for each page
 * and sorted it. The views read the events stream now; the migration stays, as every one does.
 */
export function eventsInOrderIndex(db: DatabaseSync): void {
  db.exec("create index if not exists rig_event_ledger_seq on rig_event (rig, ledger_id, seq)");
}

/**
 * What the move found the events stream to hold: the table's rows, whole, and its last seq. The
 * table may go only when they are still what it holds.
 */
export interface EventsMoved {
  rows: number;
  lastSeq: number;
}

/**
 * Whether the events table may go now (store migration 12): the store has none, it holds no row,
 * or the move found the stream to hold every row it holds (`moved`). Until then the migration
 * waits, and so do the migrations after it.
 */
export function eventsTableMayGo(db: DatabaseSync, moved: EventsMoved | undefined): boolean {
  const { rows, lastSeq } = tableSize(db);
  return rows === 0 || (moved?.rows === rows && moved.lastSeq === lastSeq);
}

/** Whether the events table holds a row: the copy of the store before it goes is then kept. */
export function eventsTableHoldsRows(db: DatabaseSync): boolean {
  return tableSize(db).rows > 0;
}

/**
 * Store migration 12: the events table goes, and with it the rig's `last_cursor`, which the held
 * cursor of each rig ledger (`rig_ledger.through_event`) replaced: the gap check and control's
 * place in a rig's events read that. The migration runs once eventsTableMayGo says so.
 */
export function dropEventsTable(db: DatabaseSync): void {
  db.exec(`drop table if exists ${TABLE}`);
  const cols = db.prepare("pragma table_info(rig)").all() as { name: string }[];
  if (cols.some((c) => c.name === "last_cursor"))
    db.exec("alter table rig drop column last_cursor");
}

/** A row of the table: its place there, its rig and ledger, and the event. */
export interface StoredEvent {
  seq: number;
  rig: string;
  ledger_id: string;
  event: { id: number; at: string; actor: string; kind: string; subject: string | null };
  /** The event's body, as the table keeps it: canonical JSON. */
  body: string;
  /** The run it is about; null for the rig's own events, and for events kept before goal 170. */
  run: string | null;
}

const asStored = (r: Row): StoredEvent => ({
  seq: Number(r.seq),
  rig: String(r.rig),
  ledger_id: String(r.ledger_id),
  event: {
    id: Number(r.event_id),
    at: String(r.at),
    actor: String(r.actor),
    kind: String(r.kind),
    subject: r.subject === null ? null : String(r.subject),
  },
  body: String(r.body),
  run: r.run === null || r.run === undefined ? null : String(r.run),
});

/**
 * The events table of a store from before the stream, as the move reads it: none once store
 * migration 12 dropped it. A store from v0.1.0 has no `run` column until migration 5 adds it.
 */
export class EventsTable extends StorePart {
  /** Whether the store still holds the table. */
  exists(): boolean {
    return hasTable(this.db);
  }

  /** The table's rows and its last seq: 0 and 0 when it holds none, or is gone. */
  size(): { rows: number; lastSeq: number } {
    return tableSize(this.db);
  }

  /** How many rows the table holds after a seq. */
  countAfter(seq: number): number {
    if (!this.exists()) return 0;
    const r = this.db.prepare(`select count(*) as n from ${TABLE} where seq > ?`).get(seq) as {
      n: number;
    };
    return Number(r.n);
  }

  /** Every rig's events after a seq, in the table's order, `limit` at most. */
  inOrder(after: number, limit: number): StoredEvent[] {
    if (!this.exists()) return [];
    const rows = this.db
      .prepare(
        `select seq, rig, ledger_id, event_id, at, actor, kind, subject, body, run from ${TABLE}
           where seq > ? order by seq limit ?`,
      )
      .all(after, limit) as Row[];
    return rows.map(asStored);
  }

  /** The row at a seq, or undefined when the table has none there. */
  at(seq: number): StoredEvent | undefined {
    if (!this.exists()) return undefined;
    const r = this.db
      .prepare(
        `select seq, rig, ledger_id, event_id, at, actor, kind, subject, body, run from ${TABLE}
           where seq = ?`,
      )
      .get(seq) as Row | undefined;
    return r ? asStored(r) : undefined;
  }
}

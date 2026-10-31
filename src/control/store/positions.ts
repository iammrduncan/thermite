import type { DatabaseSync } from "node:sqlite";
import { StorePart } from "./part.ts";

/**
 * How far control's store has applied the message bus's streams (goal 168, step 4): for each
 * stream, the place of the last message whose records control's store holds. The apply of the
 * events stream (control/events) writes it in the same transaction as those records, so that the
 * store and the stream never disagree about what was applied.
 */

/**
 * The tables, made by the store's migration to schema version 11: each stream's place, and each
 * rig ledger's held cursor, the last event of it the apply applied (`rig_ledger.through_event`,
 * which ReportedRigs keeps).
 */
export function appliedPlacesTables(db: DatabaseSync): void {
  db.exec(`create table if not exists bus_position (
  stream text primary key,
  seq integer not null
)`);
  const cols = db.prepare("pragma table_info(rig_ledger)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "through_event"))
    db.exec("alter table rig_ledger add column through_event integer not null default 0");
}

export class BusPositions extends StorePart {
  /** The place in the stream control's store applied through: 0 before its first message. */
  of(stream: string): number {
    const r = this.db.prepare("select seq from bus_position where stream = ?").get(stream) as
      | { seq: number }
      | undefined;
    return Number(r?.seq ?? 0);
  }

  /** The place control's store applied through now, in the transaction of what it applied. */
  set(stream: string, seq: number): void {
    this.db
      .prepare(
        "insert into bus_position (stream, seq) values (?, ?) on conflict (stream) do update set seq = excluded.seq",
      )
      .run(stream, seq);
  }
}

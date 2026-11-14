import type { EventsTable, StoredEvent } from "../events.ts";
import { PgPart } from "./part.ts";

/**
 * The events table of a store from before the events stream (../events.ts). A store on PostgreSQL
 * never had one: its events were in the stream from its first day, and a store copied from SQLite
 * is copied after its table went. So it holds none, and the move finds nothing to move.
 */
export class PostgresEventsTable extends PgPart implements EventsTable {
  async exists(): Promise<boolean> {
    return false;
  }

  async size(): Promise<{ rows: number; lastSeq: number }> {
    return { rows: 0, lastSeq: 0 };
  }

  async countAfter(_seq: number): Promise<number> {
    return 0;
  }

  async inOrder(_after: number, _limit: number): Promise<StoredEvent[]> {
    return [];
  }

  async at(_seq: number): Promise<StoredEvent | undefined> {
    return undefined;
  }
}

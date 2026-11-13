import type { DatabaseSync } from "node:sqlite";
import { type Row, StorePart } from "./part.ts";

/**
 * Add a rig's Workers at a time that control gives the new rig once it reports (goal 206): how
 * many lanes, who chose it, and control's gives of it (rigs/workers.ts). Kept here, a restart of
 * control or a rig that reports late loses nothing; its row goes once the rig took it, or would
 * not. The rig's history says how each give went.
 */

interface ChosenWorkers {
  rig: string;
  lanes: number;
  chosen_by: string;
  chosen_at: string;
  /** When control last sent it to the rig, that command's id, and how many times it sent it. */
  given?: { at: string; tries: number; command?: string | undefined } | undefined;
}

/** Made by the store's migration to schema version 35. */
export function rigWorkersTable(db: DatabaseSync): void {
  db.exec(`create table if not exists rig_workers (
  rig text primary key,
  lanes integer not null,
  chosen_by text not null,
  chosen_at text not null,
  given text
)`);
}

const read = (r: Row): ChosenWorkers => ({
  rig: String(r.rig),
  lanes: Number(r.lanes),
  chosen_by: String(r.chosen_by),
  chosen_at: String(r.chosen_at),
  ...(r.given ? { given: JSON.parse(String(r.given)) as ChosenWorkers["given"] } : {}),
});

export interface RigWorkers {
  /** The new rig's Workers at a time, to give it; a choice before it is replaced. */
  choose(rig: string, lanes: number, by: string): Promise<void>;
  get(rig: string): Promise<ChosenWorkers | undefined>;
  /** Every rig's, not taken yet. */
  waiting(): Promise<ChosenWorkers[]>;
  /** Its gives to the rig, as they stand now. */
  setGiven(rig: string, given: ChosenWorkers["given"]): Promise<void>;
  /** The rig took it, or would not: nothing more to give. */
  done(rig: string): Promise<void>;
}

/** RigWorkers on SQLite: each call answers at once (the store behind the interface, sqlite.ts). */
export class SqliteRigWorkers extends StorePart {
  /** The new rig's Workers at a time, to give it; a choice before it is replaced. */
  choose(rig: string, lanes: number, by: string): void {
    this.db
      .prepare(
        `insert into rig_workers (rig, lanes, chosen_by, chosen_at, given) values (?, ?, ?, ?, null)
         on conflict (rig) do update set lanes = excluded.lanes, chosen_by = excluded.chosen_by,
           chosen_at = excluded.chosen_at, given = null`,
      )
      .run(rig, lanes, by, new Date().toISOString());
  }

  get(rig: string): ChosenWorkers | undefined {
    const r = this.db.prepare("select * from rig_workers where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? read(r) : undefined;
  }

  /** Every rig's, not taken yet. */
  waiting(): ChosenWorkers[] {
    return (this.db.prepare("select * from rig_workers order by rig").all() as Row[]).map(read);
  }

  /** Its gives to the rig, as they stand now. */
  setGiven(rig: string, given: ChosenWorkers["given"]): void {
    this.db
      .prepare("update rig_workers set given = ? where rig = ?")
      .run(given ? JSON.stringify(given) : null, rig);
  }

  /** The rig took it, or would not: nothing more to give. */
  done(rig: string): void {
    this.db.prepare("delete from rig_workers where rig = ?").run(rig);
  }
}

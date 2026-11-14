import { type ChosenWorkers, type RigWorkers, read } from "../workers.ts";
import { PgPart, type Row } from "./part.ts";

/** RigWorkers on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigWorkers extends PgPart implements RigWorkers {
  /** The new rig's Workers at a time, to give it; a choice before it is replaced. */
  async choose(rig: string, lanes: number, by: string): Promise<void> {
    await this.q.run(
      `insert into rig_workers (rig, lanes, chosen_by, chosen_at, given) values (?, ?, ?, ?, null)
         on conflict (rig) do update set lanes = excluded.lanes, chosen_by = excluded.chosen_by,
           chosen_at = excluded.chosen_at, given = null`,
      rig,
      lanes,
      by,
      new Date().toISOString(),
    );
  }

  async get(rig: string): Promise<ChosenWorkers | undefined> {
    const r = (await this.q.get("select * from rig_workers where rig = ?", rig)) as Row | undefined;
    return r ? read(r) : undefined;
  }

  /** Every rig's, not taken yet. */
  async waiting(): Promise<ChosenWorkers[]> {
    return ((await this.q.all("select * from rig_workers order by rig")) as Row[]).map(read);
  }

  /** Its gives to the rig, as they stand now. */
  async setGiven(rig: string, given: ChosenWorkers["given"]): Promise<void> {
    await this.q.run(
      "update rig_workers set given = ? where rig = ?",
      given ? JSON.stringify(given) : null,
      rig,
    );
  }

  /** The rig took it, or would not: nothing more to give. */
  async done(rig: string): Promise<void> {
    await this.q.run("delete from rig_workers where rig = ?", rig);
  }
}

import type { RigUpdates } from "../updates.ts";
import { PgPart } from "./part.ts";

/** RigUpdates on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigUpdates extends PgPart implements RigUpdates {
  /** The update under way on a rig; undefined when none is. */
  async get(
    rig: string,
  ): Promise<{ phase: string; paused: string; requested_by: string } | undefined> {
    return (await this.q.get("select * from rig_update where rig = ?", rig)) as
      | { phase: string; paused: string; requested_by: string }
      | undefined;
  }

  /** Every update under way, with the runs each paused (as JSON). */
  async list(): Promise<{ rig: string; phase: string; paused: string; requested_by: string }[]> {
    return (await this.q.all("select * from rig_update")) as {
      rig: string;
      phase: string;
      paused: string;
      requested_by: string;
    }[];
  }

  /** An update begins, pausing first. */
  async begin(rig: string, by: string, at: string): Promise<void> {
    await this.q.run(
      "insert into rig_update (rig, phase, requested_by, started_at, updated_at) values (?, 'pausing', ?, ?, ?)",
      rig,
      by,
      at,
      at,
    );
  }

  /** An update's next step, with the runs it paused once it paused them. */
  async setPhase(rig: string, phase: string, paused: string | null, at: string): Promise<void> {
    await this.q.run(
      "update rig_update set phase = ?, paused = coalesce(?, paused), updated_at = ? where rig = ?",
      phase,
      paused,
      at,
      rig,
    );
  }

  /** An update ended, however it ended. */
  async end(rig: string): Promise<void> {
    await this.q.run("delete from rig_update where rig = ?", rig);
  }
}

import { type RigHistory, type RigStep, stepOf } from "../history.ts";
import { PgPart, type Row } from "./part.ts";

/** RigHistory on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigHistory extends PgPart implements RigHistory {
  /** One step of a rig's setup or management, for its history. */
  async add(rig: string, step: string, ok: boolean, detail?: string): Promise<void> {
    await this.q.run(
      "insert into rig_setup_event (rig, at, step, ok, detail) values (?, ?, ?, ?, ?)",
      rig,
      new Date().toISOString(),
      step,
      ok ? 1 : 0,
      detail ?? null,
    );
  }

  /** A rig's newest steps of these kinds, newest first, at most `limit`. */
  async latest(rig: string, steps: readonly string[], limit = 20): Promise<RigStep[]> {
    return (
      (await this.q.all(
        `select * from rig_setup_event where rig = ? and step in (${steps.map(() => "?").join(", ")})
           order by id desc limit ?`,
        rig,
        ...steps,
        limit,
      )) as Row[]
    ).map(stepOf);
  }

  async list(rig: string): Promise<RigStep[]> {
    return (
      (await this.q.all("select * from rig_setup_event where rig = ? order by id", rig)) as Row[]
    ).map(stepOf);
  }
}

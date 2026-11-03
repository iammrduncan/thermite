import { type Row, StorePart } from "./part.ts";

/**
 * Each rig's history (goal 125, T6): the steps of its setup and management.
 */

export class RigHistory extends StorePart {
  /** One step of a rig's setup or management, for its history. */
  add(rig: string, step: string, ok: boolean, detail?: string): void {
    this.db
      .prepare("insert into rig_setup_event (rig, at, step, ok, detail) values (?, ?, ?, ?, ?)")
      .run(rig, new Date().toISOString(), step, ok ? 1 : 0, detail ?? null);
  }

  /** A rig's newest steps of these kinds, newest first, at most `limit`. */
  latest(rig: string, steps: readonly string[], limit = 20): RigStep[] {
    return (
      this.db
        .prepare(
          `select * from rig_setup_event where rig = ? and step in (${steps.map(() => "?").join(", ")})
           order by id desc limit ?`,
        )
        .all(rig, ...steps, limit) as Row[]
    ).map(stepOf);
  }

  list(rig: string): RigStep[] {
    return (
      this.db.prepare("select * from rig_setup_event where rig = ? order by id").all(rig) as Row[]
    ).map(stepOf);
  }
}

/** One step of a rig's history: when, which, whether it went well, and its detail. */
interface RigStep {
  at: string;
  step: string;
  ok: boolean;
  detail: string | null;
}

const stepOf = (r: Row): RigStep => ({
  at: String(r.at),
  step: String(r.step),
  ok: Number(r.ok) === 1,
  detail: r.detail === null ? null : String(r.detail),
});

import { StorePart } from "./part.ts";

/**
 * The updates of rigs to control's version under way (goal 165; goal 125, T6): each one's step and
 * the runs it paused, so that a control restarted in the middle of one ends it and resumes those
 * runs (rigs/update.ts).
 */

export class RigUpdates extends StorePart {
  /** The update under way on a rig; undefined when none is. */
  get(rig: string): { phase: string; paused: string; requested_by: string } | undefined {
    return this.db.prepare("select * from rig_update where rig = ?").get(rig) as
      | { phase: string; paused: string; requested_by: string }
      | undefined;
  }

  /** Every update under way, with the runs each paused (as JSON). */
  list(): { rig: string; phase: string; paused: string; requested_by: string }[] {
    return this.db.prepare("select * from rig_update").all() as {
      rig: string;
      phase: string;
      paused: string;
      requested_by: string;
    }[];
  }

  /** An update begins, pausing first. */
  begin(rig: string, by: string, at: string): void {
    this.db
      .prepare(
        "insert into rig_update (rig, phase, requested_by, started_at, updated_at) values (?, 'pausing', ?, ?, ?)",
      )
      .run(rig, by, at, at);
  }

  /** An update's next step, with the runs it paused once it paused them. */
  setPhase(rig: string, phase: string, paused: string | null, at: string): void {
    this.db
      .prepare(
        "update rig_update set phase = ?, paused = coalesce(?, paused), updated_at = ? where rig = ?",
      )
      .run(phase, paused, at, rig);
  }

  /** An update ended, however it ended. */
  end(rig: string): void {
    this.db.prepare("delete from rig_update where rig = ?").run(rig);
  }
}

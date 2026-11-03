import { type Row, StorePart } from "./part.ts";

/**
 * Retired rigs (goal 125, T6): out of the lists, their reports refused.
 */

export class RetiredRigs extends StorePart {
  /** Retires any rig: it leaves the lists, its reports are refused, a token control made ends. */
  add(rig: string, by: string): void {
    this.db
      .prepare("insert or ignore into rig_retired (rig, at, by) values (?, ?, ?)")
      .run(rig, new Date().toISOString(), by);
    if (this.store.enrollments.rig(rig)) this.store.enrollments.retire(rig, by);
    this.store.auditLog.add(by, "rig_retired", { rig });
  }

  /** Brings a retired rig back into the lists; a token control made for it stays ended. */
  bringBack(rig: string, by: string): boolean {
    const r = this.db.prepare("delete from rig_retired where rig = ?").run(rig);
    if (Number(r.changes)) this.store.auditLog.add(by, "rig_brought_back", { rig });
    return Number(r.changes) > 0;
  }

  /** Takes a rig off the list with no entry of its own in the audit log (enrolled again). */
  remove(rig: string): void {
    this.db.prepare("delete from rig_retired where rig = ?").run(rig);
  }

  get(rig: string): { at: string; by: string } | undefined {
    const r = this.db.prepare("select at, by from rig_retired where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? { at: String(r.at), by: String(r.by) } : undefined;
  }

  list(): { rig: string; at: string; by: string }[] {
    return (this.db.prepare("select * from rig_retired order by at desc").all() as Row[]).map(
      (r) => ({
        rig: String(r.rig),
        at: String(r.at),
        by: String(r.by),
      }),
    );
  }
}

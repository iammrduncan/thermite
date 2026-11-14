import type { RetiredRigs } from "../retired.ts";
import { PgPart, type Row } from "./part.ts";

/** RetiredRigs on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRetiredRigs extends PgPart implements RetiredRigs {
  /** Retires any rig: it leaves the lists, its reports are refused, a token control made ends. */
  async add(rig: string, by: string): Promise<void> {
    await this.q.run(
      "insert into rig_retired (rig, at, by) values (?, ?, ?) on conflict do nothing",
      rig,
      new Date().toISOString(),
      by,
    );
    if (await this.store.enrollments.rig(rig)) await this.store.enrollments.retire(rig, by);
    await this.store.auditLog.add(by, "rig_retired", { rig });
  }

  /** Brings a retired rig back into the lists; a token control made for it stays ended. */
  async bringBack(rig: string, by: string): Promise<boolean> {
    const r = await this.q.run("delete from rig_retired where rig = ?", rig);
    if (Number(r.changes)) await this.store.auditLog.add(by, "rig_brought_back", { rig });
    return Number(r.changes) > 0;
  }

  /** Takes a rig off the list with no entry of its own in the audit log (enrolled again). */
  async remove(rig: string): Promise<void> {
    await this.q.run("delete from rig_retired where rig = ?", rig);
  }

  async get(rig: string): Promise<{ at: string; by: string } | undefined> {
    const r = (await this.q.get("select at, by from rig_retired where rig = ?", rig)) as
      | Row
      | undefined;
    return r ? { at: String(r.at), by: String(r.by) } : undefined;
  }

  async list(): Promise<{ rig: string; at: string; by: string }[]> {
    return ((await this.q.all("select * from rig_retired order by at desc")) as Row[]).map((r) => ({
      rig: String(r.rig),
      at: String(r.at),
      by: String(r.by),
    }));
  }
}

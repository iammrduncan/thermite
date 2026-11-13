import { type Row, StorePart } from "./part.ts";

/**
 * The written reports rigs send to control (goal 125, T6), such as a daily report.
 */
export interface RigReports {
  add(rig: string, kind: string, body: string): Promise<number>;
  list(
    limit?: number,
    rig?: string,
  ): Promise<{ id: number; rig: string; kind: string; body: string; at: string }[]>;
}

/** RigReports on SQLite: each call answers at once (the store behind the interface, sqlite.ts). */
export class SqliteRigReports extends StorePart {
  add(rig: string, kind: string, body: string): number {
    const r = this.db
      .prepare("insert into rig_report (rig, kind, body, at) values (?, ?, ?, ?)")
      .run(rig, kind, body.slice(0, 200_000), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  list(
    limit = 20,
    rig?: string,
  ): { id: number; rig: string; kind: string; body: string; at: string }[] {
    const rows = (
      rig
        ? this.db
            .prepare("select * from rig_report where rig = ? order by id desc limit ?")
            .all(rig, limit)
        : this.db.prepare("select * from rig_report order by id desc limit ?").all(limit)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      rig: String(r.rig),
      kind: String(r.kind),
      body: String(r.body),
      at: String(r.at),
    }));
  }
}

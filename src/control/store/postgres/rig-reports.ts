import type { RigReports } from "../rig-reports.ts";
import { PgPart, type Row } from "./part.ts";

/** RigReports on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigReports extends PgPart implements RigReports {
  async add(rig: string, kind: string, body: string): Promise<number> {
    const r = await this.q.insert(
      "insert into rig_report (rig, kind, body, at) values (?, ?, ?, ?)",
      rig,
      kind,
      body.slice(0, 200_000),
      new Date().toISOString(),
    );
    return r;
  }

  async list(
    limit = 20,
    rig?: string,
  ): Promise<{ id: number; rig: string; kind: string; body: string; at: string }[]> {
    const rows = (
      rig
        ? await this.q.all(
            "select * from rig_report where rig = ? order by id desc limit ?",
            rig,
            limit,
          )
        : await this.q.all("select * from rig_report order by id desc limit ?", limit)
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

import { Refusal } from "../../../common/errors.ts";
import type { FullResets } from "../resets.ts";
import { PgPart, type Row } from "./part.ts";

/** FullResets on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresFullResets extends PgPart implements FullResets {
  async open(rig: string): Promise<Row | undefined> {
    return (await this.q.get(
      "select * from reset where rig = ? and state not in ('done', 'failed', 'cancelled') order by id desc",
      rig,
    )) as Row | undefined;
  }

  async list(limit = 20): Promise<Row[]> {
    return (await this.q.all("select * from reset order by id desc limit ?", limit)) as Row[];
  }

  async create(rig: string, by: string): Promise<number> {
    if (await this.open(rig)) throw new Refusal(`a reset of ${rig} is already in progress`);
    const now = new Date().toISOString();
    const r = await this.q.insert(
      "insert into reset (rig, state, requested_by, created_at, updated_at) values (?, 'start', ?, ?, ?)",
      rig,
      by,
      now,
      now,
    );
    await this.store.auditLog.add(by, "reset_requested", { rig });
    return r;
  }

  async update(
    id: number,
    fields: {
      state: string;
      command?: string;
      export_name?: string;
      through_event?: number;
      detail?: string;
    },
  ): Promise<void> {
    await this.q.run(
      `update reset set state = ?, command = coalesce(?, command), export_name = coalesce(?, export_name),
           through_event = coalesce(?, through_event), detail = coalesce(?, detail), updated_at = ? where id = ?`,
      fields.state,
      fields.command ?? null,
      fields.export_name ?? null,
      fields.through_event ?? null,
      fields.detail ?? null,
      new Date().toISOString(),
      id,
    );
    await this.store.auditLog.add("control", "reset_step", { id, ...fields });
  }
}

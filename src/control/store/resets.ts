import { Refusal } from "../../common/errors.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * A rig's full resets (goal 125, T6), one step at a time, each in the audit log.
 */

export class FullResets extends StorePart {
  open(rig: string): Row | undefined {
    return this.db
      .prepare(
        "select * from reset where rig = ? and state not in ('done', 'failed', 'cancelled') order by id desc",
      )
      .get(rig) as Row | undefined;
  }

  list(limit = 20): Row[] {
    return this.db.prepare("select * from reset order by id desc limit ?").all(limit) as Row[];
  }

  create(rig: string, by: string): number {
    if (this.open(rig)) throw new Refusal(`a reset of ${rig} is already in progress`);
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        "insert into reset (rig, state, requested_by, created_at, updated_at) values (?, 'start', ?, ?, ?)",
      )
      .run(rig, by, now, now);
    this.store.auditLog.add(by, "reset_requested", { rig });
    return Number(r.lastInsertRowid);
  }

  update(
    id: number,
    fields: {
      state: string;
      command?: string;
      export_name?: string;
      through_event?: number;
      detail?: string;
    },
  ): void {
    this.db
      .prepare(
        `update reset set state = ?, command = coalesce(?, command), export_name = coalesce(?, export_name),
           through_event = coalesce(?, through_event), detail = coalesce(?, detail), updated_at = ? where id = ?`,
      )
      .run(
        fields.state,
        fields.command ?? null,
        fields.export_name ?? null,
        fields.through_event ?? null,
        fields.detail ?? null,
        new Date().toISOString(),
        id,
      );
    this.store.auditLog.add("control", "reset_step", { id, ...fields });
  }
}

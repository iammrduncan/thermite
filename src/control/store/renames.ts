import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../common/sqlite.ts";

/**
 * The renames a store from before them gets in place, as its first migration starts
 * (store/schema.ts, schemaOne): the units that became rigs, and the agents' roles of goal 074.
 */

/**
 * A store written before the 2026-10-15 rename (unit -> rig): its tables and columns are
 * renamed in place, and the old indexes dropped (the schema creates them under the new names).
 */
export function renameUnitsToRigs(db: DatabaseSync): void {
  const tables = () =>
    (
      db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
  if (!tables().includes("unit")) return;
  transaction(db, () => {
    for (const name of ["unit", "unit_event", "unit_ledger", "unit_report", "unit_live"]) {
      if (tables().includes(name))
        db.exec(`alter table ${name} rename to ${name.replace(/^unit/, "rig")}`);
    }
    for (const name of tables()) {
      const cols = db.prepare(`pragma table_info(${name})`).all() as { name: string }[];
      if (cols.some((c) => c.name === "unit"))
        db.exec(`alter table ${name} rename column unit to rig`);
      if (cols.some((c) => c.name === "instance"))
        db.exec(`alter table ${name} rename column instance to run`);
    }
    const indexes = db
      .prepare("select name from sqlite_master where type = 'index' and name like 'unit%'")
      .all() as { name: string }[];
    for (const i of indexes) db.exec(`drop index if exists ${i.name}`);
  });
}

/**
 * A store written before goal 074 (2026-10-21) named the agents' roles `combiner` and `panel`, and
 * gave the teachers one model, which ran as two teachers. Its table is made again with the new
 * names: `merged_by` and `review_panel`, and a `second_teacher` with the teachers' model, so a rig
 * keeps its two teachers.
 */
export function renameAgentRoles(db: DatabaseSync): void {
  const table = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'rig_role_model'")
    .get() as { sql?: string } | undefined;
  if (!table?.sql?.includes("'combiner'")) return;
  const cols = "rig, role, provider, model, effort, assigned_at, harness, context_cap, compact_at";
  transaction(db, () => {
    db.exec(`create table rig_role_model_074 (
  rig text not null,
  role text not null check (role in ('planner', 'teachers', 'second_teacher', 'merged_by', 'auditor', 'review_panel')),
  provider text not null,
  model text not null,
  effort text,
  assigned_at text not null,
  harness text,
  context_cap integer,
  compact_at integer,
  primary key (rig, role)
)`);
    db.exec(`insert into rig_role_model_074 (${cols})
  select rig, case role when 'combiner' then 'merged_by' when 'panel' then 'review_panel' else role end,
  provider, model, effort, assigned_at, harness, context_cap, compact_at from rig_role_model`);
    db.exec(`insert into rig_role_model_074 (${cols})
  select rig, 'second_teacher', provider, model, effort, assigned_at, harness, context_cap, compact_at
  from rig_role_model where role = 'teachers'`);
    db.exec("drop table rig_role_model");
    db.exec("alter table rig_role_model_074 rename to rig_role_model");
  });
}

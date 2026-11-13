import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../core/canonical.ts";
import {
  type RetentionKind,
  type RetentionPolicy,
  type RetentionSpec,
  RetentionSpec as RetentionSpecSchema,
  RigSpace,
} from "../../core/retention/index.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * The owner's retention policies in control's store (core/retention/), what each removed, and
 * what each rig last said it keeps of the kinds a policy may remove there. No policy exists until
 * the owner makes one, and each starts off: nothing is removed by default.
 */

/**
 * Store migration 24: the policies, their removals, and each rig's space. A version of a
 * knowledge-base item may now be removed by a policy, except the item's newest, which the store
 * itself refuses to remove.
 */
export function retentionTables(db: DatabaseSync): void {
  db.exec(`
create table if not exists retention_policy (
  id integer primary key autoincrement,
  name text not null,
  kind text not null,
  spec text not null,
  enabled integer not null default 0,
  on_since text,
  last_due text,
  created_at text not null,
  created_by text not null,
  updated_at text not null,
  updated_by text not null
);
create table if not exists retention_removal (
  id integer primary key autoincrement,
  at text not null,
  policy integer not null,
  name text not null,
  kind text not null,
  rig text,
  by text not null,
  count integer not null,
  bytes integer not null,
  oldest text,
  newest text,
  error text
);
create index if not exists retention_removal_policy on retention_removal (policy, id);
create table if not exists rig_space (
  rig text primary key,
  read_at text not null,
  received_at text not null,
  space text not null
);
drop trigger if exists kb_version_never_removed;
create trigger if not exists kb_version_newest_kept before delete on kb_version
when old.version = (select version from kb_item where id = old.item)
begin select raise(abort, 'the newest version of an item is never removed'); end;
`);
}

/**
 * Whether a retention policy of control's store's copies is on, read before the store migrates:
 * while one is, control keeps every copy and the policy decides; else it keeps the two newest
 * (db-copy.ts). An off policy changes nothing. A store from before the policies has none.
 */
export function copiesPolicyOn(db: DatabaseSync): boolean {
  const has = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'retention_policy'")
    .get();
  if (!has) return false;
  return (
    db
      .prepare("select 1 from retention_policy where kind = 'store_copies' and enabled = 1 limit 1")
      .get() !== undefined
  );
}

/**
 * Store migration 25: each rig ledger's floor in control's copy of its events (control/events/
 * days.ts): the last event a retention policy removed on purpose, and the stream's place before
 * which it purged. Control asks no rig to send an event at or below it again.
 */
export function eventFloorTable(db: DatabaseSync): void {
  db.exec(`
create table if not exists event_floor (
  rig text not null,
  ledger text not null,
  through_event integer not null,
  before_place integer not null,
  at text not null,
  primary key (rig, ledger)
);
`);
}

/** A rig ledger's floor: its last event removed on purpose, and the place before which. */
interface EventFloor {
  rig: string;
  ledger: string;
  through_event: number;
  before_place: number;
  at: string;
}

/** One removal by a policy: on control (rig null) or on one rig. */
export interface RetentionRemovalRow {
  id: number;
  at: string;
  policy: number;
  name: string;
  kind: RetentionKind;
  rig: string | null;
  /** Who started it: `schedule`, or who pressed Run now. */
  by: string;
  count: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  error: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function policyOf(r: Row): RetentionPolicy {
  const spec = RetentionSpecSchema.parse(JSON.parse(String(r.spec)));
  return {
    ...spec,
    id: Number(r.id),
    on: Number(r.enabled) === 1,
    on_since: str(r.on_since),
    last_due: str(r.last_due),
    created_at: String(r.created_at),
    created_by: String(r.created_by),
    updated_at: String(r.updated_at),
    updated_by: String(r.updated_by),
  };
}

function removalOf(r: Row): RetentionRemovalRow {
  return {
    id: Number(r.id),
    at: String(r.at),
    policy: Number(r.policy),
    name: String(r.name),
    kind: String(r.kind) as RetentionKind,
    rig: str(r.rig),
    by: String(r.by),
    count: Number(r.count),
    bytes: Number(r.bytes),
    oldest: str(r.oldest),
    newest: str(r.newest),
    error: str(r.error),
  };
}

export interface RetentionPolicies {
  /** Every policy, oldest first. */
  list(): Promise<RetentionPolicy[]>;
  get(id: number): Promise<RetentionPolicy | undefined>;
  /** A new policy, on or off as asked; its id. */
  add(spec: RetentionSpec, on: boolean, by: string, now?: string): Promise<number>;
  /** A policy's new design; on or off as asked. Its last run stays. */
  update(id: number, spec: RetentionSpec, on: boolean, by: string, now?: string): Promise<void>;
  /** Turns a policy on (from now: a due time before it does not run it) or off. */
  setOn(id: number, on: boolean, by: string, now?: string): Promise<void>;
  /** The due time a policy ran for, kept before it runs, so a restart never runs it twice. */
  setLastDue(id: number, at: string): Promise<void>;
  remove(id: number): Promise<boolean>;
  /** A removal, as control or a rig made it; its id. */
  addRemoval(r: Omit<RetentionRemovalRow, "id">): Promise<number>;
  /** The newest removals, newest first; of one policy when it is named. */
  removals(limit: number, policy?: number): Promise<RetentionRemovalRow[]>;
  /** Raises a rig ledger's floor to an event removed on purpose; it never goes down. */
  raiseFloor(rig: string, ledger: string, event: number, before: number, at: string): Promise<void>;
  /** A rig ledger's floor's last event; 0 when no event of it was removed. */
  floor(rig: string, ledger: string): Promise<number>;
  /** A rig's floors, by ledger. */
  floors(rig: string): Promise<EventFloor[]>;
  /** What a rig last said it keeps of the kinds a policy may remove there. */
  takeSpace(rig: string, space: RigSpace, now?: string): Promise<void>;
  /** Each rig's last word on its space, by rig; a row this build can't read is left out. */
  spaces(): Promise<Map<string, RigSpace & { received_at: string }>>;
}

/** RetentionPolicies on SQLite: each call answers at once (the store behind the interface, sqlite.ts). */
export class SqliteRetentionPolicies extends StorePart {
  /** Every policy, oldest first. */
  list(): RetentionPolicy[] {
    return (this.db.prepare("select * from retention_policy order by id").all() as Row[]).map(
      policyOf,
    );
  }

  get(id: number): RetentionPolicy | undefined {
    const r = this.db.prepare("select * from retention_policy where id = ?").get(id) as
      | Row
      | undefined;
    return r ? policyOf(r) : undefined;
  }

  /** A new policy, on or off as asked; its id. */
  add(spec: RetentionSpec, on: boolean, by: string, now = new Date().toISOString()): number {
    const r = this.db
      .prepare(
        `insert into retention_policy (name, kind, spec, enabled, on_since, created_at, created_by, updated_at, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        spec.name,
        spec.kind,
        canonicalJson(spec),
        on ? 1 : 0,
        on ? now : null,
        now,
        by,
        now,
        by,
      );
    return Number(r.lastInsertRowid);
  }

  /** A policy's new design; on or off as asked. Its last run stays. */
  update(id: number, spec: RetentionSpec, on: boolean, by: string, now = new Date().toISOString()) {
    const was = this.get(id);
    const since = on ? (was?.on ? was.on_since : now) : null;
    this.db
      .prepare(
        `update retention_policy set name = ?, kind = ?, spec = ?, enabled = ?, on_since = ?, updated_at = ?, updated_by = ?
         where id = ?`,
      )
      .run(spec.name, spec.kind, canonicalJson(spec), on ? 1 : 0, since, now, by, id);
  }

  /** Turns a policy on (from now: a due time before it does not run it) or off. */
  setOn(id: number, on: boolean, by: string, now = new Date().toISOString()): void {
    const was = this.get(id);
    if (!was || was.on === on) return;
    this.db
      .prepare(
        "update retention_policy set enabled = ?, on_since = ?, updated_at = ?, updated_by = ? where id = ?",
      )
      .run(on ? 1 : 0, on ? now : null, now, by, id);
  }

  /** The due time a policy ran for, kept before it runs, so a restart never runs it twice. */
  setLastDue(id: number, at: string): void {
    this.db.prepare("update retention_policy set last_due = ? where id = ?").run(at, id);
  }

  remove(id: number): boolean {
    return this.db.prepare("delete from retention_policy where id = ?").run(id).changes > 0;
  }

  /** A removal, as control or a rig made it; its id. */
  addRemoval(r: Omit<RetentionRemovalRow, "id">): number {
    const out = this.db
      .prepare(
        `insert into retention_removal (at, policy, name, kind, rig, by, count, bytes, oldest, newest, error)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.at,
        r.policy,
        r.name,
        r.kind,
        r.rig,
        r.by,
        r.count,
        r.bytes,
        r.oldest,
        r.newest,
        r.error,
      );
    return Number(out.lastInsertRowid);
  }

  /** The newest removals, newest first; of one policy when it is named. */
  removals(limit: number, policy?: number): RetentionRemovalRow[] {
    const rows =
      policy === undefined
        ? this.db.prepare("select * from retention_removal order by id desc limit ?").all(limit)
        : this.db
            .prepare("select * from retention_removal where policy = ? order by id desc limit ?")
            .all(policy, limit);
    return (rows as Row[]).map(removalOf);
  }

  /** Raises a rig ledger's floor to an event removed on purpose; it never goes down. */
  raiseFloor(rig: string, ledger: string, event: number, before: number, at: string): void {
    this.db
      .prepare(
        `insert into event_floor (rig, ledger, through_event, before_place, at) values (?, ?, ?, ?, ?)
         on conflict (rig, ledger) do update set
           through_event = max(through_event, excluded.through_event),
           before_place = max(before_place, excluded.before_place), at = excluded.at`,
      )
      .run(rig, ledger, event, before, at);
  }

  /** A rig ledger's floor's last event; 0 when no event of it was removed. */
  floor(rig: string, ledger: string): number {
    const r = this.db
      .prepare("select through_event from event_floor where rig = ? and ledger = ?")
      .get(rig, ledger) as Row | undefined;
    return Number(r?.through_event ?? 0);
  }

  /** A rig's floors, by ledger. */
  floors(rig: string): EventFloor[] {
    return (
      this.db.prepare("select * from event_floor where rig = ? order by ledger").all(rig) as Row[]
    ).map((r) => ({
      rig: String(r.rig),
      ledger: String(r.ledger),
      through_event: Number(r.through_event),
      before_place: Number(r.before_place),
      at: String(r.at),
    }));
  }

  /** What a rig last said it keeps of the kinds a policy may remove there. */
  takeSpace(rig: string, space: RigSpace, now = new Date().toISOString()): void {
    this.db
      .prepare(
        `insert into rig_space (rig, read_at, received_at, space) values (?, ?, ?, ?)
         on conflict (rig) do update set read_at = excluded.read_at, received_at = excluded.received_at, space = excluded.space`,
      )
      .run(rig, space.read_at, now, JSON.stringify(space));
  }

  /** Each rig's last word on its space, by rig; a row this build can't read is left out. */
  spaces(): Map<string, RigSpace & { received_at: string }> {
    const out = new Map<string, RigSpace & { received_at: string }>();
    for (const r of this.db.prepare("select * from rig_space order by rig").all() as Row[]) {
      const read = RigSpace.safeParse(JSON.parse(String(r.space)));
      if (read.success)
        out.set(String(r.rig), { ...read.data, received_at: String(r.received_at) });
    }
    return out;
  }
}

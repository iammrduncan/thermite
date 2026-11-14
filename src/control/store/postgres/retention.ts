import { canonicalJson } from "../../../core/canonical.ts";
import {
  type RetentionPolicy,
  type RetentionSpec,
  RigSpace,
} from "../../../core/retention/index.ts";
import {
  type EventFloor,
  policyOf,
  type RetentionPolicies,
  type RetentionRemovalRow,
  removalOf,
} from "../retention.ts";
import { PgPart, type Row } from "./part.ts";

/** RetentionPolicies on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRetentionPolicies extends PgPart implements RetentionPolicies {
  /** Every policy, oldest first. */
  async list(): Promise<RetentionPolicy[]> {
    return ((await this.q.all("select * from retention_policy order by id")) as Row[]).map(
      policyOf,
    );
  }

  async get(id: number): Promise<RetentionPolicy | undefined> {
    const r = (await this.q.get("select * from retention_policy where id = ?", id)) as
      | Row
      | undefined;
    return r ? policyOf(r) : undefined;
  }

  /** A new policy, on or off as asked; its id. */
  async add(
    spec: RetentionSpec,
    on: boolean,
    by: string,
    now = new Date().toISOString(),
  ): Promise<number> {
    const r = await this.q.insert(
      `insert into retention_policy (name, kind, spec, enabled, on_since, created_at, created_by, updated_at, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return r;
  }

  /** A policy's new design; on or off as asked. Its last run stays. */
  async update(
    id: number,
    spec: RetentionSpec,
    on: boolean,
    by: string,
    now = new Date().toISOString(),
  ) {
    const was = await this.get(id);
    const since = on ? (was?.on ? was.on_since : now) : null;
    await this.q.run(
      `update retention_policy set name = ?, kind = ?, spec = ?, enabled = ?, on_since = ?, updated_at = ?, updated_by = ?
         where id = ?`,
      spec.name,
      spec.kind,
      canonicalJson(spec),
      on ? 1 : 0,
      since,
      now,
      by,
      id,
    );
  }

  /** Turns a policy on (from now: a due time before it does not run it) or off. */
  async setOn(id: number, on: boolean, by: string, now = new Date().toISOString()): Promise<void> {
    const was = await this.get(id);
    if (!was || was.on === on) return;
    await this.q.run(
      "update retention_policy set enabled = ?, on_since = ?, updated_at = ?, updated_by = ? where id = ?",
      on ? 1 : 0,
      on ? now : null,
      now,
      by,
      id,
    );
  }

  /** The due time a policy ran for, kept before it runs, so a restart never runs it twice. */
  async setLastDue(id: number, at: string): Promise<void> {
    await this.q.run("update retention_policy set last_due = ? where id = ?", at, id);
  }

  async remove(id: number): Promise<boolean> {
    return (await this.q.run("delete from retention_policy where id = ?", id)).changes > 0;
  }

  /** A removal, as control or a rig made it; its id. */
  async addRemoval(r: Omit<RetentionRemovalRow, "id">): Promise<number> {
    const out = await this.q.insert(
      `insert into retention_removal (at, policy, name, kind, rig, by, count, bytes, oldest, newest, error)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return out;
  }

  /** The newest removals, newest first; of one policy when it is named. */
  async removals(limit: number, policy?: number): Promise<RetentionRemovalRow[]> {
    const rows =
      policy === undefined
        ? await this.q.all("select * from retention_removal order by id desc limit ?", limit)
        : await this.q.all(
            "select * from retention_removal where policy = ? order by id desc limit ?",
            policy,
            limit,
          );
    return (rows as Row[]).map(removalOf);
  }

  /** Raises a rig ledger's floor to an event removed on purpose; it never goes down. */
  async raiseFloor(
    rig: string,
    ledger: string,
    event: number,
    before: number,
    at: string,
  ): Promise<void> {
    await this.q.run(
      `insert into event_floor (rig, ledger, through_event, before_place, at) values (?, ?, ?, ?, ?)
         on conflict (rig, ledger) do update set
           through_event = greatest(event_floor.through_event, excluded.through_event),
           before_place = greatest(event_floor.before_place, excluded.before_place),
           at = excluded.at`,
      rig,
      ledger,
      event,
      before,
      at,
    );
  }

  /** A rig ledger's floor's last event; 0 when no event of it was removed. */
  async floor(rig: string, ledger: string): Promise<number> {
    const r = (await this.q.get(
      "select through_event from event_floor where rig = ? and ledger = ?",
      rig,
      ledger,
    )) as Row | undefined;
    return Number(r?.through_event ?? 0);
  }

  /** A rig's floors, by ledger. */
  async floors(rig: string): Promise<EventFloor[]> {
    return (
      (await this.q.all("select * from event_floor where rig = ? order by ledger", rig)) as Row[]
    ).map((r) => ({
      rig: String(r.rig),
      ledger: String(r.ledger),
      through_event: Number(r.through_event),
      before_place: Number(r.before_place),
      at: String(r.at),
    }));
  }

  /** What a rig last said it keeps of the kinds a policy may remove there. */
  async takeSpace(rig: string, space: RigSpace, now = new Date().toISOString()): Promise<void> {
    await this.q.run(
      `insert into rig_space (rig, read_at, received_at, space) values (?, ?, ?, ?)
         on conflict (rig) do update set read_at = excluded.read_at, received_at = excluded.received_at, space = excluded.space`,
      rig,
      space.read_at,
      now,
      JSON.stringify(space),
    );
  }

  /** Each rig's last word on its space, by rig; a row this build can't read is left out. */
  async spaces(): Promise<Map<string, RigSpace & { received_at: string }>> {
    const out = new Map<string, RigSpace & { received_at: string }>();
    for (const r of (await this.q.all("select * from rig_space order by rig")) as Row[]) {
      const read = RigSpace.safeParse(JSON.parse(String(r.space)));
      if (read.success)
        out.set(String(r.rig), { ...read.data, received_at: String(r.received_at) });
    }
    return out;
  }
}

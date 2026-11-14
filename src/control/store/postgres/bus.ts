import type { BusIdentityName, BusKeys } from "../bus.ts";
import { PgPart } from "./part.ts";

/** BusKeys on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresBusKeys extends PgPart implements BusKeys {
  /** The key a rig registered, or undefined when it has none. */
  async rigKey(rig: string): Promise<string | undefined> {
    const r = (await this.q.get("select public_key from rig_bus_key where rig = ?", rig)) as
      | { public_key: string }
      | undefined;
    return r?.public_key;
  }

  /** Records the key a rig registered, in place of the one before. */
  async setRigKey(rig: string, key: string): Promise<void> {
    await this.q.run(
      `insert into rig_bus_key (rig, public_key, registered_at) values (?, ?, ?)
         on conflict (rig) do update set public_key = excluded.public_key,
           registered_at = excluded.registered_at`,
      rig,
      key,
      new Date().toISOString(),
    );
  }

  /** The seal key a rig registered, or undefined when it has none. */
  async rigSealKey(rig: string): Promise<string | undefined> {
    const r = (await this.q.get("select seal_key from rig_bus_key where rig = ?", rig)) as
      | { seal_key: string | null }
      | undefined;
    return r?.seal_key ?? undefined;
  }

  /** Records the seal key a rig registered, in place of the one before: after its user key. */
  async setRigSealKey(rig: string, key: string): Promise<void> {
    await this.q.run("update rig_bus_key set seal_key = ? where rig = ?", key, rig);
  }

  /**
   * Who holds this key on the bus, other than `rig`: another rig that registered it as its user
   * key or its seal key (a retired one too), or control, as one of its own; undefined when none.
   */
  async holderOf(key: string, rig: string): Promise<string | undefined> {
    const r = (await this.q.get(
      "select rig from rig_bus_key where (public_key = ? or seal_key = ?) and rig != ?",
      key,
      key,
      rig,
    )) as { rig: string } | undefined;
    if (r) return `rig ${r.rig}`;
    const m = (await this.q.get(
      "select rig, runner from runner_bus_key where public_key = ?",
      key,
    )) as { rig: string; runner: string } | undefined;
    if (m) return `runner ${m.runner} of rig ${m.rig}`;
    const own = await this.q.get("select 1 from bus_identity where public_key = ?", key);
    return own ? "control" : undefined;
  }

  /** The key a runner process of a rig registered (goal 206), or undefined when it has none. */
  async runnerKey(rig: string, runner: string): Promise<string | undefined> {
    const r = (await this.q.get(
      "select public_key from runner_bus_key where rig = ? and runner = ?",
      rig,
      runner,
    )) as { public_key: string } | undefined;
    return r?.public_key;
  }

  /** Records the key a runner process registered, in place of the one before. */
  async setRunnerKey(rig: string, runner: string, key: string): Promise<void> {
    await this.q.run(
      `insert into runner_bus_key (rig, runner, public_key, registered_at) values (?, ?, ?, ?)
         on conflict (rig, runner) do update set public_key = excluded.public_key,
           registered_at = excluded.registered_at`,
      rig,
      runner,
      key,
      new Date().toISOString(),
    );
  }

  /** Every runner process's registered key, by rig and runner. */
  async runnerKeys(): Promise<{ rig: string; runner: string; key: string }[]> {
    const rows = (await this.q.all(
      "select rig, runner, public_key from runner_bus_key order by rig, runner",
    )) as { rig: string; runner: string; public_key: string }[];
    return rows.map((r) => ({ rig: r.rig, runner: r.runner, key: r.public_key }));
  }

  /** Every rig's registered key, by rig, with its seal key when it registered one. */
  async rigKeys(): Promise<{ rig: string; key: string; sealKey?: string | undefined }[]> {
    const rows = (await this.q.all(
      "select rig, public_key, seal_key from rig_bus_key order by rig",
    )) as { rig: string; public_key: string; seal_key: string | null }[];
    return rows.map((r) => ({ rig: r.rig, key: r.public_key, sealKey: r.seal_key ?? undefined }));
  }

  /** One of control's own keys, or undefined before it was made. */
  async identity(
    name: BusIdentityName,
  ): Promise<{ publicKey: string; sealedSeed: string } | undefined> {
    const r = (await this.q.get(
      "select public_key, seed_sealed from bus_identity where name = ?",
      name,
    )) as { public_key: string; seed_sealed: string } | undefined;
    return r ? { publicKey: r.public_key, sealedSeed: r.seed_sealed } : undefined;
  }

  /** Keeps one of control's own keys, unless it has one of that name already. */
  async addIdentity(name: BusIdentityName, publicKey: string, sealedSeed: string): Promise<void> {
    await this.q.run(
      `insert into bus_identity (name, public_key, seed_sealed, created_at)
         values (?, ?, ?, ?) on conflict do nothing`,
      name,
      publicKey,
      sealedSeed,
      new Date().toISOString(),
    );
  }
}

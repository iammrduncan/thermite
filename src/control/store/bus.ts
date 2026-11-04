import type { DatabaseSync } from "node:sqlite";
import { StorePart } from "./part.ts";

/**
 * The message bus's keys in control's store (goal 168): the user key each rig's supervisor
 * registered, its public part only, with the seal key control seals the rig's config to, its public
 * part too; and control's own two keys, their seeds sealed with control's secrets key. The audit
 * log and the rig's history keep each change of a rig's keys.
 */

/** Control's own keys on the bus: its user in the account, and its user in the system account. */
export type BusIdentityName = "control" | "system";

/** The tables, made by the store's migration to schema version 7. */
export function busKeyTables(db: DatabaseSync): void {
  db.exec(`create table if not exists rig_bus_key (
  rig text primary key,
  public_key text not null,
  registered_at text not null
)`);
  db.exec(`create table if not exists bus_identity (
  name text primary key check (name in ('control', 'system')),
  public_key text not null,
  seed_sealed text not null,
  created_at text not null
)`);
}

/** A rig's seal key beside its user key, made by the store's migration to schema version 9. */
export function busSealKeyColumn(db: DatabaseSync): void {
  const cols = db.prepare("pragma table_info(rig_bus_key)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "seal_key"))
    db.exec("alter table rig_bus_key add column seal_key text");
}

export class BusKeys extends StorePart {
  /** The key a rig registered, or undefined when it has none. */
  rigKey(rig: string): string | undefined {
    const r = this.db.prepare("select public_key from rig_bus_key where rig = ?").get(rig) as
      | { public_key: string }
      | undefined;
    return r?.public_key;
  }

  /** Records the key a rig registered, in place of the one before. */
  setRigKey(rig: string, key: string): void {
    this.db
      .prepare(
        `insert into rig_bus_key (rig, public_key, registered_at) values (?, ?, ?)
         on conflict (rig) do update set public_key = excluded.public_key,
           registered_at = excluded.registered_at`,
      )
      .run(rig, key, new Date().toISOString());
  }

  /** The seal key a rig registered, or undefined when it has none. */
  rigSealKey(rig: string): string | undefined {
    const r = this.db.prepare("select seal_key from rig_bus_key where rig = ?").get(rig) as
      | { seal_key: string | null }
      | undefined;
    return r?.seal_key ?? undefined;
  }

  /** Records the seal key a rig registered, in place of the one before: after its user key. */
  setRigSealKey(rig: string, key: string): void {
    this.db.prepare("update rig_bus_key set seal_key = ? where rig = ?").run(key, rig);
  }

  /**
   * Who holds this key on the bus, other than `rig`: another rig that registered it as its user
   * key or its seal key (a retired one too), or control, as one of its own; undefined when none.
   */
  holderOf(key: string, rig: string): string | undefined {
    const r = this.db
      .prepare("select rig from rig_bus_key where (public_key = ? or seal_key = ?) and rig != ?")
      .get(key, key, rig) as { rig: string } | undefined;
    if (r) return `rig ${r.rig}`;
    const own = this.db.prepare("select 1 from bus_identity where public_key = ?").get(key);
    return own ? "control" : undefined;
  }

  /** Every rig's registered key, by rig, with its seal key when it registered one. */
  rigKeys(): { rig: string; key: string; sealKey?: string | undefined }[] {
    const rows = this.db
      .prepare("select rig, public_key, seal_key from rig_bus_key order by rig")
      .all() as { rig: string; public_key: string; seal_key: string | null }[];
    return rows.map((r) => ({ rig: r.rig, key: r.public_key, sealKey: r.seal_key ?? undefined }));
  }

  /** One of control's own keys, or undefined before it was made. */
  identity(name: BusIdentityName): { publicKey: string; sealedSeed: string } | undefined {
    const r = this.db
      .prepare("select public_key, seed_sealed from bus_identity where name = ?")
      .get(name) as { public_key: string; seed_sealed: string } | undefined;
    return r ? { publicKey: r.public_key, sealedSeed: r.seed_sealed } : undefined;
  }

  /** Keeps one of control's own keys, unless it has one of that name already. */
  addIdentity(name: BusIdentityName, publicKey: string, sealedSeed: string): void {
    this.db
      .prepare(
        `insert or ignore into bus_identity (name, public_key, seed_sealed, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(name, publicKey, sealedSeed, new Date().toISOString());
  }
}

import type { DatabaseSync } from "node:sqlite";
import { Credential } from "../credential.ts";
import { StorePart } from "./part.ts";

/**
 * The runner processes control set up for a rig (goal 206): where each runs, what it was given,
 * and the hash of its own token, with which its supervisor registers its key on the bus and does
 * nothing else. A runner process someone started by hand has no row: it uses the rig's token.
 */

/** A runner process on a cluster, as control set it up. */
export interface RigRunner {
  rig: string;
  runner: string;
  cluster: string;
  namespace: string;
  placement: "created" | "slot";
  spec: RigRunnerSpec;
  status: string;
  created_at: string;
  created_by: string;
}

interface RigRunnerSpec {
  /** Its GPUs: none (the node's CPUs) or one. */
  gpus: number;
  gpuMode: "device-plugin" | "dra";
  deviceClass?: string | undefined;
  node?: string | undefined;
  storageClass?: string | undefined;
  storageGi: number;
  resources?: { cpus: number; memoryGi: number } | undefined;
  images: { harness: string; supervisor: string };
  cuda?: "13" | undefined;
  /** The pool of each runner it serves, as the rig's `runners` setting gives them. */
  pools: string[];
}

/** Made by the store's migration to schema version 33. */
export function rigRunnerTable(db: DatabaseSync): void {
  db.exec(`create table if not exists rig_runner (
  rig text not null,
  runner text not null,
  token_sha256 text,
  cluster text not null,
  namespace text not null,
  placement text not null,
  spec text not null,
  status text not null,
  created_at text not null,
  created_by text not null,
  primary key (rig, runner)
)`);
}

type Row = Omit<RigRunner, "spec"> & { spec: string };

const read = (r: Row): RigRunner => ({ ...r, spec: JSON.parse(r.spec) as RigRunnerSpec });

export class RigRunners extends StorePart {
  /** A rig's runner processes control set up, removed ones too. */
  of(rig: string): RigRunner[] {
    return (
      this.db
        .prepare(
          "select rig, runner, cluster, namespace, placement, spec, status, created_at, created_by from rig_runner where rig = ? order by runner",
        )
        .all(rig) as unknown as Row[]
    ).map(read);
  }

  get(rig: string, runner: string): RigRunner | undefined {
    return this.of(rig).find((r) => r.runner === runner);
  }

  /** Every runner process on a cluster's namespaces, not removed. */
  onCluster(cluster: string): RigRunner[] {
    return (
      this.db
        .prepare(
          "select rig, runner, cluster, namespace, placement, spec, status, created_at, created_by from rig_runner where cluster = ? and status <> 'removed'",
        )
        .all(cluster) as unknown as Row[]
    ).map(read);
  }

  /** A runner process control sets up, with its own token's hash; one removed before is replaced. */
  add(r: Omit<RigRunner, "status" | "created_at"> & { tokenSha256: string }): void {
    this.db
      .prepare(
        `insert into rig_runner (rig, runner, token_sha256, cluster, namespace, placement, spec, status, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, 'deploying', ?, ?)
         on conflict(rig, runner) do update set token_sha256 = excluded.token_sha256,
           cluster = excluded.cluster, namespace = excluded.namespace, placement = excluded.placement,
           spec = excluded.spec, status = 'deploying', created_at = excluded.created_at,
           created_by = excluded.created_by`,
      )
      .run(
        r.rig,
        r.runner,
        Credential.ofHash(r.tokenSha256).hex,
        r.cluster,
        r.namespace,
        r.placement,
        JSON.stringify(r.spec),
        new Date().toISOString(),
        r.created_by,
      );
    this.store.auditLog.add(r.created_by, "runner_added", { rig: r.rig, runner: r.runner });
  }

  setStatus(rig: string, runner: string, status: string): void {
    this.db
      .prepare("update rig_runner set status = ? where rig = ? and runner = ?")
      .run(status, rig, runner);
  }

  /** Its images, for an update of the rig's images. */
  setImages(rig: string, runner: string, images: RigRunnerSpec["images"]): void {
    const r = this.get(rig, runner);
    if (!r) return;
    this.db
      .prepare("update rig_runner set spec = ? where rig = ? and runner = ?")
      .run(JSON.stringify({ ...r.spec, images }), rig, runner);
  }

  /** Removed: its token stops working; its row stays, for the rig's history. */
  remove(rig: string, runner: string, by: string): void {
    this.db
      .prepare(
        "update rig_runner set status = 'removed', token_sha256 = null where rig = ? and runner = ?",
      )
      .run(rig, runner);
    this.store.auditLog.add(by, "runner_removed", { rig, runner });
  }

  /** Whether `token` is this runner process's own, and it is not removed. */
  tokenMatches(rig: string, runner: string, token: string): boolean {
    const r = this.db
      .prepare(
        "select token_sha256 from rig_runner where rig = ? and runner = ? and status <> 'removed'",
      )
      .get(rig, runner) as { token_sha256: string | null } | undefined;
    return r?.token_sha256 ? Credential.ofHash(r.token_sha256).matches(token) : false;
  }
}

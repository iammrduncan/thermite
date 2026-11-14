import { tokenHashHex, tokenMatches } from "../enrollments.ts";
import { type RigRunner, type RigRunnerSpec, type RigRunners, type Row, read } from "../runners.ts";
import { PgPart } from "./part.ts";

/** RigRunners on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigRunners extends PgPart implements RigRunners {
  /** A rig's runner processes control set up, removed ones too. */
  async of(rig: string): Promise<RigRunner[]> {
    return (
      (await this.q.all(
        "select rig, runner, cluster, namespace, placement, spec, status, created_at, created_by from rig_runner where rig = ? order by runner",
        rig,
      )) as unknown as Row[]
    ).map(read);
  }

  async get(rig: string, runner: string): Promise<RigRunner | undefined> {
    return (await this.of(rig)).find((r) => r.runner === runner);
  }

  /** Every runner process on a cluster's namespaces, not removed. */
  async onCluster(cluster: string): Promise<RigRunner[]> {
    return (
      (await this.q.all(
        "select rig, runner, cluster, namespace, placement, spec, status, created_at, created_by from rig_runner where cluster = ? and status <> 'removed'",
        cluster,
      )) as unknown as Row[]
    ).map(read);
  }

  /** A runner process control sets up, with its own token's hash; one removed before is replaced. */
  async add(r: Omit<RigRunner, "status" | "created_at"> & { tokenSha256: string }): Promise<void> {
    await this.q.run(
      `insert into rig_runner (rig, runner, token_sha256, cluster, namespace, placement, spec, status, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, 'deploying', ?, ?)
         on conflict(rig, runner) do update set token_sha256 = excluded.token_sha256,
           cluster = excluded.cluster, namespace = excluded.namespace, placement = excluded.placement,
           spec = excluded.spec, status = 'deploying', created_at = excluded.created_at,
           created_by = excluded.created_by`,
      r.rig,
      r.runner,
      tokenHashHex(r.tokenSha256),
      r.cluster,
      r.namespace,
      r.placement,
      JSON.stringify(r.spec),
      new Date().toISOString(),
      r.created_by,
    );
    await this.store.auditLog.add(r.created_by, "runner_added", { rig: r.rig, runner: r.runner });
  }

  async setStatus(rig: string, runner: string, status: string): Promise<void> {
    await this.q.run(
      "update rig_runner set status = ? where rig = ? and runner = ?",
      status,
      rig,
      runner,
    );
  }

  /** Set up and running, on any rig. */
  async running(): Promise<RigRunner[]> {
    return (
      (await this.q.all(
        "select rig, runner, cluster, namespace, placement, spec, status, created_at, created_by from rig_runner where status = 'running' order by rig, runner",
      )) as unknown as Row[]
    ).map(read);
  }

  /** Its gives to its rig, as they stand now. */
  async setGiven(rig: string, runner: string, given: RigRunnerSpec["given"]): Promise<void> {
    const r = await this.get(rig, runner);
    if (!r) return;
    await this.q.run(
      "update rig_runner set spec = ? where rig = ? and runner = ?",
      JSON.stringify({ ...r.spec, given }),
      rig,
      runner,
    );
  }

  /** Its images, for an update of the rig's images. */
  async setImages(rig: string, runner: string, images: RigRunnerSpec["images"]): Promise<void> {
    const r = await this.get(rig, runner);
    if (!r) return;
    await this.q.run(
      "update rig_runner set spec = ? where rig = ? and runner = ?",
      JSON.stringify({ ...r.spec, images }),
      rig,
      runner,
    );
  }

  /** Removed: its token stops working; its row stays, for the rig's history. */
  async remove(rig: string, runner: string, by: string): Promise<void> {
    await this.q.run(
      "update rig_runner set status = 'removed', token_sha256 = null where rig = ? and runner = ?",
      rig,
      runner,
    );
    await this.store.auditLog.add(by, "runner_removed", { rig, runner });
  }

  /** Whether `token` is this runner process's own, and it is not removed. */
  async tokenMatches(rig: string, runner: string, token: string): Promise<boolean> {
    const r = (await this.q.get(
      "select token_sha256 from rig_runner where rig = ? and runner = ? and status <> 'removed'",
      rig,
      runner,
    )) as { token_sha256: string | null } | undefined;
    return r?.token_sha256 ? tokenMatches(r.token_sha256, token) : false;
  }
}

import { redact } from "../../../common/log.ts";
import { type GpuCloud, type GpuClouds, gpuCloudOf } from "../gpu-clouds.ts";
import { PgPart, type Row } from "./part.ts";

/** GpuClouds on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresGpuClouds extends PgPart implements GpuClouds {
  async add(g: {
    name: string;
    kind: GpuCloud["kind"];
    key_sealed: string;
    key_hint: string;
    by: string;
  }): Promise<void> {
    await this.q.run(
      `insert into gpu_cloud (name, kind, key_sealed, key_hint, created_at, created_by)
         values (?, ?, ?, ?, ?, ?)`,
      g.name,
      g.kind,
      g.key_sealed,
      g.key_hint,
      new Date().toISOString(),
      g.by,
    );
    await this.store.auditLog.add(g.by, "gpu_cloud_added", {
      name: g.name,
      kind: g.kind,
      key_hint: g.key_hint,
    });
  }

  async get(name: string): Promise<(GpuCloud & { key_sealed: string }) | undefined> {
    const r = (await this.q.get("select * from gpu_cloud where name = ?", name)) as Row | undefined;
    return r ? { ...gpuCloudOf(r), key_sealed: String(r.key_sealed) } : undefined;
  }

  async list(): Promise<GpuCloud[]> {
    return ((await this.q.all("select * from gpu_cloud order by name")) as Row[]).map(gpuCloudOf);
  }

  async setFacts(name: string, r: { facts: unknown } | { error: string }): Promise<void> {
    if ("facts" in r)
      await this.q.run(
        "update gpu_cloud set facts = ?, checked_at = ?, check_error = null where name = ?",
        JSON.stringify(r.facts),
        new Date().toISOString(),
        name,
      );
    else
      await this.q.run(
        "update gpu_cloud set checked_at = ?, check_error = ? where name = ?",
        new Date().toISOString(),
        redact(r.error),
        name,
      );
  }

  async replaceKey(name: string, key_sealed: string, key_hint: string, by: string): Promise<void> {
    await this.q.run(
      "update gpu_cloud set key_sealed = ?, key_hint = ? where name = ?",
      key_sealed,
      key_hint,
      name,
    );
    await this.store.auditLog.add(by, "gpu_cloud_key_replaced", { name, key_hint });
  }

  async delete(name: string, by: string): Promise<boolean> {
    const r = await this.q.run("delete from gpu_cloud where name = ?", name);
    if (Number(r.changes)) await this.store.auditLog.add(by, "gpu_cloud_deleted", { name });
    return Number(r.changes) > 0;
  }
}

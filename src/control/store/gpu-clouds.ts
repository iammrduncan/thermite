import { redact } from "../../common/log.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * GPU clouds (goal 125, T6): RunPod accounts, their keys only sealed.
 */

/** A GPU cloud as listed (never its key). */
export interface GpuCloud {
  name: string;
  kind: "runpod";
  key_hint: string;
  facts: unknown;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
}

const gpuCloudOf = (r: Row): GpuCloud => ({
  name: String(r.name),
  kind: String(r.kind) as GpuCloud["kind"],
  key_hint: String(r.key_hint),
  facts: r.facts ? JSON.parse(String(r.facts)) : null,
  checked_at: r.checked_at === null ? null : String(r.checked_at),
  check_error: r.check_error === null ? null : String(r.check_error),
  created_at: String(r.created_at),
});

export class GpuClouds extends StorePart {
  add(g: {
    name: string;
    kind: GpuCloud["kind"];
    key_sealed: string;
    key_hint: string;
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into gpu_cloud (name, kind, key_sealed, key_hint, created_at, created_by)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(g.name, g.kind, g.key_sealed, g.key_hint, new Date().toISOString(), g.by);
    this.store.auditLog.add(g.by, "gpu_cloud_added", {
      name: g.name,
      kind: g.kind,
      key_hint: g.key_hint,
    });
  }

  get(name: string): (GpuCloud & { key_sealed: string }) | undefined {
    const r = this.db.prepare("select * from gpu_cloud where name = ?").get(name) as
      | Row
      | undefined;
    return r ? { ...gpuCloudOf(r), key_sealed: String(r.key_sealed) } : undefined;
  }

  list(): GpuCloud[] {
    return (this.db.prepare("select * from gpu_cloud order by name").all() as Row[]).map(
      gpuCloudOf,
    );
  }

  setFacts(name: string, r: { facts: unknown } | { error: string }): void {
    if ("facts" in r)
      this.db
        .prepare(
          "update gpu_cloud set facts = ?, checked_at = ?, check_error = null where name = ?",
        )
        .run(JSON.stringify(r.facts), new Date().toISOString(), name);
    else
      this.db
        .prepare("update gpu_cloud set checked_at = ?, check_error = ? where name = ?")
        .run(new Date().toISOString(), redact(r.error), name);
  }

  replaceKey(name: string, key_sealed: string, key_hint: string, by: string): void {
    this.db
      .prepare("update gpu_cloud set key_sealed = ?, key_hint = ? where name = ?")
      .run(key_sealed, key_hint, name);
    this.store.auditLog.add(by, "gpu_cloud_key_replaced", { name, key_hint });
  }

  delete(name: string, by: string): boolean {
    const r = this.db.prepare("delete from gpu_cloud where name = ?").run(name);
    if (Number(r.changes)) this.store.auditLog.add(by, "gpu_cloud_deleted", { name });
    return Number(r.changes) > 0;
  }
}

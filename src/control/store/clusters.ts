import { redact } from "../../common/log.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Clusters (goal 125, T6): the Kubernetes clusters, their kubeconfigs only sealed, and the rigs
 * control set up on them.
 */

/** A cluster as listed (never its kubeconfig). */
export interface Cluster {
  name: string;
  context: string;
  placement: "created" | "slot";
  namespace_pattern: string;
  slots: string[];
  facts: unknown;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
}

/** A rig control set up on a cluster; spec holds what it was deployed with (no secrets). */
export interface ClusterRig {
  rig: string;
  cluster: string;
  namespace: string;
  placement: "created" | "slot";
  spec: {
    gpus: number;
    /** With two or more GPUs, how many are the judge's. */
    judgeGpus?: number | undefined;
    gpuMode: "device-plugin" | "dra";
    deviceClass?: string | undefined;
    node?: string | undefined;
    storageClass?: string | undefined;
    storageGi: number;
    /** The rig's CPUs and memory; none: the namespace's defaults. */
    resources?: { cpus: number; memoryGi: number } | undefined;
    images: { harness: string; supervisor: string };
    /** Control's address the rig's supervisor reports to, as last deployed (older rigs: unknown). */
    controlUrl?: string | undefined;
  };
  status: string;
  created_at: string;
  created_by: string;
  /** A change to its GPUs, CPUs or memory that waits while the rig drains; only while draining. */
  pending?: ClusterRigResize | undefined;
}

/** A cluster rig's GPUs, the judge's share of them and its CPUs and memory, as control deploys them. */
export interface ClusterRigSize {
  gpus: number;
  /** With two or more GPUs, how many are the judge's. */
  judgeGpus?: number | undefined;
  /** None: the namespace's defaults. */
  resources?: { cpus: number; memoryGi: number } | undefined;
}

/** A new size that waits for the rig's drain, and who asked for it. */
export interface ClusterRigResize extends ClusterRigSize {
  by: string;
}

const clusterOf = (r: Row): Cluster => ({
  name: String(r.name),
  context: String(r.context),
  placement: String(r.placement) as Cluster["placement"],
  namespace_pattern: String(r.namespace_pattern),
  slots: JSON.parse(String(r.slots)) as string[],
  facts: r.facts ? JSON.parse(String(r.facts)) : null,
  checked_at: r.checked_at === null ? null : String(r.checked_at),
  check_error: r.check_error === null ? null : String(r.check_error),
  created_at: String(r.created_at),
});

const clusterRigOf = (r: Row): ClusterRig => ({
  rig: String(r.rig),
  cluster: String(r.cluster),
  namespace: String(r.namespace),
  placement: String(r.placement) as ClusterRig["placement"],
  spec: JSON.parse(String(r.spec)) as ClusterRig["spec"],
  status: String(r.status),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
  ...(r.pending ? { pending: JSON.parse(String(r.pending)) as ClusterRigResize } : {}),
});

export class Clusters extends StorePart {
  add(c: {
    name: string;
    kubeconfig_sealed: string;
    context: string;
    placement: Cluster["placement"];
    namespace_pattern: string;
    slots: string[];
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into cluster (name, kubeconfig_sealed, context, placement, namespace_pattern, slots, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.name,
        c.kubeconfig_sealed,
        c.context,
        c.placement,
        c.namespace_pattern,
        JSON.stringify(c.slots),
        new Date().toISOString(),
        c.by,
      );
    this.store.auditLog.add(c.by, "cluster_added", {
      name: c.name,
      context: c.context,
      placement: c.placement,
      slots: c.slots,
    });
  }

  get(name: string): (Cluster & { kubeconfig_sealed: string }) | undefined {
    const r = this.db.prepare("select * from cluster where name = ?").get(name) as Row | undefined;
    return r ? { ...clusterOf(r), kubeconfig_sealed: String(r.kubeconfig_sealed) } : undefined;
  }

  list(): Cluster[] {
    return (this.db.prepare("select * from cluster order by name").all() as Row[]).map(clusterOf);
  }

  /** A cluster of pre-made slots: the slots control may use. */
  setSlots(name: string, slots: string[], by: string): void {
    this.db.prepare("update cluster set slots = ? where name = ?").run(JSON.stringify(slots), name);
    this.store.auditLog.add(by, "cluster_slots_set", { name, slots });
  }

  setFacts(name: string, r: { facts: unknown } | { error: string }): void {
    if ("facts" in r)
      this.db
        .prepare("update cluster set facts = ?, checked_at = ?, check_error = null where name = ?")
        .run(JSON.stringify(r.facts), new Date().toISOString(), name);
    else
      this.db
        .prepare("update cluster set checked_at = ?, check_error = ? where name = ?")
        .run(new Date().toISOString(), redact(r.error), name);
  }

  delete(name: string, by: string): boolean {
    const r = this.db.prepare("delete from cluster where name = ?").run(name);
    if (Number(r.changes)) this.store.auditLog.add(by, "cluster_deleted", { name });
    return Number(r.changes) > 0;
  }

  addRig(r: Omit<ClusterRig, "created_at" | "status">): void {
    this.db
      .prepare(
        `insert into cluster_rig (rig, cluster, namespace, placement, spec, status, created_at, created_by)
         values (?, ?, ?, ?, ?, 'deploying', ?, ?)`,
      )
      .run(
        r.rig,
        r.cluster,
        r.namespace,
        r.placement,
        JSON.stringify(r.spec),
        new Date().toISOString(),
        r.created_by,
      );
    this.store.auditLog.add(r.created_by, "cluster_rig_created", {
      rig: r.rig,
      cluster: r.cluster,
      namespace: r.namespace,
      placement: r.placement,
      gpus: r.spec.gpus,
    });
  }

  rig(rig: string): ClusterRig | undefined {
    const r = this.db.prepare("select * from cluster_rig where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? clusterRigOf(r) : undefined;
  }

  rigs(cluster?: string): ClusterRig[] {
    const rows = (
      cluster
        ? this.db.prepare("select * from cluster_rig where cluster = ? order by rig").all(cluster)
        : this.db.prepare("select * from cluster_rig order by cluster, rig").all()
    ) as Row[];
    return rows.map(clusterRigOf);
  }

  /** A rig's status there. A change waiting for its drain ends with the drain: kept only while draining. */
  setRigStatus(rig: string, status: string): void {
    this.db
      .prepare(
        "update cluster_rig set status = ?, pending = case when ? = 'draining' then pending else null end where rig = ?",
      )
      .run(status, status, rig);
  }

  /** The change to a rig's GPUs, CPUs or memory that waits for its drain; null: none. */
  setRigPending(rig: string, pending: ClusterRigResize | null): void {
    this.db
      .prepare("update cluster_rig set pending = ? where rig = ?")
      .run(pending ? JSON.stringify(pending) : null, rig);
  }

  /** The GPUs, judge's share and CPUs and memory a rig on a cluster now runs with, after a change. */
  setRigSize(rig: string, size: ClusterRigSize, controlUrl?: string | undefined): void {
    const r = this.rig(rig);
    if (!r) return;
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      gpus: size.gpus,
      judgeGpus: size.judgeGpus,
      resources: size.resources,
      ...(controlUrl ? { controlUrl } : {}),
    };
    this.db.prepare("update cluster_rig set spec = ? where rig = ?").run(JSON.stringify(spec), rig);
  }

  /** The images a rig on a cluster now runs, after an image update. */
  setRigImages(
    rig: string,
    images: ClusterRig["spec"]["images"],
    controlUrl?: string | undefined,
  ): void {
    const r = this.rig(rig);
    if (!r) return;
    this.db
      .prepare("update cluster_rig set spec = ? where rig = ?")
      .run(JSON.stringify({ ...r.spec, images, ...(controlUrl ? { controlUrl } : {}) }), rig);
  }
}

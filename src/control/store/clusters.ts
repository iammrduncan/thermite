import type { DatabaseSync } from "node:sqlite";
import { redact } from "../../common/log.ts";
import type { ProgramMode } from "../../core/rig-settings.ts";
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
  /**
   * The owner accepted that control's connection to the cluster is not checked (its kubeconfig
   * skips TLS checks or uses plain http): what is unchecked, by whom, when. Null: it is checked.
   */
  unchecked: { what: string[]; by: string; at: string } | null;
}

/**
 * Store migration 21: a cluster keeps the owner's acceptance of a connection control can't
 * check, when its kubeconfig has one.
 */
export function clusterUncheckedColumn(db: DatabaseSync): void {
  const cols = db.prepare("pragma table_info(cluster)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "unchecked"))
    db.exec("alter table cluster add column unchecked text");
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
    /**
     * How its agent programs ran as control last wrote its deployments, which set its supervisor's
     * share of those CPUs and memory (clusters/manifests.ts). None: written before the share
     * followed it, with 2 GiB, the headless share.
     */
    programMode?: ProgramMode | undefined;
    images: { harness: string; supervisor: string };
    /** Control's address the rig's supervisor reports to, as last deployed (older rigs: unknown). */
    controlUrl?: string | undefined;
    /**
     * In a slot: each address of the list of addresses rigs may reach that the slot's rules
     * opened when control added the rig, on its ports, with the rule's name.
     */
    openings?: { address: string; ports: number[]; rule: string }[] | undefined;
    /**
     * In a slot: whether its rules let only the rig's supervisor connect to its harness, and why
     * not, as control last read them; a warning on the rig's page, never a refusal.
     */
    ingress?: { ok: boolean; why: string } | undefined;
  };
  status: string;
  created_at: string;
  created_by: string;
  /** A change to its GPUs, CPUs or memory that waits while the rig drains; only while draining. */
  pending?: ClusterRigResize | undefined;
}

/**
 * A cluster rig's GPUs, the judge's share of them and its CPUs and memory, as control deploys them,
 * with how its agent programs run, which sets its supervisor's share of the memory.
 */
export interface ClusterRigSize {
  gpus: number;
  /** With two or more GPUs, how many are the judge's. */
  judgeGpus?: number | undefined;
  /** None: the namespace's defaults. */
  resources?: { cpus: number; memoryGi: number } | undefined;
  programMode: ProgramMode;
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
  unchecked: r.unchecked ? (JSON.parse(String(r.unchecked)) as Cluster["unchecked"]) : null,
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
    /** What of its connection control can't check, which the owner accepted; none: all checked. */
    unchecked?: string[] | undefined;
  }): void {
    const at = new Date().toISOString();
    const unchecked = c.unchecked?.length ? { what: c.unchecked, by: c.by, at } : null;
    this.db
      .prepare(
        `insert into cluster (name, kubeconfig_sealed, context, placement, namespace_pattern, slots, created_at, created_by, unchecked)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.name,
        c.kubeconfig_sealed,
        c.context,
        c.placement,
        c.namespace_pattern,
        JSON.stringify(c.slots),
        at,
        c.by,
        unchecked ? JSON.stringify(unchecked) : null,
      );
    this.store.auditLog.add(c.by, "cluster_added", {
      name: c.name,
      context: c.context,
      placement: c.placement,
      slots: c.slots,
      ...(unchecked ? { unchecked_accepted: unchecked.what } : {}),
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
      programMode: size.programMode,
      ...(controlUrl ? { controlUrl } : {}),
    };
    this.db.prepare("update cluster_rig set spec = ? where rig = ?").run(JSON.stringify(spec), rig);
  }

  /** What a slot rig's slot opens of the list of addresses rigs may reach, and lets in, read now. */
  setRigSlotNetwork(rig: string, n: Pick<ClusterRig["spec"], "openings" | "ingress">): void {
    const r = this.rig(rig);
    if (!r) return;
    // A field set to undefined is left out of the JSON.
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      openings: n.openings?.length ? n.openings : undefined,
      ingress: n.ingress,
    };
    this.db.prepare("update cluster_rig set spec = ? where rig = ?").run(JSON.stringify(spec), rig);
  }

  /**
   * The images a rig on a cluster now runs, after an image update, and how its agent programs ran
   * as its deployments were written.
   */
  setRigImages(
    rig: string,
    images: ClusterRig["spec"]["images"],
    programMode: ProgramMode,
    controlUrl?: string | undefined,
  ): void {
    const r = this.rig(rig);
    if (!r) return;
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      images,
      programMode,
      ...(controlUrl ? { controlUrl } : {}),
    };
    this.db.prepare("update cluster_rig set spec = ? where rig = ?").run(JSON.stringify(spec), rig);
  }
}

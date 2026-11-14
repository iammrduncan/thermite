import { redact } from "../../../common/log.ts";
import type { ProgramMode } from "../../../core/rig-settings.ts";
import {
  type Cluster,
  type ClusterRig,
  type ClusterRigResize,
  type ClusterRigSize,
  type Clusters,
  clusterOf,
  clusterRigOf,
} from "../clusters.ts";
import { PgPart, type Row } from "./part.ts";

/** Clusters on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresClusters extends PgPart implements Clusters {
  async add(c: {
    name: string;
    kubeconfig_sealed: string;
    context: string;
    placement: Cluster["placement"];
    namespace_pattern: string;
    slots: string[];
    by: string;
    /** What of its connection control can't check, which the owner accepted; none: all checked. */
    unchecked?: string[] | undefined;
  }): Promise<void> {
    const at = new Date().toISOString();
    const unchecked = c.unchecked?.length ? { what: c.unchecked, by: c.by, at } : null;
    await this.q.run(
      `insert into cluster (name, kubeconfig_sealed, context, placement, namespace_pattern, slots, created_at, created_by, unchecked)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    await this.store.auditLog.add(c.by, "cluster_added", {
      name: c.name,
      context: c.context,
      placement: c.placement,
      slots: c.slots,
      ...(unchecked ? { unchecked_accepted: unchecked.what } : {}),
    });
  }

  async get(name: string): Promise<(Cluster & { kubeconfig_sealed: string }) | undefined> {
    const r = (await this.q.get("select * from cluster where name = ?", name)) as Row | undefined;
    return r ? { ...clusterOf(r), kubeconfig_sealed: String(r.kubeconfig_sealed) } : undefined;
  }

  async list(): Promise<Cluster[]> {
    return ((await this.q.all("select * from cluster order by name")) as Row[]).map(clusterOf);
  }

  /** A cluster of pre-made slots: the slots control may use. */
  async setSlots(name: string, slots: string[], by: string): Promise<void> {
    await this.q.run("update cluster set slots = ? where name = ?", JSON.stringify(slots), name);
    await this.store.auditLog.add(by, "cluster_slots_set", { name, slots });
  }

  async setFacts(name: string, r: { facts: unknown } | { error: string }): Promise<void> {
    if ("facts" in r)
      await this.q.run(
        "update cluster set facts = ?, checked_at = ?, check_error = null where name = ?",
        JSON.stringify(r.facts),
        new Date().toISOString(),
        name,
      );
    else
      await this.q.run(
        "update cluster set checked_at = ?, check_error = ? where name = ?",
        new Date().toISOString(),
        redact(r.error),
        name,
      );
  }

  async delete(name: string, by: string): Promise<boolean> {
    const r = await this.q.run("delete from cluster where name = ?", name);
    if (Number(r.changes)) await this.store.auditLog.add(by, "cluster_deleted", { name });
    return Number(r.changes) > 0;
  }

  async addRig(r: Omit<ClusterRig, "created_at" | "status">): Promise<void> {
    await this.q.run(
      `insert into cluster_rig (rig, cluster, namespace, placement, spec, status, created_at, created_by)
         values (?, ?, ?, ?, ?, 'deploying', ?, ?)`,
      r.rig,
      r.cluster,
      r.namespace,
      r.placement,
      JSON.stringify(r.spec),
      new Date().toISOString(),
      r.created_by,
    );
    await this.store.auditLog.add(r.created_by, "cluster_rig_created", {
      rig: r.rig,
      cluster: r.cluster,
      namespace: r.namespace,
      placement: r.placement,
      gpus: r.spec.gpus,
    });
  }

  async rig(rig: string): Promise<ClusterRig | undefined> {
    const r = (await this.q.get("select * from cluster_rig where rig = ?", rig)) as Row | undefined;
    return r ? clusterRigOf(r) : undefined;
  }

  async rigs(cluster?: string): Promise<ClusterRig[]> {
    const rows = (
      cluster
        ? await this.q.all("select * from cluster_rig where cluster = ? order by rig", cluster)
        : await this.q.all("select * from cluster_rig order by cluster, rig")
    ) as Row[];
    return rows.map(clusterRigOf);
  }

  /** A rig's status there. A change waiting for its drain ends with the drain: kept only while draining. */
  async setRigStatus(rig: string, status: string): Promise<void> {
    await this.q.run(
      "update cluster_rig set status = ?, pending = case when ? = 'draining' then pending else null end where rig = ?",
      status,
      status,
      rig,
    );
  }

  /** The change to a rig's GPUs, CPUs or memory that waits for its drain; null: none. */
  async setRigPending(rig: string, pending: ClusterRigResize | null): Promise<void> {
    await this.q.run(
      "update cluster_rig set pending = ? where rig = ?",
      pending ? JSON.stringify(pending) : null,
      rig,
    );
  }

  /** The GPUs, judge's share and CPUs and memory a rig on a cluster now runs with, after a change. */
  async setRigSize(
    rig: string,
    size: ClusterRigSize,
    controlUrl?: string | undefined,
  ): Promise<void> {
    const r = await this.rig(rig);
    if (!r) return;
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      gpus: size.gpus,
      judgeGpus: size.judgeGpus,
      resources: size.resources,
      programMode: size.programMode,
      ...(controlUrl ? { controlUrl } : {}),
    };
    await this.q.run("update cluster_rig set spec = ? where rig = ?", JSON.stringify(spec), rig);
  }

  /** What a slot rig's slot opens of the list of addresses rigs may reach, and lets in, read now. */
  async setRigSlotNetwork(
    rig: string,
    n: Pick<ClusterRig["spec"], "openings" | "ingress">,
  ): Promise<void> {
    const r = await this.rig(rig);
    if (!r) return;
    // A field set to undefined is left out of the JSON.
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      openings: n.openings?.length ? n.openings : undefined,
      ingress: n.ingress,
    };
    await this.q.run("update cluster_rig set spec = ? where rig = ?", JSON.stringify(spec), rig);
  }

  /**
   * The images a rig on a cluster now runs, after an image update, and how its agent programs ran
   * as its deployments were written.
   */
  /** The node a rig control set up runs on, for its setup again (goal 206); none: any node. */
  async setRigNode(rig: string, node: string | undefined): Promise<void> {
    const r = await this.rig(rig);
    if (!r) return;
    const spec: ClusterRig["spec"] = { ...r.spec, node };
    await this.q.run("update cluster_rig set spec = ? where rig = ?", JSON.stringify(spec), rig);
  }

  async setRigImages(
    rig: string,
    images: ClusterRig["spec"]["images"],
    programMode: ProgramMode,
    controlUrl?: string | undefined,
  ): Promise<void> {
    const r = await this.rig(rig);
    if (!r) return;
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      images,
      programMode,
      ...(controlUrl ? { controlUrl } : {}),
    };
    await this.q.run("update cluster_rig set spec = ? where rig = ?", JSON.stringify(spec), rig);
  }
}

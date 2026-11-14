import { type TunnelRig, type TunnelRigs, type TunnelSecrets, tunnelRigOf } from "../tunnels.ts";
import { PgPart, type Row } from "./part.ts";

/** TunnelRigs on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresTunnelRigs extends PgPart implements TunnelRigs {
  /** A rig minted for a pod about to be launched; its pod comes later (attachTunnelPod). */
  async add(
    t: Pick<
      TunnelRig,
      "rig" | "port" | "box_public" | "code_expires_at" | "config" | "created_by"
    > & {
      prefix_sealed: string;
      box_private_sealed: string;
      code_sealed: string;
      leaf_ca?: string | null | undefined;
    },
  ): Promise<void> {
    await this.q.run(
      `insert into tunnel_rig (rig, port, prefix_sealed, box_private_sealed, box_public,
           code_sealed, code_expires_at, config, created_at, created_by, leaf_ca)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.rig,
      t.port,
      t.prefix_sealed,
      t.box_private_sealed,
      t.box_public,
      t.code_sealed,
      t.code_expires_at,
      JSON.stringify(t.config),
      new Date().toISOString(),
      t.created_by,
      t.leaf_ca ?? null,
    );
    await this.store.auditLog.add(t.created_by, "tunnel_rig_added", {
      rig: t.rig,
      code_expires_at: t.code_expires_at,
    });
  }

  /** The pod a rig in pull mode runs in, and control's address for it; refused once enrolled. */
  async attachPod(rig: string, pod: string, url: string): Promise<boolean> {
    const r = await this.q.run(
      "update tunnel_rig set pod = ?, url = ? where rig = ? and enrolled_at is null",
      pod,
      url,
      rig,
    );
    if (Number(r.changes))
      await this.store.auditLog.add("control", "tunnel_rig_pod", { rig, pod, url });
    return Number(r.changes) > 0;
  }

  async get(rig: string): Promise<(TunnelRig & TunnelSecrets) | undefined> {
    const r = (await this.q.get("select * from tunnel_rig where rig = ?", rig)) as Row | undefined;
    return r ? tunnelRigOf(r) : undefined;
  }

  async list(): Promise<TunnelRig[]> {
    return ((await this.q.all("select * from tunnel_rig order by rig")) as Row[]).map((r) => {
      const {
        prefix_sealed: _p,
        box_private_sealed: _b,
        code_sealed: _c,
        ...rest
      } = tunnelRigOf(r);
      return rest;
    });
  }

  /**
   * Removes a minted rig whose pod was never made (its launch failed): nothing can enroll with
   * its code any more. Refused once it has a pod.
   */
  async drop(rig: string, by: string): Promise<boolean> {
    const r = await this.q.run(
      "delete from tunnel_rig where rig = ? and pod is null and enrolled_at is null",
      rig,
    );
    if (Number(r.changes)) await this.store.auditLog.add(by, "tunnel_rig_dropped", { rig });
    return Number(r.changes) > 0;
  }

  /** Pins the pod's keys and spends the code; refused once pinned (a second enrollment). */
  async pin(rig: string, sign: string, box: string): Promise<boolean> {
    const r = await this.q.run(
      `update tunnel_rig set pod_sign_public = ?, pod_box_public = ?, enrolled_at = ?,
           code_sealed = '', error = null
         where rig = ? and enrolled_at is null`,
      sign,
      box,
      new Date().toISOString(),
      rig,
    );
    if (Number(r.changes)) await this.store.auditLog.add("control", "tunnel_rig_enrolled", { rig });
    return Number(r.changes) > 0;
  }

  /**
   * The pod's address for the bus, as RunPod gives it while the pod runs (null: it has none now,
   * as while stopped): kept when it changes, a new address with a step in the rig's history. False
   * when it is the one kept, or the rig has no leaf.
   */
  async setLeafAddress(rig: string, address: string | null): Promise<boolean> {
    const r = await this.q.run(
      `update tunnel_rig set leaf_address = ?, leaf_address_at = ?
         where rig = ? and leaf_ca is not null and leaf_address is distinct from ?`,
      address,
      new Date().toISOString(),
      rig,
      address,
    );
    if (!Number(r.changes)) return false;
    if (address) await this.store.rigHistory.add(rig, "runpod_leaf_address", true, address);
    return true;
  }

  /** After each exchange: when it was, what the pod refused since, and the last error. */
  async exchanged(rig: string, r: { refused?: number; error?: string | null }): Promise<void> {
    await this.q.run(
      `update tunnel_rig set last_exchange_at = case when ?::int is null then last_exchange_at else ? end,
           refused_total = refused_total + ?, error = ? where rig = ?`,
      r.error ? null : 1,
      new Date().toISOString(),
      r.refused ?? 0,
      r.error ?? null,
      rig,
    );
    if (r.refused)
      await this.store.auditLog.add("control", "tunnel_refusals", { rig, refused: r.refused });
  }
}

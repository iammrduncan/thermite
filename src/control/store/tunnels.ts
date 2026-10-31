import type { DatabaseSync } from "node:sqlite";
import { PodConfig } from "../../core/tunnel.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Rigs in pull mode (goal 125, T6): each rig minted for a pod, its pod, its enrollment and its
 * exchanges, its secrets only sealed; and its leaf node on the message bus (goal 168): its pod's
 * authority, and the pod's address once RunPod gave it.
 */

/**
 * Store migration 22: a rig in pull mode keeps its pod's leaf node authority (public), and the
 * pod's address for the bus, with when it last changed.
 */
export function tunnelLeafColumns(db: DatabaseSync): void {
  const cols = (db.prepare("pragma table_info(tunnel_rig)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  for (const c of ["leaf_ca", "leaf_address", "leaf_address_at"])
    if (!cols.includes(c)) db.exec(`alter table tunnel_rig add column ${c} text`);
}

/** A rig in pull mode, as listed: never its sealed secrets. */
export interface TunnelRig {
  rig: string;
  /** The pod and control's address for it, once launched. */
  pod: string | null;
  url: string | null;
  /** The port the pod serves for control. */
  port: number;
  box_public: string;
  /** When the enrollment code expires; null: it does not. */
  code_expires_at: string | null;
  /** The rig's settings, given to the pod at enrollment. */
  config: PodConfig;
  pod_sign_public: string | null;
  pod_box_public: string | null;
  enrolled_at: string | null;
  last_exchange_at: string | null;
  refused_total: number;
  error: string | null;
  created_at: string;
  created_by: string;
  /** The pod's leaf node authority's certificate; null: launched without the leaf. */
  leaf_ca: string | null;
  /** The pod's public address and port for the bus, as RunPod gave it last; null: none yet. */
  leaf_address: string | null;
  leaf_address_at: string | null;
}

export interface TunnelSecrets {
  prefix_sealed: string;
  box_private_sealed: string;
  code_sealed: string;
}

const tunnelRigOf = (r: Row): TunnelRig & TunnelSecrets => {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    rig: String(r.rig),
    pod: opt(r.pod),
    url: opt(r.url),
    port: Number(r.port),
    prefix_sealed: String(r.prefix_sealed),
    box_private_sealed: String(r.box_private_sealed),
    box_public: String(r.box_public),
    code_sealed: String(r.code_sealed),
    code_expires_at: opt(r.code_expires_at),
    config: PodConfig.parse(JSON.parse(String(r.config))),
    pod_sign_public: opt(r.pod_sign_public),
    pod_box_public: opt(r.pod_box_public),
    enrolled_at: opt(r.enrolled_at),
    last_exchange_at: opt(r.last_exchange_at),
    refused_total: Number(r.refused_total ?? 0),
    error: opt(r.error),
    created_at: String(r.created_at),
    created_by: String(r.created_by),
    leaf_ca: opt(r.leaf_ca),
    leaf_address: opt(r.leaf_address),
    leaf_address_at: opt(r.leaf_address_at),
  };
};

export class TunnelRigs extends StorePart {
  /** A rig minted for a pod about to be launched; its pod comes later (attachTunnelPod). */
  add(
    t: Pick<
      TunnelRig,
      "rig" | "port" | "box_public" | "code_expires_at" | "config" | "created_by"
    > & {
      prefix_sealed: string;
      box_private_sealed: string;
      code_sealed: string;
      leaf_ca?: string | null | undefined;
    },
  ): void {
    this.db
      .prepare(
        `insert into tunnel_rig (rig, port, prefix_sealed, box_private_sealed, box_public,
           code_sealed, code_expires_at, config, created_at, created_by, leaf_ca)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    this.store.auditLog.add(t.created_by, "tunnel_rig_added", {
      rig: t.rig,
      code_expires_at: t.code_expires_at,
    });
  }

  /** The pod a rig in pull mode runs in, and control's address for it; refused once enrolled. */
  attachPod(rig: string, pod: string, url: string): boolean {
    const r = this.db
      .prepare("update tunnel_rig set pod = ?, url = ? where rig = ? and enrolled_at is null")
      .run(pod, url, rig);
    if (Number(r.changes)) this.store.auditLog.add("control", "tunnel_rig_pod", { rig, pod, url });
    return Number(r.changes) > 0;
  }

  get(rig: string): (TunnelRig & TunnelSecrets) | undefined {
    const r = this.db.prepare("select * from tunnel_rig where rig = ?").get(rig) as Row | undefined;
    return r ? tunnelRigOf(r) : undefined;
  }

  list(): TunnelRig[] {
    return (this.db.prepare("select * from tunnel_rig order by rig").all() as Row[]).map((r) => {
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
  drop(rig: string, by: string): boolean {
    const r = this.db
      .prepare("delete from tunnel_rig where rig = ? and pod is null and enrolled_at is null")
      .run(rig);
    if (Number(r.changes)) this.store.auditLog.add(by, "tunnel_rig_dropped", { rig });
    return Number(r.changes) > 0;
  }

  /** Pins the pod's keys and spends the code; refused once pinned (a second enrollment). */
  pin(rig: string, sign: string, box: string): boolean {
    const r = this.db
      .prepare(
        `update tunnel_rig set pod_sign_public = ?, pod_box_public = ?, enrolled_at = ?,
           code_sealed = '', error = null
         where rig = ? and enrolled_at is null`,
      )
      .run(sign, box, new Date().toISOString(), rig);
    if (Number(r.changes)) this.store.auditLog.add("control", "tunnel_rig_enrolled", { rig });
    return Number(r.changes) > 0;
  }

  /**
   * The pod's address for the bus, as RunPod gives it while the pod runs (null: it has none now,
   * as while stopped): kept when it changes, a new address with a step in the rig's history. False
   * when it is the one kept, or the rig has no leaf.
   */
  setLeafAddress(rig: string, address: string | null): boolean {
    const r = this.db
      .prepare(
        `update tunnel_rig set leaf_address = ?, leaf_address_at = ?
         where rig = ? and leaf_ca is not null and leaf_address is not ?`,
      )
      .run(address, new Date().toISOString(), rig, address);
    if (!Number(r.changes)) return false;
    if (address) this.store.rigHistory.add(rig, "runpod_leaf_address", true, address);
    return true;
  }

  /** After each exchange: when it was, what the pod refused since, and the last error. */
  exchanged(rig: string, r: { refused?: number; error?: string | null }): void {
    this.db
      .prepare(
        `update tunnel_rig set last_exchange_at = case when ? is null then last_exchange_at else ? end,
           refused_total = refused_total + ?, error = ? where rig = ?`,
      )
      .run(r.error ? null : 1, new Date().toISOString(), r.refused ?? 0, r.error ?? null, rig);
    if (r.refused)
      this.store.auditLog.add("control", "tunnel_refusals", { rig, refused: r.refused });
  }
}

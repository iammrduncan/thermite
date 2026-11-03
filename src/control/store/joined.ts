import { Credential } from "../credential.ts";
import type { JoinedSpec, JoinForm } from "../join.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Rigs the owner joins themself (goal 125, T6), and their join commands.
 */

/** A rig the owner joins themself; never the join command itself, only whether one waits. */
export interface JoinedRig {
  rig: string;
  form: JoinForm;
  spec: JoinedSpec;
  join_expires_at: string | null;
  join_used_at: string | null;
  status: string;
  created_at: string;
  created_by: string;
}

const joinedRigOf = (r: Row): JoinedRig => ({
  rig: String(r.rig),
  form: String(r.form) as JoinForm,
  spec: JSON.parse(String(r.spec)) as JoinedSpec,
  join_expires_at: r.join_expires_at === null ? null : String(r.join_expires_at),
  join_used_at: r.join_used_at === null ? null : String(r.join_used_at),
  status: String(r.status),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

export class JoinedRigs extends StorePart {
  add(r: { rig: string; form: JoinForm; spec: JoinedSpec; by: string }): void {
    this.db
      .prepare(
        `insert into joined_rig (rig, form, spec, status, created_at, created_by)
         values (?, ?, ?, 'waiting', ?, ?)`,
      )
      .run(r.rig, r.form, JSON.stringify(r.spec), new Date().toISOString(), r.by);
    this.store.auditLog.add(r.by, "joined_rig_added", { rig: r.rig, form: r.form });
  }

  get(rig: string): JoinedRig | undefined {
    const r = this.db.prepare("select * from joined_rig where rig = ?").get(rig) as Row | undefined;
    return r ? joinedRigOf(r) : undefined;
  }

  /** A new join command for the rig (its hash); any earlier one stops working. */
  setToken(rig: string, sha256: string, expiresAt: string, by: string): void {
    this.db
      .prepare(
        "update joined_rig set join_sha256 = ?, join_expires_at = ?, join_used_at = null where rig = ?",
      )
      .run(Credential.ofHash(sha256).hex, expiresAt, rig);
    this.store.auditLog.add(by, "join_command_made", { rig, expires_at: expiresAt });
  }

  revokeToken(rig: string, by: string): void {
    this.db
      .prepare(
        "update joined_rig set join_sha256 = null, join_expires_at = null where rig = ? and join_used_at is null",
      )
      .run(rig);
    this.store.auditLog.add(by, "join_command_revoked", { rig });
  }

  /**
   * Uses the rig's join command, once: true when the token is its current one, unused and not
   * expired; it then stops working.
   */
  useToken(rig: string, token: string): boolean {
    const r = this.db
      .prepare(
        "select join_sha256, join_expires_at, join_used_at, status from joined_rig where rig = ?",
      )
      .get(rig) as Row | undefined;
    if (!r || r.join_sha256 === null || r.join_used_at !== null || r.status === "retired")
      return false;
    if (Date.parse(String(r.join_expires_at)) <= Date.now()) return false;
    if (!Credential.ofHash(String(r.join_sha256)).matches(token)) return false;
    const u = this.db
      .prepare(
        "update joined_rig set join_used_at = ? where rig = ? and join_sha256 = ? and join_used_at is null",
      )
      .run(new Date().toISOString(), rig, String(r.join_sha256));
    if (Number(u.changes) !== 1) return false;
    this.store.auditLog.add(`rig:${rig}`, "join_command_used", { rig });
    return true;
  }

  set(rig: string, change: { status?: string; spec?: JoinedSpec }): void {
    const cur = this.get(rig);
    if (!cur) return;
    this.db
      .prepare("update joined_rig set status = ?, spec = ? where rig = ?")
      .run(change.status ?? cur.status, JSON.stringify(change.spec ?? cur.spec), rig);
  }
}

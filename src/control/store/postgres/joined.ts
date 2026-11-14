import { tokenHashHex, tokenMatches } from "../enrollments.ts";
import { type JoinedRig, type JoinedRigs, joinedRigOf } from "../joined.ts";
import { PgPart, type Row } from "./part.ts";

/** JoinedRigs on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresJoinedRigs extends PgPart implements JoinedRigs {
  async add(r: {
    rig: string;
    form: JoinedRig["form"];
    spec: JoinedRig["spec"];
    by: string;
  }): Promise<void> {
    await this.q.run(
      `insert into joined_rig (rig, form, spec, status, created_at, created_by)
         values (?, ?, ?, 'waiting', ?, ?)`,
      r.rig,
      r.form,
      JSON.stringify(r.spec),
      new Date().toISOString(),
      r.by,
    );
    await this.store.auditLog.add(r.by, "joined_rig_added", { rig: r.rig, form: r.form });
  }

  async get(rig: string): Promise<JoinedRig | undefined> {
    const r = (await this.q.get("select * from joined_rig where rig = ?", rig)) as Row | undefined;
    return r ? joinedRigOf(r) : undefined;
  }

  /** A new join command for the rig (its hash); any earlier one stops working. */
  async setToken(rig: string, sha256: string, expiresAt: string, by: string): Promise<void> {
    await this.q.run(
      "update joined_rig set join_sha256 = ?, join_expires_at = ?, join_used_at = null where rig = ?",
      tokenHashHex(sha256),
      expiresAt,
      rig,
    );
    await this.store.auditLog.add(by, "join_command_made", { rig, expires_at: expiresAt });
  }

  async revokeToken(rig: string, by: string): Promise<void> {
    await this.q.run(
      "update joined_rig set join_sha256 = null, join_expires_at = null where rig = ? and join_used_at is null",
      rig,
    );
    await this.store.auditLog.add(by, "join_command_revoked", { rig });
  }

  /**
   * Uses the rig's join command, once: true when the token is its current one, unused and not
   * expired; it then stops working.
   */
  async useToken(rig: string, token: string): Promise<boolean> {
    const r = (await this.q.get(
      "select join_sha256, join_expires_at, join_used_at, status from joined_rig where rig = ?",
      rig,
    )) as Row | undefined;
    if (!r || r.join_sha256 === null || r.join_used_at !== null || r.status === "retired")
      return false;
    if (Date.parse(String(r.join_expires_at)) <= Date.now()) return false;
    if (!tokenMatches(String(r.join_sha256), token)) return false;
    const u = await this.q.run(
      "update joined_rig set join_used_at = ? where rig = ? and join_sha256 = ? and join_used_at is null",
      new Date().toISOString(),
      rig,
      String(r.join_sha256),
    );
    if (Number(u.changes) !== 1) return false;
    await this.store.auditLog.add(`rig:${rig}`, "join_command_used", { rig });
    return true;
  }

  async set(rig: string, change: { status?: string; spec?: JoinedRig["spec"] }): Promise<void> {
    const cur = await this.get(rig);
    if (!cur) return;
    await this.q.run(
      "update joined_rig set status = ?, spec = ? where rig = ?",
      change.status ?? cur.status,
      JSON.stringify(change.spec ?? cur.spec),
      rig,
    );
  }
}

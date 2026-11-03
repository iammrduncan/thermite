import { Credential } from "../credential.ts";
import { type Row, StorePart } from "./part.ts";

/** Rigs enrolled through control (goal 125, T6), their tokens only as hashes. */

/** A rig enrolled through control. */
export interface EnrolledRig {
  rig: string;
  created_at: string;
  created_by: string;
  rotated_at: string | null;
  retired_at: string | null;
}

function enrolledOf(r: Row): EnrolledRig {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    rig: String(r.rig),
    created_at: String(r.created_at),
    created_by: String(r.created_by),
    rotated_at: opt(r.rotated_at),
    retired_at: opt(r.retired_at),
  };
}

export class Enrollments extends StorePart {
  /** Rigs that have a token but have not reported yet still accept commands. */
  knownRig(rig: string): boolean {
    return this.rig(rig) !== undefined || Boolean(this.store.tunnels.get(rig)?.enrolled_at);
  }

  /** An enrolled rig's record, if it is enrolled and not retired. */
  rig(rig: string): EnrolledRig | undefined {
    const r = this.db
      .prepare("select * from rig_token where rig = ? and retired_at is null")
      .get(rig) as Row | undefined;
    return r ? enrolledOf(r) : undefined;
  }

  /** Every rig enrolled through control, retired ones included. */
  rigs(): EnrolledRig[] {
    return (this.db.prepare("select * from rig_token order by rig").all() as Row[]).map(enrolledOf);
  }

  /** Whether a token is this enrolled rig's current one. */
  tokenMatches(rig: string, token: string): boolean {
    const r = this.db
      .prepare("select token_sha256 from rig_token where rig = ? and retired_at is null")
      .get(rig) as { token_sha256: string } | undefined;
    return r ? Credential.ofHash(r.token_sha256).matches(token) : false;
  }

  /** Enrolls a rig with a token's SHA-256. A retired rig may be enrolled again. */
  enroll(rig: string, tokenSha256: string, by: string): void {
    if (this.rig(rig)) throw new Error(`rig ${rig} is already enrolled`);
    this.db
      .prepare(
        `insert into rig_token (rig, token_sha256, created_at, created_by) values (?, ?, ?, ?)
         on conflict(rig) do update set token_sha256 = excluded.token_sha256,
           created_at = excluded.created_at, created_by = excluded.created_by,
           rotated_at = null, retired_at = null`,
      )
      .run(rig, Credential.ofHash(tokenSha256).hex, new Date().toISOString(), by);
    // Enrolled again under a retired name: it is back.
    this.store.retired.remove(rig);
    this.store.auditLog.add(by, "rig_enrolled", { rig });
  }

  /** Gives an enrolled rig a new token; the old one stops working at once. */
  rotateToken(rig: string, tokenSha256: string, by: string): void {
    const r = this.db
      .prepare(
        "update rig_token set token_sha256 = ?, rotated_at = ? where rig = ? and retired_at is null",
      )
      .run(Credential.ofHash(tokenSha256).hex, new Date().toISOString(), rig);
    if (Number(r.changes) === 0) throw new Error(`rig ${rig} is not enrolled`);
    this.store.auditLog.add(by, "rig_token_rotated", { rig });
  }

  /** Retires an enrolled rig: its token stops working. Its history stays. */
  retire(rig: string, by: string): void {
    const r = this.db
      .prepare("update rig_token set retired_at = ? where rig = ? and retired_at is null")
      .run(new Date().toISOString(), rig);
    if (Number(r.changes) === 0) throw new Error(`rig ${rig} is not enrolled`);
    this.store.auditLog.add(by, "rig_retired", { rig });
  }
}

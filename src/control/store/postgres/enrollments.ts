import {
  type EnrolledRig,
  type Enrollments,
  enrolledOf,
  tokenHashHex,
  tokenMatches,
} from "../enrollments.ts";
import { PgPart, type Row } from "./part.ts";

/** Enrollments on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresEnrollments extends PgPart implements Enrollments {
  /** Rigs that have a token but have not reported yet still accept commands. */
  async knownRig(rig: string): Promise<boolean> {
    return (
      (await this.rig(rig)) !== undefined ||
      Boolean((await this.store.tunnels.get(rig))?.enrolled_at)
    );
  }

  /** An enrolled rig's record, if it is enrolled and not retired. */
  async rig(rig: string): Promise<EnrolledRig | undefined> {
    const r = (await this.q.get(
      "select * from rig_token where rig = ? and retired_at is null",
      rig,
    )) as Row | undefined;
    return r ? enrolledOf(r) : undefined;
  }

  /** Every rig enrolled through control, retired ones included. */
  async rigs(): Promise<EnrolledRig[]> {
    return ((await this.q.all("select * from rig_token order by rig")) as Row[]).map(enrolledOf);
  }

  /** Whether a token is this enrolled rig's current one. */
  async tokenMatches(rig: string, token: string): Promise<boolean> {
    const r = (await this.q.get(
      "select token_sha256 from rig_token where rig = ? and retired_at is null",
      rig,
    )) as { token_sha256: string } | undefined;
    return r ? tokenMatches(r.token_sha256, token) : false;
  }

  /** Enrolls a rig with a token's SHA-256. A retired rig may be enrolled again. */
  async enroll(rig: string, tokenSha256: string, by: string): Promise<void> {
    if (await this.rig(rig)) throw new Error(`rig ${rig} is already enrolled`);
    await this.q.run(
      `insert into rig_token (rig, token_sha256, created_at, created_by) values (?, ?, ?, ?)
         on conflict(rig) do update set token_sha256 = excluded.token_sha256,
           created_at = excluded.created_at, created_by = excluded.created_by,
           rotated_at = null, retired_at = null`,
      rig,
      tokenHashHex(tokenSha256),
      new Date().toISOString(),
      by,
    );
    // Enrolled again under a retired name: it is back.
    await this.store.retired.remove(rig);
    await this.store.auditLog.add(by, "rig_enrolled", { rig });
  }

  /** Gives an enrolled rig a new token; the old one stops working at once. */
  async rotateToken(rig: string, tokenSha256: string, by: string): Promise<void> {
    const r = await this.q.run(
      "update rig_token set token_sha256 = ?, rotated_at = ? where rig = ? and retired_at is null",
      tokenHashHex(tokenSha256),
      new Date().toISOString(),
      rig,
    );
    if (Number(r.changes) === 0) throw new Error(`rig ${rig} is not enrolled`);
    await this.store.auditLog.add(by, "rig_token_rotated", { rig });
  }

  /** Retires an enrolled rig: its token stops working. Its history stays. */
  async retire(rig: string, by: string): Promise<void> {
    const r = await this.q.run(
      "update rig_token set retired_at = ? where rig = ? and retired_at is null",
      new Date().toISOString(),
      rig,
    );
    if (Number(r.changes) === 0) throw new Error(`rig ${rig} is not enrolled`);
    await this.store.auditLog.add(by, "rig_retired", { rig });
  }
}

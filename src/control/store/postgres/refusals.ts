import type { RigRefusal, RigRefusals } from "../refusals.ts";
import { PgPart, type Row } from "./part.ts";

/** RigRefusals on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigRefusals extends PgPart implements RigRefusals {
  /**
   * Why control refuses the rig now, and since when; how many of its calls control refused since,
   * and when the last one came. Undefined when it does not refuse it.
   */
  async get(rig: string): Promise<RigRefusal | undefined> {
    const r = (await this.q.get(
      "select reason, since, calls, last_at from rig_refusal where rig = ?",
      rig,
    )) as Row | undefined;
    return r
      ? {
          reason: String(r.reason),
          since: String(r.since),
          calls: Number(r.calls ?? 0),
          last_at: r.last_at === null || r.last_at === undefined ? null : String(r.last_at),
        }
      : undefined;
  }

  /** One more of a refused rig's calls, refused: counted, with its time. */
  async countCall(rig: string): Promise<void> {
    await this.q.run(
      "update rig_refusal set calls = calls + 1, last_at = ? where rig = ?",
      new Date().toISOString(),
      rig,
    );
  }

  /** The rigs control refuses now. */
  async rigs(): Promise<string[]> {
    return ((await this.q.all("select rig from rig_refusal order by rig")) as Row[]).map((r) =>
      String(r.rig),
    );
  }

  /**
   * Refuses the rig for this reason, or (null) ends its refusal. Each new refusal and each end
   * goes to the audit log once, not on every call the rig makes. A refused rig that never sent a
   * report is listed (with no report: offline), so the owner sees why.
   */
  async set(
    rig: string,
    reason: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const was = await this.get(rig);
    if (reason === null) {
      if (!was) return;
      await this.q.run("delete from rig_refusal where rig = ?", rig);
      await this.store.auditLog.add(`rig:${rig}`, "rig_refusal_ended", {
        was: was.reason,
        ...detail,
      });
      return;
    }
    if (was?.reason === reason) return;
    const now = new Date().toISOString();
    await this.tx(async () => {
      await this.q.run(
        `insert into rig_refusal (rig, reason, since) values (?, ?, ?)
           on conflict (rig) do update set reason = excluded.reason, since = excluded.since,
             calls = 0, last_at = null`,
        rig,
        reason,
        now,
      );
      await this.store.reportedRigs.addUnreported(rig, now);
      await this.store.auditLog.add(`rig:${rig}`, "rig_refused", { reason, ...detail });
    });
  }
}

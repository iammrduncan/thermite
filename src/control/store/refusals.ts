import { type Row, StorePart } from "./part.ts";

/**
 * The rigs control refuses (goal 125, T6), why, since when, and how many of their calls it
 * refused since.
 */

/** Why control refuses a rig, since when, and how many of its calls it refused since. */
export interface RigRefusal {
  reason: string;
  since: string;
  /** The rig's calls control refused since the refusal began. */
  calls: number;
  /** When the last of them came; null: none since. */
  last_at: string | null;
}

export class RigRefusals extends StorePart {
  /**
   * Why control refuses the rig now, and since when; how many of its calls control refused since,
   * and when the last one came. Undefined when it does not refuse it.
   */
  get(rig: string): RigRefusal | undefined {
    const r = this.db
      .prepare("select reason, since, calls, last_at from rig_refusal where rig = ?")
      .get(rig) as Row | undefined;
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
  countCall(rig: string): void {
    this.db
      .prepare("update rig_refusal set calls = calls + 1, last_at = ? where rig = ?")
      .run(new Date().toISOString(), rig);
  }

  /** The rigs control refuses now. */
  rigs(): string[] {
    return (this.db.prepare("select rig from rig_refusal order by rig").all() as Row[]).map((r) =>
      String(r.rig),
    );
  }

  /**
   * Refuses the rig for this reason, or (null) ends its refusal. Each new refusal and each end
   * goes to the audit log once, not on every call the rig makes. A refused rig that never sent a
   * report is listed (with no report: offline), so the owner sees why.
   */
  set(rig: string, reason: string | null, detail: Record<string, unknown> = {}): void {
    const was = this.get(rig);
    if (reason === null) {
      if (!was) return;
      this.db.prepare("delete from rig_refusal where rig = ?").run(rig);
      this.store.auditLog.add(`rig:${rig}`, "rig_refusal_ended", { was: was.reason, ...detail });
      return;
    }
    if (was?.reason === reason) return;
    const now = new Date().toISOString();
    this.tx(() => {
      this.db
        .prepare("insert or replace into rig_refusal (rig, reason, since) values (?, ?, ?)")
        .run(rig, reason, now);
      this.store.reportedRigs.addUnreported(rig, now);
      this.store.auditLog.add(`rig:${rig}`, "rig_refused", { reason, ...detail });
    });
  }
}

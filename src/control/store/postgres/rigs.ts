import { canonicalJson } from "../../../core/canonical.ts";
import { fingerprint } from "../../../core/commands.ts";
import type { IngestReport } from "../report.ts";
import type { ReportedRigs } from "../rigs.ts";
import { PgPart, type Row } from "./part.ts";

/** ReportedRigs on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresReportedRigs extends PgPart implements ReportedRigs {
  /**
   * The supervisor's own figures for a rig (unsigned: it reports them about itself). They never
   * make a rig look live: only the harness's signed reports move last_seen.
   */
  async setSupervisor(rig: string, stats: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.q.run(
      `insert into rig (id, first_seen, last_seen, supervisor, supervisor_at) values (?, ?, ?, ?, ?)
         on conflict (id) do update set supervisor = excluded.supervisor, supervisor_at = excluded.supervisor_at`,
      rig,
      now,
      new Date(0).toISOString(),
      canonicalJson(stats ?? {}),
      now,
    );
  }

  /**
   * Whether a signed report may be taken: not from a ledger the rig has left, starting no later
   * than the events control holds of its ledger (no gap: its held cursor, which the apply of the
   * events stream moves), and, in the rig's current ledger, no older than the newest report taken.
   * A ledger control holds no event of (a full reset's new one) starts at 0.
   */
  async reportCheck(
    rig: string,
    r: { ledgerId: string; cursor: number; generatedAt: string },
  ): Promise<{ ok: true } | { ok: false; reason: string; expectedCursor?: number }> {
    const left = await this.q.get(
      "select 1 from rig_ledger where rig = ? and ledger_id = ? and superseded_at is not null",
      rig,
      r.ledgerId,
    );
    if (left) return { ok: false, reason: "a report from a ledger the rig has left" };
    const u = (await this.q.get("select ledger_id, report_at from rig where id = ?", rig)) as
      | Row
      | undefined;
    const current = u?.ledger_id !== undefined && String(u.ledger_id) === r.ledgerId;
    const held = await this.takenThrough(rig, r.ledgerId);
    if (r.cursor > held) {
      const reason =
        held === 0 && !current ? "a new ledger's events start at 0" : "a gap in the event stream";
      return { ok: false, reason, expectedCursor: held };
    }
    if (current && u?.report_at && r.generatedAt < String(u.report_at)) {
      return { ok: false, reason: "a report older than the newest one taken" };
    }
    return { ok: true };
  }

  async supervisor(rig: string): Promise<Record<string, unknown> | null> {
    const r = (await this.q.get("select supervisor, supervisor_at from rig where id = ?", rig)) as
      | Row
      | undefined;
    return r?.supervisor
      ? { ...(JSON.parse(String(r.supervisor)) as object), received_at: String(r.supervisor_at) }
      : null;
  }

  /** The rig's pinned report-signing key, if any. */
  async key(rig: string): Promise<{ pubkey: string | null; pending: string | null }> {
    const r = (await this.q.get("select pubkey, pending_pubkey from rig where id = ?", rig)) as
      | Row
      | undefined;
    return {
      pubkey: r?.pubkey ? String(r.pubkey) : null,
      pending: r?.pending_pubkey ? String(r.pending_pubkey) : null,
    };
  }

  /** Pins a rig's key on first contact (trust on first use, shown on the dashboard). */
  async pinKey(rig: string, pubkey: string): Promise<void> {
    const now = new Date().toISOString();
    await this.q.run(
      `insert into rig (id, first_seen, last_seen, pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pubkey = excluded.pubkey, pending_pubkey = null`,
      rig,
      now,
      now,
      pubkey,
    );
    await this.store.auditLog.add(`rig:${rig}`, "rig_key_pinned", {
      fingerprint: fingerprint(pubkey),
    });
  }

  /** A different key arrived: hold it until the owner accepts it. */
  async holdKey(rig: string, pubkey: string): Promise<void> {
    // A first key held for the owner has no rig row yet; the row does not make the rig live.
    await this.q.run(
      `insert into rig (id, first_seen, last_seen, pending_pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pending_pubkey = excluded.pending_pubkey`,
      rig,
      new Date().toISOString(),
      new Date(0).toISOString(),
      pubkey,
    );
    await this.store.auditLog.add(`rig:${rig}`, "rig_key_changed", {
      fingerprint: fingerprint(pubkey),
    });
  }

  /** Accepts the held key, but only the one with the fingerprint the owner checked. */
  async acceptPendingKey(rig: string, actor: string, fingerprintSeen: string): Promise<boolean> {
    const { pending } = await this.key(rig);
    if (!pending || fingerprint(pending) !== fingerprintSeen) return false;
    await this.q.run(
      "update rig set pubkey = pending_pubkey, pending_pubkey = null where id = ?",
      rig,
    );
    await this.store.auditLog.add(actor, "rig_key_accepted", {
      rig,
      fingerprint: fingerprint(pending),
    });
    return true;
  }

  /** Whether a rig reported and is not retired: one list() names. */
  async listed(rig: string): Promise<boolean> {
    return Boolean(
      await this.q.get(
        "select 1 from rig where id = ? and id not in (select rig from rig_retired)",
        rig,
      ),
    );
  }

  /**
   * The rigs that reported, but not the retired ones unless asked for. `last_cursor` is the cursor
   * after the last event control holds of the rig's current ledger: its held cursor.
   */
  async list(opts: { withRetired?: boolean } = {}): Promise<
    {
      id: string;
      last_seen: string;
      last_cursor: number;
      ledger_id: string | null;
      summary: unknown;
    }[]
  > {
    return (
      (await this.q.all(
        `select r.id, r.last_seen, r.ledger_id, r.summary, coalesce(l.through_event, 0) as held
           from rig r left join rig_ledger l on l.rig = r.id and l.ledger_id = r.ledger_id
           where ? or r.id not in (select rig from rig_retired) order by r.id`,
        opts.withRetired ? 1 : 0,
      )) as Row[]
    ).map((r) => ({
      id: String(r.id),
      last_seen: String(r.last_seen),
      last_cursor: Number(r.held),
      ledger_id: r.ledger_id === null ? null : String(r.ledger_id),
      summary: JSON.parse(String(r.summary)),
    }));
  }

  /**
   * A mark that changes whenever a rig reported or control took a new event of it: each rig's last
   * report and held cursor, in one string. The dashboard's stream of changes compares it
   * (api/web.ts); it reads no report's summary, so it is cheap to ask often.
   */
  async mark(): Promise<string> {
    return (
      (await this.q.all(`select r.id, r.last_seen, r.ledger_id, coalesce(l.through_event, 0) as held
           from rig r left join rig_ledger l on l.rig = r.id and l.ledger_id = r.ledger_id
           order by r.id`)) as Row[]
    )
      .map((r) => `${r.id}\t${r.last_seen}\t${r.ledger_id ?? ""}\t${r.held}`)
      .join("\n");
  }

  /**
   * The ledger a report comes from becomes the rig's current one, before its events go on the
   * events stream: a ledger new to the rig (a full reset's) supersedes the ones before it, for
   * good, as the report's signature proves the harness moved on. A rig with no row gets one, not
   * seen yet: noteReport says it was, once the report is taken.
   */
  async enterLedger(rig: string, ledgerId: string, now: string): Promise<void> {
    await this.q.run(
      `insert into rig (id, first_seen, last_seen, ledger_id) values (?, ?, ?, ?)
         on conflict (id) do update set ledger_id = excluded.ledger_id`,
      rig,
      now,
      new Date(0).toISOString(),
      ledgerId,
    );
    await this.q.run(
      "update rig_ledger set superseded_at = ? where rig = ? and ledger_id != ? and superseded_at is null",
      now,
      rig,
      ledgerId,
    );
    await this.q.run(
      "insert into rig_ledger (rig, ledger_id, first_seen) values (?, ?, ?) on conflict do nothing",
      rig,
      ledgerId,
      now,
    );
  }

  /**
   * A report taken, once the apply of the events stream has its events: the rig was seen now, with
   * this summary, at the report's time.
   */
  async noteReport(report: IngestReport, now: string): Promise<void> {
    const before = (await this.q.get("select summary from rig where id = ?", report.rig)) as
      | Row
      | undefined;
    await this.q.run(
      `insert into rig (id, first_seen, last_seen, ledger_id, summary, report_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict (id) do update set last_seen = excluded.last_seen,
           summary = excluded.summary, report_at = excluded.report_at`,
      report.rig,
      now,
      now,
      report.ledger_id,
      canonicalJson(report.summary ?? {}),
      report.generated_at ?? now,
    );
    await this.noteRunners(
      report.rig,
      before ? JSON.parse(String(before.summary)) : undefined,
      report.summary,
    );
    await this.store.runnerUse.note(report.rig, report.summary, now);
  }

  /**
   * The rig's history lines for its runners (goal 206), from two reports in a row: a runner
   * process that answers its core for the first time, one that stopped answering, and one that
   * answers again.
   */
  private async noteRunners(rig: string, was: unknown, now: unknown): Promise<void> {
    type P = { name?: unknown; up?: unknown; why?: unknown; away_since?: unknown };
    const processes = (s: unknown): P[] => {
      const r = (s as { runners?: { processes?: unknown } } | undefined)?.runners?.processes;
      return Array.isArray(r) ? (r as P[]) : [];
    };
    const old = new Map(processes(was).map((p) => [String(p.name), p]));
    for (const p of processes(now)) {
      const name = String(p.name);
      const o = old.get(name);
      if (p.up === true && o?.up !== true)
        await this.store.rigHistory.add(
          rig,
          o?.away_since ? "runner_back" : "runner_answers",
          true,
          name,
        );
      else if (p.up !== true && o?.up === true && p.away_since)
        await this.store.rigHistory.add(
          rig,
          "runner_away",
          false,
          `${name}: ${typeof p.why === "string" ? p.why : "it stopped answering"}`,
        );
    }
  }

  /**
   * A rig ledger's held cursor: the last event of it whose records control's store holds, as the
   * apply of the events stream moved it (control/events); 0 before any.
   */
  async heldCursor(rig: string, ledgerId: string): Promise<number> {
    const r = (await this.q.get(
      "select through_event from rig_ledger where rig = ? and ledger_id = ?",
      rig,
      ledgerId,
    )) as { through_event: number } | undefined;
    return Number(r?.through_event ?? 0);
  }

  /**
   * Where a rig's report of a ledger goes on from: its held cursor, or its floor when higher, the
   * last event a retention policy removed of control's copy on purpose (store/retention.ts), so
   * control never asks the rig for those again, nor takes them back. The apply reads the held
   * cursor alone: it applies every event the stream still holds.
   */
  async takenThrough(rig: string, ledgerId: string): Promise<number> {
    return Math.max(
      await this.heldCursor(rig, ledgerId),
      await this.store.retention.floor(rig, ledgerId),
    );
  }

  /**
   * The apply alone moves a ledger's held cursor, to the last event of it that it applied, never
   * back. A ledger the store has no row for yet, as in a store older than the stream, gets one.
   */
  async holdThrough(rig: string, ledgerId: string, eventId: number, now: string): Promise<void> {
    await this.q.run(
      `insert into rig_ledger (rig, ledger_id, first_seen, through_event) values (?, ?, ?, ?)
         on conflict (rig, ledger_id) do update
           set through_event = greatest(rig_ledger.through_event, excluded.through_event)`,
      rig,
      ledgerId,
      now,
      eventId,
    );
  }

  /** A row for a rig that never reported, so it is listed (with no report: offline). */
  async addUnreported(rig: string, now: string): Promise<void> {
    await this.q.run(
      "insert into rig (id, first_seen, last_seen) values (?, ?, ?) on conflict do nothing",
      rig,
      now,
      new Date(0).toISOString(),
    );
  }

  /**
   * The rig's row as reports move it: its current ledger, the cursor after the last event control
   * holds of it (its held cursor), and its newest report's time.
   */
  async reportRow(
    rig: string,
  ): Promise<{ ledger_id: string | null; cursor: number; report_at: string | null } | undefined> {
    const r = (await this.q.get("select ledger_id, report_at from rig where id = ?", rig)) as
      | Row
      | undefined;
    if (!r) return undefined;
    const ledger = r.ledger_id === null ? null : String(r.ledger_id);
    return {
      ledger_id: ledger,
      cursor: ledger === null ? 0 : await this.takenThrough(rig, ledger),
      report_at: r.report_at === null ? null : String(r.report_at),
    };
  }
}

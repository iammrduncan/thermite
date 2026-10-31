import { canonicalJson } from "../../core/canonical.ts";
import { fingerprint } from "../../core/commands.ts";
import { type Row, StorePart } from "./part.ts";
import type { IngestReport } from "./report.ts";

/**
 * The rigs as they report (goal 125, T6): each rig's row, with its current ledger, its report's
 * time and summary, its report-signing keys and its supervisor's own figures; the ledgers it
 * reported from, those it has left, and each one's held cursor.
 */

export class ReportedRigs extends StorePart {
  /**
   * The supervisor's own figures for a rig (unsigned: it reports them about itself). They never
   * make a rig look live: only the harness's signed reports move last_seen.
   */
  setSupervisor(rig: string, stats: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, supervisor, supervisor_at) values (?, ?, ?, ?, ?)
         on conflict (id) do update set supervisor = excluded.supervisor, supervisor_at = excluded.supervisor_at`,
      )
      .run(rig, now, new Date(0).toISOString(), canonicalJson(stats ?? {}), now);
  }

  /**
   * Whether a signed report may be taken: not from a ledger the rig has left, starting no later
   * than the events control holds of its ledger (no gap: its held cursor, which the apply of the
   * events stream moves), and, in the rig's current ledger, no older than the newest report taken.
   * A ledger control holds no event of (a full reset's new one) starts at 0.
   */
  reportCheck(
    rig: string,
    r: { ledgerId: string; cursor: number; generatedAt: string },
  ): { ok: true } | { ok: false; reason: string; expectedCursor?: number } {
    const left = this.db
      .prepare(
        "select 1 from rig_ledger where rig = ? and ledger_id = ? and superseded_at is not null",
      )
      .get(rig, r.ledgerId);
    if (left) return { ok: false, reason: "a report from a ledger the rig has left" };
    const u = this.db.prepare("select ledger_id, report_at from rig where id = ?").get(rig) as
      | Row
      | undefined;
    const current = u?.ledger_id !== undefined && String(u.ledger_id) === r.ledgerId;
    const held = this.heldCursor(rig, r.ledgerId);
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

  supervisor(rig: string): Record<string, unknown> | null {
    const r = this.db.prepare("select supervisor, supervisor_at from rig where id = ?").get(rig) as
      | Row
      | undefined;
    return r?.supervisor
      ? { ...(JSON.parse(String(r.supervisor)) as object), received_at: String(r.supervisor_at) }
      : null;
  }

  /** The rig's pinned report-signing key, if any. */
  key(rig: string): { pubkey: string | null; pending: string | null } {
    const r = this.db.prepare("select pubkey, pending_pubkey from rig where id = ?").get(rig) as
      | Row
      | undefined;
    return {
      pubkey: r?.pubkey ? String(r.pubkey) : null,
      pending: r?.pending_pubkey ? String(r.pending_pubkey) : null,
    };
  }

  /** Pins a rig's key on first contact (trust on first use, shown on the dashboard). */
  pinKey(rig: string, pubkey: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pubkey = excluded.pubkey, pending_pubkey = null`,
      )
      .run(rig, now, now, pubkey);
    this.store.auditLog.add(`rig:${rig}`, "rig_key_pinned", { fingerprint: fingerprint(pubkey) });
  }

  /** A different key arrived: hold it until the owner accepts it. */
  holdKey(rig: string, pubkey: string): void {
    // A first key held for the owner has no rig row yet; the row does not make the rig live.
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, pending_pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pending_pubkey = excluded.pending_pubkey`,
      )
      .run(rig, new Date().toISOString(), new Date(0).toISOString(), pubkey);
    this.store.auditLog.add(`rig:${rig}`, "rig_key_changed", { fingerprint: fingerprint(pubkey) });
  }

  /** Accepts the held key, but only the one with the fingerprint the owner checked. */
  acceptPendingKey(rig: string, actor: string, fingerprintSeen: string): boolean {
    const { pending } = this.key(rig);
    if (!pending || fingerprint(pending) !== fingerprintSeen) return false;
    this.db
      .prepare("update rig set pubkey = pending_pubkey, pending_pubkey = null where id = ?")
      .run(rig);
    this.store.auditLog.add(actor, "rig_key_accepted", { rig, fingerprint: fingerprint(pending) });
    return true;
  }

  /**
   * The rigs that reported, but not the retired ones unless asked for. `last_cursor` is the cursor
   * after the last event control holds of the rig's current ledger: its held cursor.
   */
  list(opts: { withRetired?: boolean } = {}): {
    id: string;
    last_seen: string;
    last_cursor: number;
    ledger_id: string | null;
    summary: unknown;
  }[] {
    return (
      this.db
        .prepare(
          `select r.id, r.last_seen, r.ledger_id, r.summary, coalesce(l.through_event, 0) as held
           from rig r left join rig_ledger l on l.rig = r.id and l.ledger_id = r.ledger_id
           where ? or r.id not in (select rig from rig_retired) order by r.id`,
        )
        .all(opts.withRetired ? 1 : 0) as Row[]
    ).map((r) => ({
      id: String(r.id),
      last_seen: String(r.last_seen),
      last_cursor: Number(r.held),
      ledger_id: r.ledger_id === null ? null : String(r.ledger_id),
      summary: JSON.parse(String(r.summary)),
    }));
  }

  /**
   * The ledger a report comes from becomes the rig's current one, before its events go on the
   * events stream: a ledger new to the rig (a full reset's) supersedes the ones before it, for
   * good, as the report's signature proves the harness moved on. A rig with no row gets one, not
   * seen yet: noteReport says it was, once the report is taken.
   */
  enterLedger(rig: string, ledgerId: string, now: string): void {
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, ledger_id) values (?, ?, ?, ?)
         on conflict (id) do update set ledger_id = excluded.ledger_id`,
      )
      .run(rig, now, new Date(0).toISOString(), ledgerId);
    this.db
      .prepare(
        "update rig_ledger set superseded_at = ? where rig = ? and ledger_id != ? and superseded_at is null",
      )
      .run(now, rig, ledgerId);
    this.db
      .prepare("insert or ignore into rig_ledger (rig, ledger_id, first_seen) values (?, ?, ?)")
      .run(rig, ledgerId, now);
  }

  /**
   * A report taken, once the apply of the events stream has its events: the rig was seen now, with
   * this summary, at the report's time.
   */
  noteReport(report: IngestReport, now: string): void {
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, ledger_id, summary, report_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict (id) do update set last_seen = excluded.last_seen,
           summary = excluded.summary, report_at = excluded.report_at`,
      )
      .run(
        report.rig,
        now,
        now,
        report.ledger_id,
        canonicalJson(report.summary ?? {}),
        report.generated_at ?? now,
      );
  }

  /**
   * A rig ledger's held cursor: the last event of it whose records control's store holds, as the
   * apply of the events stream moved it (control/events); 0 before any.
   */
  heldCursor(rig: string, ledgerId: string): number {
    const r = this.db
      .prepare("select through_event from rig_ledger where rig = ? and ledger_id = ?")
      .get(rig, ledgerId) as { through_event: number } | undefined;
    return Number(r?.through_event ?? 0);
  }

  /**
   * The apply alone moves a ledger's held cursor, to the last event of it that it applied, never
   * back. A ledger the store has no row for yet, as in a store older than the stream, gets one.
   */
  holdThrough(rig: string, ledgerId: string, eventId: number, now: string): void {
    this.db
      .prepare(
        `insert into rig_ledger (rig, ledger_id, first_seen, through_event) values (?, ?, ?, ?)
         on conflict (rig, ledger_id) do update
           set through_event = max(rig_ledger.through_event, excluded.through_event)`,
      )
      .run(rig, ledgerId, now, eventId);
  }

  /** A row for a rig that never reported, so it is listed (with no report: offline). */
  addUnreported(rig: string, now: string): void {
    this.db
      .prepare("insert or ignore into rig (id, first_seen, last_seen) values (?, ?, ?)")
      .run(rig, now, new Date(0).toISOString());
  }

  /**
   * The rig's row as reports move it: its current ledger, the cursor after the last event control
   * holds of it (its held cursor), and its newest report's time.
   */
  reportRow(
    rig: string,
  ): { ledger_id: string | null; cursor: number; report_at: string | null } | undefined {
    const r = this.db.prepare("select ledger_id, report_at from rig where id = ?").get(rig) as
      | Row
      | undefined;
    if (!r) return undefined;
    const ledger = r.ledger_id === null ? null : String(r.ledger_id);
    return {
      ledger_id: ledger,
      cursor: ledger === null ? 0 : this.heldCursor(rig, ledger),
      report_at: r.report_at === null ? null : String(r.report_at),
    };
  }
}

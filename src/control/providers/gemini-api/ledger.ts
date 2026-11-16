import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ControlStore } from "../../store/index.ts";

/**
 * The Gemini API's spend ledger: one for the whole control, whatever the providers, keys and
 * agents, kept in control's store so that it survives a restart, a removed key, a deleted
 * provider and one added again under any name. Money is whole micro-dollars. A month is a
 * calendar month in UTC.
 *
 * A call first reserves its worst case; the reservation is refused when it would take the month
 * past the cap. When the call ends, the reservation is settled to what the call cost. A
 * reservation is never dropped: one left open by a control that stopped is charged in full at the
 * next start, and one still open when the month turns stays reserved in the new month and is
 * charged there.
 *
 * Every change is one transaction of the store, read and written with no await between, so two
 * calls can never both take the last of the cap.
 */

/** The setting the ledger is kept under (the store's control_setting table). */
const LEDGER_KEY = "gemini_api_ledger";

/**
 * Calls that may be open at once, which bounds the ledger's size; one more is refused as busy,
 * which the bridge answers as a rate limit, so its agent waits and tries again.
 */
export const GEMINI_OPEN_CALLS = 64;

/** Closed months kept for the page. */
const MONTHS_KEPT = 24;

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const monthName = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);

const OpenCall = z.strictObject({
  id: z.string().uuid(),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  micros: money,
  at: z.iso.datetime(),
  /** The control process that made it: another's is one a stopped control left open. */
  boot: z.string().uuid(),
});

const Totals = {
  /** Charged this month, in all and by provider name. */
  spent: money,
  by: z.record(z.string().max(64), money),
  /** Calls settled, and those of them charged their full reservation because their cost was not known. */
  calls: count,
  uncertain: count,
};

const ClosedMonth = z.strictObject({
  month: monthName,
  ...Totals,
  /** Reserved by calls still open when the month ended: carried into the next month. */
  carried: money,
});

const LedgerState = z.strictObject({
  v: z.literal(1),
  month: monthName,
  ...Totals,
  open: z.array(OpenCall).max(GEMINI_OPEN_CALLS * 4),
  closed: z.array(ClosedMonth).max(MONTHS_KEPT),
});
type LedgerState = z.infer<typeof LedgerState>;

/** The ledger as the page and the cap read it. */
export interface GeminiLedgerView {
  month: string;
  spent: number;
  /** The open calls' reservations. */
  reserved: number;
  open: number;
  by: { provider: string; spent: number }[];
  calls: number;
  uncertain: number;
  closed: z.infer<typeof ClosedMonth>[];
}

/**
 * Why a reservation was refused. `cap`: the month's charges leave no room for the call. `busy`:
 * the call fits beside the charges, but not while the open calls hold their reservations, or
 * GEMINI_OPEN_CALLS are open: it may fit when they settle. `unreadable`: the ledger can't be read.
 */
type GeminiRefusal = "cap" | "busy" | "unreadable";

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

export class GeminiLedger {
  private readonly store: ControlStore;
  private readonly now: () => Date;
  private readonly boot = randomUUID();

  /**
   * Opens the ledger and charges, in full, every reservation another control process left open:
   * what those calls cost is not known, so nothing of them is given back.
   */
  constructor(store: ControlStore, now: () => Date) {
    this.store = store;
    this.now = now;
    this.store.tx(() => {
      const s = this.load();
      const left = s?.open.filter((o) => o.boot !== this.boot) ?? [];
      if (!s || !left.length) return;
      for (const o of left) this.charge(s, o.provider, o.micros, false);
      s.open = s.open.filter((o) => o.boot === this.boot);
      this.save(s);
      this.store.auditLog.add("control", "gemini_api_reservations_kept", {
        calls: left.length,
        micro_usd: left.reduce((n, o) => n + o.micros, 0),
        why: "control stopped while they were open",
      });
    });
  }

  /**
   * The ledger at this moment, its month turned if the clock's has: undefined when what the
   * store holds can't be read, which refuses every call until it is repaired. A clock that went
   * back turns nothing.
   */
  private load(): LedgerState | undefined {
    const row = this.store.ownSettings.get(LEDGER_KEY);
    const month = monthOf(this.now());
    if (!row)
      return { v: 1, month, spent: 0, by: {}, calls: 0, uncertain: 0, open: [], closed: [] };
    let s: LedgerState;
    try {
      s = LedgerState.parse(JSON.parse(row.value));
    } catch {
      return undefined;
    }
    if (month > s.month) {
      const carried = s.open.reduce((n, o) => n + o.micros, 0);
      const { month: was, spent, by, calls, uncertain } = s;
      s.closed = [{ month: was, spent, by, calls, uncertain, carried }, ...s.closed].slice(
        0,
        MONTHS_KEPT,
      );
      Object.assign(s, { month, spent: 0, by: {}, calls: 0, uncertain: 0 });
      this.save(s);
    }
    return s;
  }

  private save(s: LedgerState): void {
    this.store.ownSettings.set(LEDGER_KEY, JSON.stringify(s), "control");
  }

  private charge(s: LedgerState, provider: string, micros: number, certain: boolean): void {
    s.spent += micros;
    // An own entry only: a provider may be named as a property every object inherits.
    s.by[provider] = (Object.hasOwn(s.by, provider) ? (s.by[provider] ?? 0) : 0) + micros;
    s.calls += 1;
    if (!certain) s.uncertain += 1;
  }

  /**
   * Reserves `micros` for a call under `cap`, or says why not. The month's charges, the open
   * reservations and this one must together stay at or under the cap. A call the charges alone
   * leave no room for is refused for the cap; one that only the open reservations leave no room
   * for is refused as busy, since those may settle under what they hold.
   */
  reserve(
    call: { provider: string; model: string; micros: number },
    cap: number,
  ): { ok: true; id: string } | { ok: false; why: GeminiRefusal } {
    return this.store.tx(() => {
      const s = this.load();
      if (!s || !Number.isSafeInteger(call.micros) || call.micros < 0)
        return { ok: false, why: "unreadable" } as const;
      if (s.spent + call.micros > cap) return { ok: false, why: "cap" } as const;
      const reserved = s.open.reduce((n, o) => n + o.micros, 0);
      if (s.open.length >= GEMINI_OPEN_CALLS || s.spent + reserved + call.micros > cap)
        return { ok: false, why: "busy" } as const;
      const id = randomUUID();
      s.open.push({ ...call, id, at: this.now().toISOString(), boot: this.boot });
      this.save(s);
      return { ok: true, id } as const;
    });
  }

  /**
   * Ends a reservation: with `micros`, what the call is known to have cost (0 for a call Google
   * answered with an error, or that never left); with none, its full reservation, as its cost is
   * not known. Ending one twice changes nothing.
   */
  settle(id: string, micros?: number | undefined): void {
    this.store.tx(() => {
      const s = this.load();
      const o = s?.open.find((x) => x.id === id);
      if (!s || !o) return;
      s.open = s.open.filter((x) => x.id !== id);
      this.charge(s, o.provider, micros ?? o.micros, micros !== undefined);
      this.save(s);
    });
  }

  /** The ledger now; undefined when it can't be read. */
  view(): GeminiLedgerView | undefined {
    const s = this.store.tx(() => this.load());
    if (!s) return undefined;
    return {
      month: s.month,
      spent: s.spent,
      reserved: s.open.reduce((n, o) => n + o.micros, 0),
      open: s.open.length,
      by: Object.entries(s.by)
        .map(([provider, spent]) => ({ provider, spent }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
      calls: s.calls,
      uncertain: s.uncertain,
      closed: s.closed,
    };
  }
}

/**
 * How each runner of a rig's other machines spent its time (goal 231): held by the judge's job,
 * by each lane's run, free, or away. Running totals since the runner joined the core, in ms; a
 * restart of the core, or a runner that leaves and joins again, starts them again, and control
 * keeps their history from the rig's reports. And who waited for a runner, and how long.
 */

/** A runner's state, for its clock: whether it answers, and who holds it. */
interface ClockState {
  up: boolean;
  holder: string | undefined;
}

/** A runner's totals, as the rig reports them. */
export interface RunnerTime {
  /** When its totals began: it joined the core then. */
  since: string;
  judge_ms: number;
  /** By lane, such as `lane-2`. */
  lanes_ms: Record<string, number>;
  free_ms: number;
  away_ms: number;
}

/** Whose a holder or a waiter is: `judge` for the judge's executors, else its lane. */
export function whose(who: string): string {
  return who.startsWith("executor-") ? "judge" : who;
}

/** A runner's totals by what it did, in ms. */
interface Spent {
  judge: number;
  lanes: Record<string, number>;
  free: number;
  away: number;
}

export class RunnerClock {
  private readonly since: number;
  private mark: number;
  private readonly spent: Spent = { judge: 0, lanes: {}, free: 0, away: 0 };

  constructor(now = Date.now()) {
    this.since = now;
    this.mark = now;
  }

  /** The time since the last change goes to what the runner did then; call it before a change. */
  tally(was: ClockState, now = Date.now()): void {
    add(this.spent, was, Math.max(0, now - this.mark));
    this.mark = now;
  }

  /** Its totals now, the time since its last change counted as what it does now. */
  totals(now: ClockState, at = Date.now()): RunnerTime {
    const t: Spent = { ...this.spent, lanes: { ...this.spent.lanes } };
    add(t, now, Math.max(0, at - this.mark));
    return {
      since: new Date(this.since).toISOString(),
      judge_ms: t.judge,
      lanes_ms: t.lanes,
      free_ms: t.free,
      away_ms: t.away,
    };
  }
}

function add(t: Spent, s: ClockState, ms: number): void {
  if (!s.up) t.away += ms;
  else if (!s.holder) t.free += ms;
  else if (whose(s.holder) === "judge") t.judge += ms;
  else t.lanes[s.holder] = (t.lanes[s.holder] ?? 0) + ms;
}

/** Who waited for a runner since the core started: each wait begun, and their time. */
export class WaitTotals {
  private readonly ended = new Map<string, { count: number; ms: number }>();

  /** A wait ended: a runner was free, its run ended first, or no runner may serve it now. */
  end(who: string, since: number, now = Date.now()): void {
    const k = whose(who);
    const t = this.ended.get(k) ?? { count: 0, ms: 0 };
    this.ended.set(k, { count: t.count + 1, ms: t.ms + Math.max(0, now - since) });
  }

  /** By whose: the judge's or a lane's; the waits still open counted up to now. */
  totals(open: { who: string; since: number }[], now = Date.now()) {
    const out: Record<string, { count: number; ms: number }> = {};
    for (const [k, t] of this.ended) out[k] = { ...t };
    for (const w of open) {
      const k = whose(w.who);
      const t = out[k] ?? { count: 0, ms: 0 };
      out[k] = { count: t.count + 1, ms: t.ms + Math.max(0, now - w.since) };
    }
    return out;
  }
}

/** A GPU's use as one read gives it. */
export interface GpuRead {
  util_pct: number;
  mem_used_mib: number | null;
  mem_total_mib: number | null;
}

/** A runner's GPU use, as the rig reports it: the newest read, and the totals of all of them. */
export interface GpuTime extends GpuRead {
  /** When it was read. */
  at: string;
  /** The time between reads, weighted by the GPU's use: busy_ms / read_ms is its mean use. */
  busy_ms: number;
  read_ms: number;
}

/**
 * A runner's GPU use from its core's checks (goal 231): the time between two reads counts at the
 * mean of their use, and a gap longer than `gapMs` (the judge measured there and the GPU was not
 * read, or the runner was away) counts for nothing.
 */
export class GpuClock {
  private readonly gapMs: number;
  private last: (GpuRead & { at: number }) | undefined;
  private busy = 0;
  private read = 0;

  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }

  saw(use: GpuRead, now = Date.now()): void {
    const dt = this.last ? now - this.last.at : Number.POSITIVE_INFINITY;
    if (this.last && dt >= 0 && dt <= this.gapMs) {
      this.busy += ((this.last.util_pct + use.util_pct) / 200) * dt;
      this.read += dt;
    }
    this.last = { ...use, at: now };
  }

  totals(): GpuTime | undefined {
    if (!this.last) return undefined;
    const { at, ...use } = this.last;
    return {
      ...use,
      at: new Date(at).toISOString(),
      busy_ms: Math.round(this.busy),
      read_ms: this.read,
    };
  }
}

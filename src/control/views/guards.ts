import { championsInForce } from "./facts.ts";
import { type MetricValues, mean, metricValuesOf } from "./metric-values.ts";
import type { RunView } from "./types.ts";

/**
 * A hill climb's guards beside its main metric (goal 184). The judge's verdict event carries each
 * guard's measured values and its change; a run's page shows how each guard moved from champion to
 * champion against the starting point and the contract's limit, and each attempt's guards beside
 * its gain.
 */

/** One guard of a verdict, as the event carries it, each field checked. */
export interface GuardView {
  metric: string;
  /** ok: within the step's margin; violated: beyond it; unsure: neither yet. */
  status: "ok" | "violated" | "unsure" | null;
  /** Its change against the champion it was measured with, in its direction: positive is better. */
  change: number | null;
  values: MetricValues | null;
  /** At confirmation, its change against the starting point, and whether that spent its allowance. */
  vs_start: { change: number | null; spent: boolean } | null;
}

/** A verdict event's `guards`; empty when it has none (an older harness, a crash, no guards). */
export function guardsOf(raw: unknown): GuardView[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return (Array.isArray(raw) ? raw : []).slice(0, 50).flatMap((x) => {
    const g = (x ?? {}) as Record<string, unknown>;
    if (typeof g.metric !== "string") return [];
    const s = g.vs_start as Record<string, unknown> | null | undefined;
    return [
      {
        metric: g.metric.slice(0, 200),
        status:
          g.status === "ok" || g.status === "violated" || g.status === "unsure" ? g.status : null,
        change: num(g.change),
        values: metricValuesOf(g.values),
        vs_start: s ? { change: num(s.change), spent: s.spent === true } : null,
      },
    ];
  });
}

/** A guard's value on the candidate's side: one case's, or the cases' geometric mean. */
const guardValue = (g: GuardView): number | null =>
  g.values ? mean(g.values.cells.map((c) => c.candidate)) : null;

/** A guard's change as measured: the candidate's value against the reference's, as a fraction. */
export function guardMeasured(g: GuardView): number | null {
  if (!g.values) return null;
  const ref = mean(g.values.cells.map((c) => c.reference));
  return ref > 0 ? mean(g.values.cells.map((c) => c.candidate)) / ref - 1 : null;
}

/** One guard of a run across its champions. */
export interface ChampionGuard {
  metric: string;
  direction: "max" | "min";
  unit: string | null;
  /** The contract's total allowance against the starting point, as a fraction. */
  allowed: number;
  /** The starting point's value, from the run's baseline, and the limit no champion may pass. */
  start: number | null;
  limit: number | null;
  /**
   * Each champion since the starting point, oldest first: its value, null when not known, and
   * whether it is an estimate (from the judge's change, not its measured values).
   */
  points: { seq: number; value: number | null; estimated: boolean }[];
}

/** A value `change` better than `from` in the guard's direction (a fraction, positive is better). */
const moved = (from: number, change: number, direction: "max" | "min") =>
  direction === "max" ? from * (1 + change) : from / (1 + change);

/**
 * Each guard the run's baseline names, with the starting point's value, the limit the contract
 * sets against it (`max_total_regression`), and each champion's value since: the starting point's
 * own, then each later champion's from its confirming verdict's measured values. A champion judged
 * before verdicts carried values is estimated from its change against the starting point, or
 * else from its change against the champion before; with neither, it has none. Empty for a run
 * without a baseline.
 */
export function championGuards(
  r: Pick<RunView, "baseline" | "champion" | "attempts">,
): ChampionGuard[] {
  const b = r.baseline;
  if (!b) return [];
  const steps = championsInForce(r).filter((c) => c.seq >= b.champion_seq);
  return b.guards.map((g) => {
    const direction = g.direction === "min" ? "min" : "max";
    const starts = b.cells.flatMap((c) =>
      c.metrics.filter((m) => m.metric === g.metric && m.median > 0).map((m) => m.median),
    );
    const start = starts.length ? mean(starts) : null;
    const limit =
      start === null
        ? null
        : direction === "max"
          ? start * (1 - g.max_total_regression)
          : start * (1 + g.max_total_regression);
    let before = start;
    const points = steps.map((c) => {
      if (c.seq === b.champion_seq) {
        before = start;
        return { seq: c.seq, value: start, estimated: false };
      }
      const a = c.attempt ? r.attempts.find((x) => x.id === c.attempt) : undefined;
      const v = a?.guards.find((x) => x.metric === g.metric);
      const measured = v ? guardValue(v) : null;
      const vsStart = v?.vs_start?.change;
      const value =
        measured ??
        (typeof vsStart === "number" && start !== null
          ? moved(start, vsStart, direction)
          : typeof v?.change === "number" && before !== null
            ? moved(before, v.change, direction)
            : null);
      before = value;
      return { seq: c.seq, value, estimated: measured === null && value !== null };
    });
    return {
      metric: g.metric,
      direction,
      unit: b.units[g.metric] ?? null,
      allowed: g.max_total_regression,
      start,
      limit,
      points,
    };
  });
}

/**
 * Whether a value is within a quarter of the guard's allowance from its limit: past three
 * quarters of the way from the start to the limit. A page shows it amber.
 */
export function nearLimit(g: ChampionGuard, value: number): boolean {
  if (g.start === null) return false;
  return g.direction === "max"
    ? value < g.start * (1 - 0.75 * g.allowed)
    : value > g.start * (1 + 0.75 * g.allowed);
}

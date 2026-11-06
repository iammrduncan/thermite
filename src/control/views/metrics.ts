import type { GuardRule } from "../../core/metric-roles.ts";
import { championsInForce, currentChampion } from "./facts.ts";
import { type MetricValues, mean } from "./metric-values.ts";
import type { AttemptView, PlanView, RunView } from "./types.ts";

/**
 * A hill climb's metrics on its page (goal 209): each metric of the run's plan with its value at
 * the starting point, at each champion since, and in the newest attempt the judge measured; and
 * each guard's limit at each champion. The values come from the run's baseline and its verdicts:
 * the primary's from each verdict's `values`, a guard metric's from its guard's, the others'
 * from its `metrics`. A run whose baseline came before the plan was recorded reads its plan from
 * the baseline's primary and guards.
 */

/** One metric across the run: the start, each champion, and the newest measured attempt. */
interface Series {
  metric: string;
  unit: string | null;
  start: number | null;
  /** Each champion since the starting point, oldest first; null where its value is not known. */
  points: { seq: number; value: number | null }[];
  /** The newest attempt after the champion that the judge measured on this metric. */
  latest: { attempt: string; value: number } | null;
}

export interface GuardRow extends Series {
  rule: GuardRule;
  /** Its limits at each champion: the bound a change judged against that champion must keep. */
  limits: { seq: number; low: number | null; high: number | null }[];
  /** Within some standard deviations of the start: the start's spread, in log terms. */
  spread: number | null;
}

export interface RunMetrics {
  priorities: (Series & {
    priority: number;
    direction: "max" | "min";
    min_effect: number | null;
  })[];
  guards: GuardRow[];
  info: (Series & { kind: string })[];
}

/** An attempt's measured value of one metric: the mean of its cases, the candidate's side. */
function valueIn(a: AttemptView | undefined, metric: string): number | null {
  if (!a) return null;
  const v: MetricValues | null | undefined =
    a.values?.metric === metric
      ? a.values
      : (a.metrics.find((m) => m.metric === metric) ??
        a.guards.find((g) => g.metric === metric && g.values)?.values);
  return v?.cells.length ? mean(v.cells.map((c) => c.candidate)) : null;
}

/** The run's plan, as recorded with its baseline, or read from the baseline's own fields. */
function planOf(r: Pick<RunView, "baseline">): PlanView | null {
  const b = r.baseline;
  if (!b) return null;
  if (b.plan) return b.plan;
  return {
    priorities: b.primary
      ? [
          {
            metric: b.primary.metric,
            priority: 1,
            direction: b.primary.direction === "min" ? "min" : "max",
            min_effect: null,
          },
        ]
      : [],
    guards: b.guards.map((g) => ({
      metric: g.metric,
      rule: {
        stay: g.direction === "min" ? ("below" as const) : ("above" as const),
        against: "baseline" as const,
        by:
          g.direction === "min"
            ? g.max_total_regression
            : g.max_total_regression / (1 + g.max_total_regression),
      },
      from: "contract",
    })),
    info: [],
  };
}

export function runMetrics(
  r: Pick<RunView, "baseline" | "champion" | "attempts">,
): RunMetrics | null {
  const b = r.baseline;
  const plan = planOf(r);
  if (!b || !plan) return null;
  const steps = championsInForce(r).filter((c) => c.seq >= b.champion_seq);
  const champ = currentChampion(r);
  const attemptOf = (id: string | null) => (id ? r.attempts.find((a) => a.id === id) : undefined);
  const after = r.attempts
    .filter((a) => !champ || a.recorded_at > champ.at)
    .slice()
    .reverse();
  const startOf = (metric: string) => {
    const xs = b.cells.flatMap((c) =>
      c.metrics.filter((m) => m.metric === metric && m.median > 0).map((m) => m.median),
    );
    return xs.length ? mean(xs) : null;
  };
  const series = (metric: string): Series => {
    const start = startOf(metric);
    const latest = after.flatMap((a) => {
      const v = valueIn(a, metric);
      return v === null ? [] : [{ attempt: a.id, value: v }];
    })[0];
    return {
      metric,
      unit: b.units[metric] ?? null,
      start,
      points: steps.map((c) => ({
        seq: c.seq,
        value: c.seq === b.champion_seq ? start : valueIn(attemptOf(c.attempt), metric),
      })),
      latest: latest ?? null,
    };
  };
  // The start's spread of a metric, in log terms: its MAD × 1.4826 against its median, per case.
  const spreadOf = (metric: string) => {
    const xs = b.cells.flatMap((c) =>
      c.metrics
        .filter((m) => m.metric === metric && m.median > 0)
        .map((m) => Math.log1p((1.4826 * Math.abs(m.mad)) / m.median)),
    );
    return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
  };
  const guards = plan.guards.map((g): GuardRow => {
    const s = series(g.metric);
    const by = g.rule.by ?? 0;
    const bound = (ref: number | null) => {
      if (ref === null) return { low: null, high: null };
      if (g.rule.stay === "above") return { low: ref * (1 - by), high: null };
      if (g.rule.stay === "below") return { low: null, high: ref * (1 + by) };
      const sd = g.rule.against === "baseline" ? spreadOf(g.metric) : null;
      return sd === null
        ? { low: null, high: null }
        : { low: ref * Math.exp(-by * sd), high: ref * Math.exp(by * sd) };
    };
    const limits = s.points.map((p, i) => {
      if (g.rule.against === "value") {
        const v = g.rule.value ?? null;
        return {
          seq: p.seq,
          low: g.rule.stay === "above" ? v : null,
          high: g.rule.stay === "below" ? v : null,
        };
      }
      // Against the champion, the bound a change judged against this one keeps; the start's own.
      const ref = g.rule.against === "baseline" ? s.start : (s.points[i]?.value ?? null);
      return { seq: p.seq, ...bound(ref) };
    });
    const spread =
      g.rule.stay === "within" && g.rule.against === "baseline" ? spreadOf(g.metric) : null;
    return { ...s, rule: g.rule, limits, spread };
  });
  return {
    priorities: plan.priorities.map((p) => ({
      ...series(p.metric),
      priority: p.priority,
      direction: p.direction,
      min_effect: p.min_effect,
    })),
    guards,
    info: plan.info.map((i) => ({ ...series(i.metric), kind: i.kind })),
  };
}

/**
 * How much room the newest attempt leaves under a guard, in words: `0.8 GiB to spare` or, for one
 * within some standard deviations of the start, `0.8 sd of 3`; null when it can't be said.
 */
export function roomLeft(g: GuardRow): string | null {
  const v = g.latest?.value;
  const lim = g.limits.at(-1);
  if (v === undefined || !lim) return null;
  const unit = g.unit ? ` ${g.unit}` : "";
  const fig = (x: number) => Number(x.toPrecision(3)).toLocaleString("en-US");
  if (g.rule.stay === "within") {
    if (g.start === null || !g.spread) return null;
    return `${(Math.abs(Math.log(v / g.start)) / g.spread).toFixed(1)} sd of ${g.rule.by}`;
  }
  if (g.rule.stay === "above" && lim.low !== null)
    return v >= lim.low
      ? `${fig(v - lim.low)}${unit} to spare`
      : `${fig(lim.low - v)}${unit} past it`;
  if (g.rule.stay === "below" && lim.high !== null)
    return v <= lim.high
      ? `${fig(lim.high - v)}${unit} to spare`
      : `${fig(v - lim.high)}${unit} past it`;
  return null;
}

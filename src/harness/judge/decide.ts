import type { GoalContract, HillClimbContract } from "../../core/contract.ts";
import { metricPlan, type PlannedGuard, type PlannedPriority } from "../../core/metric-plan.ts";
import { type GuardRule, guardWords, type MetricRole } from "../../core/metric-roles.ts";
import {
  type Interval,
  logImprovement,
  meanInterval,
  toFraction,
  toLog,
} from "../../core/stats.ts";

/**
 * The judge's decision rules. Pure functions over measured blocks: no I/O, no clock, so the
 * same data always gives the same verdict. Effects are log ratios, positive meaning better.
 */

/** One interleaved block: per arm, metric -> cell -> value. */
export interface Block {
  candidate: Record<string, Record<string, number>>;
  reference: Record<string, Record<string, number>>;
}

export type ScreenVerdict =
  | "win_screened"
  | "neutral"
  | "regress"
  | "tradeoff"
  | "infeasible"
  | "inconclusive";

export type ConfirmVerdict = "win_confirmed" | "not_confirmed" | "tradeoff" | "infeasible";

export interface GuardResult {
  metric: string;
  /** A guard of the metric roles (goal 209): its bound, which the contract's own guards lack. */
  rule?: GuardRule | undefined;
  interval: Interval;
  /** ok: confidently within the step margin; violated: confidently beyond it. */
  status: "ok" | "violated" | "unsure";
  /** The guard's measured values, as for the main metric (goal 184). */
  values: MetricValues;
}

export interface Decision<V> {
  /** Undefined when the look is not final and nothing is decided yet. */
  verdict: V | undefined;
  primary: Interval;
  /** The main metric's values the gain comes from (goal 133). */
  values?: MetricValues | undefined;
  guards: GuardResult[];
  /** At confirmation, each guard against the run's baseline (goal 115), when it has one. */
  vsStart?: StartGuard[] | undefined;
  reasons: string;
}

/**
 * The main metric's measured values (goal 133): in each case, the median of its blocks' values for
 * the candidate and for the reference (the champion it was compared with), as the gain compares
 * them. A reader sees `412 → 614 tok/s`, not only `+49%`.
 */
export interface MetricValues {
  metric: string;
  cells: { cell: string; candidate: number; reference: number }[];
}

/** The main metric's values of blocks, each case's median of each side (MetricValues). */
export function metricValues(
  blocks: readonly Block[],
  metric: string,
  cells: readonly string[],
): MetricValues {
  const median = (xs: number[]) => {
    const v = [...xs].sort((p, q) => p - q);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
  };
  // A block holds its values by metric, then by case, as the judge fills it (goal 142).
  const side = (cell: string, k: "candidate" | "reference") =>
    blocks.map((b) => b[k][metric]?.[cell]).filter((x): x is number => typeof x === "number");
  return {
    metric,
    cells: cells.flatMap((cell) => {
      const c = side(cell, "candidate");
      const r = side(cell, "reference");
      return c.length && r.length ? [{ cell, candidate: median(c), reference: median(r) }] : [];
    }),
  };
}

/**
 * The starting point's value of one metric on one cell: the median of the baseline's blocks and
 * their median absolute deviation (goal 115).
 */
export interface StartValue {
  median: number;
  mad: number;
}

/** A run's baseline as decisions read it: cell -> metric -> value. */
export type StartValues = Readonly<Record<string, Readonly<Record<string, StartValue>>>>;

/** One guard against the baseline: log ratios, positive meaning better than the start. */
export interface StartGuard {
  metric: string;
  /** A guard of the metric roles (goal 209): its bound. */
  rule?: GuardRule | undefined;
  /** The change's values against the starting point's (geometric mean over the cells). */
  estimate: number;
  /** The guard's total allowance. */
  allowed: number;
  /** The starting point's own spread, which never counts against a change. */
  noise: number;
  /** The regression is beyond the allowance and the noise: the allowance is spent. */
  spent: boolean;
}

type Policy = Pick<
  HillClimbContract,
  "objective" | "guards" | "cells" | "hard_constraints" | "acceptance" | "monitor_only" | "metrics"
>;

/** A kit's metrics with their roles (goal 209), as the judge has the run's kit. */
export type Roles = Readonly<Record<string, MetricRole>>;

/**
 * The guards of the metric roles (goal 209): the kit's and the contract's `metrics`. The
 * contract's own `guards` and `hard_constraints` are decided as they always were, beside them.
 */
function roleGuards(policy: Policy, roles: Roles | undefined): PlannedGuard[] {
  return metricPlan(policy, roles).guards.filter((g) => !g.legacy);
}

/** A metric's spread in the reference's blocks: per cell, the sd of its log values; their mean. */
function referenceSpread(
  blocks: readonly Block[],
  metric: string,
  cells: readonly string[],
): number {
  const sds = cells.map((cell) => {
    const xs = blocks
      .map((b) => b.reference[metric]?.[cell])
      .filter((x): x is number => x !== undefined && x > 0)
      .map((x) => Math.log(x));
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, x) => a + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  });
  return sds.reduce((a, x) => a + x, 0) / Math.max(1, sds.length);
}

/**
 * The role guards against the champion, on the paired blocks: above, at least the champion less
 * `by` of it; below, at most the champion plus `by` of it; within, the change no further from
 * the champion than `by` times the champion's own spread in these blocks. Each is ok when its
 * interval is wholly inside, violated when wholly outside, unsure otherwise, as the contract's
 * own guards are.
 */
function championGuardResults(
  guards: readonly PlannedGuard[],
  blocks: readonly Block[],
  cells: readonly string[],
  alpha: number,
): GuardResult[] {
  return guards
    .filter((g) => g.rule.against === "champion")
    .map((g) => {
      const by = g.rule.by ?? 0;
      const values = metricValues(blocks, g.metric, cells);
      if (g.rule.stay === "within") {
        const interval = meanInterval(blockEffects(blocks, g.metric, "max", cells), alpha);
        const lim = by * referenceSpread(blocks, g.metric, cells);
        const inside = interval.low > -lim && interval.high < lim;
        const outside = interval.low > lim || interval.high < -lim;
        const status = inside ? "ok" : outside ? "violated" : "unsure";
        return { metric: g.metric, rule: g.rule, interval, status, values };
      }
      const above = g.rule.stay === "above";
      const interval = meanInterval(
        blockEffects(blocks, g.metric, above ? "max" : "min", cells),
        alpha,
      );
      const margin = above ? (by >= 1 ? -Infinity : Math.log(1 - by)) : -Math.log1p(by);
      const status = interval.low > margin ? "ok" : interval.high < margin ? "violated" : "unsure";
      return { metric: g.metric, rule: g.rule, interval, status, values };
    });
}

/** The role guards against a fixed value: the candidate's mean on each cell holds to it. */
function valueGuardFailures(
  guards: readonly PlannedGuard[],
  blocks: readonly Block[],
  cells: readonly string[],
): string[] {
  const out: string[] = [];
  for (const g of guards.filter((x) => x.rule.against === "value")) {
    const v = g.rule.value ?? 0;
    for (const cell of cells) {
      const xs = blocks.map((b) => b.candidate[g.metric]?.[cell]);
      if (xs.some((x) => x === undefined || !Number.isFinite(x))) {
        out.push(`${g.metric}/${cell}: missing or non-finite`);
        continue;
      }
      const m = (xs as number[]).reduce((a, x) => a + x, 0) / xs.length;
      if (g.rule.stay === "above" ? m < v : m > v)
        out.push(`${g.metric}/${cell}: mean ${m} is not ${guardWords(g.rule)}`);
    }
  }
  return out;
}

/**
 * The role guards against the baseline, at confirmation: on each cell, the median of the
 * change's values against the starting point's median, as a log ratio; the guard's estimate is
 * their mean over the cells, and its noise the start's own spread, as for the contract's own
 * guards (startGuards). Above is spent when the change is further below the start than `by`
 * allows and the noise; below, further above it; within, further from it either way than `by`
 * standard deviations of the start's spread (its MAD × 1.4826). One with no baseline value on
 * a cell is not checked.
 */
function baselineGuardResults(
  guards: readonly PlannedGuard[],
  blocks: readonly Block[],
  cells: readonly string[],
  start: StartValues,
): StartGuard[] {
  const out: StartGuard[] = [];
  for (const g of guards.filter((x) => x.rule.against === "baseline")) {
    const effects: number[] = [];
    const noises: number[] = [];
    const spreads: number[] = [];
    for (const cell of cells) {
      const s = start[cell]?.[g.metric];
      const xs = blocks
        .map((b) => b.candidate[g.metric]?.[cell])
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
      if (!s || !(s.median > 0) || !xs.length) break;
      effects.push(Math.log(median(xs) / s.median));
      noises.push(Math.log1p(Math.abs(s.mad) / s.median));
      spreads.push(Math.log1p((1.4826 * Math.abs(s.mad)) / s.median));
    }
    if (effects.length !== cells.length) continue;
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const change = mean(effects);
    const by = g.rule.by ?? 0;
    if (g.rule.stay === "within") {
      const allowed = by * mean(spreads);
      out.push({
        metric: g.metric,
        rule: g.rule,
        estimate: change,
        allowed,
        noise: 0,
        spent: Math.abs(change) > allowed,
      });
      continue;
    }
    const above = g.rule.stay === "above";
    const estimate = above ? change : -change;
    const allowed = above ? (by >= 1 ? Infinity : -Math.log(1 - by)) : Math.log1p(by);
    const noise = mean(noises);
    out.push({
      metric: g.metric,
      rule: g.rule,
      estimate,
      allowed,
      noise,
      spent: estimate < -(allowed + noise),
    });
  }
  return out;
}

const median = (xs: number[]) => {
  const v = [...xs].sort((p, q) => p - q);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
};

/**
 * A tie on the primary broken down the priority metrics (goal 209, the owner, 2026-11-05): the
 * first lower priority with a min_effect that is not equivalent too decides. Better beyond its
 * min_effect: a win on it; worse: no win; neither yet: undecided. Equivalent on every one: none.
 */
function tieBreak(
  priorities: readonly PlannedPriority[],
  blocks: readonly Block[],
  cells: readonly string[],
  alpha: number,
  band: number,
): { by: PlannedPriority; interval: Interval; outcome: "win" | "worse" | "undecided" } | undefined {
  for (const p of priorities.slice(1)) {
    if (p.min_effect === undefined) continue;
    const interval = meanInterval(blockEffects(blocks, p.metric, p.direction, cells), alpha);
    if (interval.low > -band && interval.high < band) continue;
    const outcome =
      interval.low > 0 && interval.estimate >= toLog(p.min_effect)
        ? "win"
        : interval.high < 0 || (interval.low > 0 && interval.high < toLog(p.min_effect))
          ? "worse"
          : "undecided";
    return { by: p, interval, outcome };
  }
  return undefined;
}

/** Per-block effect for one metric: the mean log ratio over cells (a geometric mean ratio). */
export function blockEffects(
  blocks: readonly Block[],
  metric: string,
  direction: "max" | "min",
  cells: readonly string[],
): number[] {
  return blocks.map((b, i) => {
    const logs = cells.map((cell) => {
      const c = b.candidate[metric]?.[cell];
      const r = b.reference[metric]?.[cell];
      if (c === undefined || r === undefined) {
        throw new RangeError(`block ${i + 1} has no ${metric} for cell ${cell}`);
      }
      return logImprovement(c, r, direction);
    });
    return logs.reduce((s, x) => s + x, 0) / logs.length;
  });
}

/** Hard constraints on absolute values: the candidate's mean per cell must satisfy each. */
export function hardConstraintFailures(policy: Policy, blocks: readonly Block[]): string[] {
  const failures: string[] = [];
  for (const h of policy.hard_constraints) {
    // A `check` constraint is refused at validation (goal 163); one in a contract stored before
    // was never checked, and is not now.
    if (h.kind === "check") continue;
    for (const cell of policy.cells) {
      const values = blocks.map((b) => b.candidate[h.metric]?.[cell]);
      if (values.some((v) => v === undefined || !Number.isFinite(v))) {
        failures.push(`${h.metric}/${cell}: missing or non-finite`);
        continue;
      }
      const m = (values as number[]).reduce((s, x) => s + x, 0) / values.length;
      if (h.kind === "min" ? m < h.value : m > h.value) {
        failures.push(
          `${h.metric}/${cell}: mean ${m} is ${h.kind === "min" ? "below" : "above"} ${h.value}`,
        );
      }
    }
  }
  return failures;
}

function guardResults(policy: Policy, blocks: readonly Block[], alpha: number): GuardResult[] {
  return policy.guards.map((g) => {
    const interval = meanInterval(blockEffects(blocks, g.metric, g.direction, policy.cells), alpha);
    const margin = -toLog(g.max_step_regression);
    const status = interval.low > margin ? "ok" : interval.high < margin ? "violated" : "unsure";
    return {
      metric: g.metric,
      interval,
      status,
      values: metricValues(blocks, g.metric, policy.cells),
    };
  });
}

/**
 * Each guard against the run's baseline (goal 115). On each cell, the median of the change's
 * values in these blocks against the starting point's median, as a log ratio in the guard's
 * direction; the guard's estimate is their mean over the cells (a geometric mean ratio, as for
 * a block's effect). Its noise is the starting point's own spread on the same cells: the mean of
 * log(1 + MAD / median). The allowance is spent when the estimate is below
 * -(log(1 + max_total_regression) + noise): the change has fallen further from the start than
 * the guard allows, by more than the start's own noise. A guard with no baseline value on one
 * of the cells is not checked here.
 */
export function startGuards(
  policy: Policy,
  blocks: readonly Block[],
  start: StartValues,
): StartGuard[] {
  const median = (xs: number[]) => {
    const v = [...xs].sort((p, q) => p - q);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
  };
  const out: StartGuard[] = [];
  for (const g of policy.guards) {
    const effects: number[] = [];
    const noises: number[] = [];
    for (const cell of policy.cells) {
      const s = start[cell]?.[g.metric];
      const xs = blocks
        .map((b) => b.candidate[g.metric]?.[cell])
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
      if (!s || !(s.median > 0) || !xs.length) break;
      effects.push(logImprovement(median(xs), s.median, g.direction));
      noises.push(Math.log1p(Math.abs(s.mad) / s.median));
    }
    if (effects.length !== policy.cells.length) continue;
    const estimate = effects.reduce((a, x) => a + x, 0) / effects.length;
    const noise = noises.reduce((a, x) => a + x, 0) / noises.length;
    const allowed = toLog(g.max_total_regression);
    out.push({ metric: g.metric, estimate, allowed, noise, spent: estimate < -(allowed + noise) });
  }
  return out;
}

const pct = (logRatio: number) => `${(toFraction(logRatio) * 100).toFixed(2)}%`;
const describe = (i: Interval) => `${pct(i.estimate)} [${pct(i.low)}, ${pct(i.high)}] n=${i.n}`;

/**
 * Screening against the champion at one of the contract's looks. The screen's alpha is split
 * evenly across the looks (Bonferroni), so stopping early does not inflate false wins.
 */
export function decideScreen(
  policy: Policy,
  blocks: readonly Block[],
  /** The rig's calibrated A/A block spread for the primary metric (log ratio), if known. */
  noiseFloor = 0,
  /** The kit's metrics with their roles (goal 209). */
  roles?: Roles,
): Decision<ScreenVerdict> {
  const { acceptance } = policy;
  const final = blocks.length >= Math.max(...acceptance.looks);
  const alpha = acceptance.alpha_screen / acceptance.looks.length;
  const { metric, direction, min_effect } = policy.objective.primary;
  const primary = meanInterval(
    blockEffects(blocks, metric, direction, policy.cells),
    alpha,
    noiseFloor,
  );
  const extra = roleGuards(policy, roles);
  const guards = [
    ...guardResults(policy, blocks, alpha),
    ...championGuardResults(extra, blocks, policy.cells, alpha),
  ];
  const result = (verdict: ScreenVerdict | undefined, reasons: string) => ({
    verdict,
    primary,
    values: metricValues(blocks, metric, policy.cells),
    guards,
    reasons: `${reasons}; ${metric} ${describe(primary)}`,
  });

  const failures = [
    ...hardConstraintFailures(policy, blocks),
    ...valueGuardFailures(extra, blocks, policy.cells),
  ];
  if (failures.length) return result("infeasible", `hard constraints: ${failures.join("; ")}`);

  // A win, on the primary or on the lower priority that breaks a tie, holds to the guards.
  const win = (why: string) => {
    const violated = guards.filter((g) => g.status === "violated").map((g) => g.metric);
    if (violated.length) return result("tradeoff", `guards violated: ${violated.join(", ")}`);
    const unsure = guards.filter((g) => g.status === "unsure").map((g) => g.metric);
    if (!unsure.length) return result("win_screened", why);
    if (final) return result("inconclusive", `guards unresolved: ${unsure.join(", ")}`);
    return result(undefined, `guards unresolved: ${unsure.join(", ")}`);
  };
  const band = toLog(acceptance.equivalence_band);
  if (primary.low > -band && primary.high < band) {
    const tie = tieBreak(metricPlan(policy, roles).priorities, blocks, policy.cells, alpha, band);
    if (!tie) return result("neutral", "equivalent");
    const on = `equivalent; ${tie.by.metric} ${describe(tie.interval)}`;
    if (tie.outcome === "win") return win(`${on}, better beyond its min_effect`);
    if (tie.outcome === "worse" || final) return result("neutral", on);
    return result(undefined, `${on}, continue`);
  }
  if (primary.low > 0) {
    if (primary.high < toLog(min_effect)) return result("neutral", "gain below min_effect");
    if (primary.estimate >= toLog(min_effect)) return win("better beyond min_effect");
  }
  if (primary.high < 0) return result("regress", "worse");
  return result(
    final ? "inconclusive" : undefined,
    final ? "no decision by the last look" : "continue",
  );
}

/**
 * Confirmation: fresh blocks, decided on confirmation data alone at alpha_confirm. Each guard's
 * total allowance is checked twice: against the sum of the step estimates of the promoted steps
 * since the starting point (`priorGuardTotals`, log ratios) plus this step's, and, when the run
 * has a baseline (goal 115), against the starting point's measured values (startGuards).
 */
export function decideConfirm(
  policy: Policy,
  blocks: readonly Block[],
  priorGuardTotals: Readonly<Record<string, number>> = {},
  /** The rig's calibrated A/A block spread for the primary metric (log ratio), if known. */
  noiseFloor = 0,
  /** The run's baseline: the starting point's values on each cell (goal 115). */
  start?: StartValues | undefined,
  /** The kit's metrics with their roles (goal 209). */
  roles?: Roles,
): Decision<ConfirmVerdict> {
  const alpha = policy.acceptance.alpha_confirm;
  const { metric, direction } = policy.objective.primary;
  const primary = meanInterval(
    blockEffects(blocks, metric, direction, policy.cells),
    alpha,
    noiseFloor,
  );
  const extra = roleGuards(policy, roles);
  const guards = [
    ...guardResults(policy, blocks, alpha),
    ...championGuardResults(extra, blocks, policy.cells, alpha),
  ];
  const vsStart = start
    ? [
        ...startGuards(policy, blocks, start),
        ...baselineGuardResults(extra, blocks, policy.cells, start),
      ]
    : undefined;
  const result = (verdict: ConfirmVerdict, reasons: string) => ({
    verdict,
    primary,
    values: metricValues(blocks, metric, policy.cells),
    guards,
    ...(vsStart ? { vsStart } : {}),
    reasons: `${reasons}; ${metric} ${describe(primary)}`,
  });

  const failures = [
    ...hardConstraintFailures(policy, blocks),
    ...valueGuardFailures(extra, blocks, policy.cells),
  ];
  if (failures.length) return result("infeasible", `hard constraints: ${failures.join("; ")}`);
  const violated = guards.filter((g) => g.status === "violated").map((g) => g.metric);
  if (violated.length) return result("tradeoff", `guards violated: ${violated.join(", ")}`);
  const overTotal = policy.guards
    .filter((g) => {
      const est = guards.find((r) => r.metric === g.metric)?.interval.estimate ?? 0;
      return (priorGuardTotals[g.metric] ?? 0) + est < -toLog(g.max_total_regression);
    })
    .map((g) => g.metric);
  if (overTotal.length) {
    return result("tradeoff", `cumulative guard allowance spent: ${overTotal.join(", ")}`);
  }
  const spent = (vsStart ?? []).filter((g) => g.spent);
  if (spent.length) {
    return result(
      "tradeoff",
      `the guard's total allowance against the starting point is spent: ${spent
        .map((g) =>
          g.rule?.stay === "within"
            ? `${g.metric} ${pct(g.estimate)} from the starting point (allowed ±${pct(g.allowed)}, ${guardWords(g.rule)})`
            : `${g.metric} ${pct(g.estimate)} against the starting point (allowed -${pct(g.allowed)}, and its noise ${pct(g.noise)})`,
        )
        .join("; ")}`,
    );
  }
  // A tie on the primary is confirmed on fresh data too, down the priorities (goal 209).
  const band = toLog(policy.acceptance.equivalence_band);
  const tied = primary.low > -band && primary.high < band;
  const tie =
    primary.low <= 0 && tied
      ? tieBreak(metricPlan(policy, roles).priorities, blocks, policy.cells, alpha, band)
      : undefined;
  if (primary.low <= 0 && tie?.outcome !== "win")
    return result("not_confirmed", "gain not confirmed on fresh data");
  const unsure = guards.filter((g) => g.status === "unsure").map((g) => g.metric);
  if (unsure.length) return result("not_confirmed", `guards unresolved: ${unsure.join(", ")}`);
  if (tie)
    return result(
      "win_confirmed",
      `confirmed on fresh data: equivalent on ${metric}; ${tie.by.metric} ${describe(tie.interval)}`,
    );
  return result("win_confirmed", "confirmed on fresh data");
}

export type GoalStatus = "met" | "unmet" | "inconclusive" | "not_runnable";

export interface GoalDecision {
  goal: string;
  status: GoalStatus;
  /** Per cell: the interval of the measured value. Absent for code verifiers. */
  cells: Record<string, Interval>;
  reasons: string;
}

type GoalItem = GoalContract["goals"][number];

/**
 * A metric threshold goal is met only when every cell's interval lies on the passing side of
 * the threshold, unmet when any cell's interval lies wholly on the failing side, and
 * inconclusive otherwise. One rep per cell cannot give an interval, so it is inconclusive.
 */
export function decideThresholdGoal(
  goal: GoalItem,
  valuesByCell: Readonly<Record<string, readonly number[]>>,
  alpha: number,
): GoalDecision {
  if (goal.verify.type !== "metric_threshold") {
    throw new TypeError(`goal ${goal.id} is not a metric threshold goal`);
  }
  const { op, value, metric } = goal.verify;
  const cellNames = goal.verify.cells ?? Object.keys(valuesByCell);
  const missing = cellNames.filter((c) => !valuesByCell[c]?.length);
  if (missing.length || cellNames.length === 0) {
    return {
      goal: goal.id,
      status: "not_runnable",
      cells: {},
      reasons: `no ${metric} for ${missing.join(", ") || "any cell"}`,
    };
  }
  const passes = (x: number) =>
    op === ">=" ? x >= value : op === ">" ? x > value : op === "<=" ? x <= value : x < value;
  const cells: Record<string, Interval> = {};
  let allPass = true;
  let anyFail = false;
  const notes: string[] = [];
  for (const c of cellNames) {
    const xs = valuesByCell[c] as readonly number[];
    if (xs.length < 2) {
      allPass = false;
      notes.push(`${c}: one value (${xs[0]}), no interval`);
      continue;
    }
    const i = meanInterval(xs, alpha);
    cells[c] = i;
    const lowPass = passes(i.low);
    const highPass = passes(i.high);
    if (!(lowPass && highPass)) allPass = false;
    if (!lowPass && !highPass) anyFail = true;
    notes.push(
      `${c}: ${i.estimate.toPrecision(6)} [${i.low.toPrecision(6)}, ${i.high.toPrecision(6)}]`,
    );
  }
  const status: GoalStatus = anyFail ? "unmet" : allPass ? "met" : "inconclusive";
  return {
    goal: goal.id,
    status,
    cells,
    reasons: `${metric} ${op} ${value}: ${notes.join("; ")}`,
  };
}

/**
 * A goal candidate against the champion's goal statuses: goals it newly meets, goals the
 * champion meets that it fails (lost), and goals the champion meets that it could not check
 * (inconclusive or not runnable: unknown, which is neither a regression nor progress).
 */
export function goalDelta(
  results: { goal: string; status: GoalStatus }[],
  champion: Map<string, string>,
): { gained: string[]; lost: string[]; unsure: string[] } {
  const verified = (g: string) => champion.get(g) === "verified";
  return {
    gained: results.filter((r) => r.status === "met" && !verified(r.goal)).map((r) => r.goal),
    lost: results.filter((r) => r.status === "unmet" && verified(r.goal)).map((r) => r.goal),
    unsure: results
      .filter(
        (r) => (r.status === "inconclusive" || r.status === "not_runnable") && verified(r.goal),
      )
      .map((r) => r.goal),
  };
}

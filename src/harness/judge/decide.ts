import type { GoalContract, HillClimbContract } from "../../core/contract.ts";
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
  interval: Interval;
  /** ok: confidently within the step margin; violated: confidently beyond it. */
  status: "ok" | "violated" | "unsure";
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
  "objective" | "guards" | "cells" | "hard_constraints" | "acceptance"
>;

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
    return { metric: g.metric, interval, status };
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
  const guards = guardResults(policy, blocks, alpha);
  const result = (verdict: ScreenVerdict | undefined, reasons: string) => ({
    verdict,
    primary,
    values: metricValues(blocks, metric, policy.cells),
    guards,
    reasons: `${reasons}; ${metric} ${describe(primary)}`,
  });

  const failures = hardConstraintFailures(policy, blocks);
  if (failures.length) return result("infeasible", `hard constraints: ${failures.join("; ")}`);

  const band = toLog(acceptance.equivalence_band);
  if (primary.low > -band && primary.high < band) return result("neutral", "equivalent");
  if (primary.low > 0) {
    if (primary.high < toLog(min_effect)) return result("neutral", "gain below min_effect");
    if (primary.estimate >= toLog(min_effect)) {
      const violated = guards.filter((g) => g.status === "violated").map((g) => g.metric);
      if (violated.length) return result("tradeoff", `guards violated: ${violated.join(", ")}`);
      const unsure = guards.filter((g) => g.status === "unsure").map((g) => g.metric);
      if (!unsure.length) return result("win_screened", "better beyond min_effect");
      if (final) return result("inconclusive", `guards unresolved: ${unsure.join(", ")}`);
      return result(undefined, `guards unresolved: ${unsure.join(", ")}`);
    }
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
): Decision<ConfirmVerdict> {
  const alpha = policy.acceptance.alpha_confirm;
  const { metric, direction } = policy.objective.primary;
  const primary = meanInterval(
    blockEffects(blocks, metric, direction, policy.cells),
    alpha,
    noiseFloor,
  );
  const guards = guardResults(policy, blocks, alpha);
  const vsStart = start ? startGuards(policy, blocks, start) : undefined;
  const result = (verdict: ConfirmVerdict, reasons: string) => ({
    verdict,
    primary,
    values: metricValues(blocks, metric, policy.cells),
    guards,
    ...(vsStart ? { vsStart } : {}),
    reasons: `${reasons}; ${metric} ${describe(primary)}`,
  });

  const failures = hardConstraintFailures(policy, blocks);
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
        .map(
          (g) =>
            `${g.metric} ${pct(g.estimate)} against the starting point (allowed -${pct(g.allowed)}, and its noise ${pct(g.noise)})`,
        )
        .join("; ")}`,
    );
  }
  if (primary.low <= 0) return result("not_confirmed", "gain not confirmed on fresh data");
  const unsure = guards.filter((g) => g.status === "unsure").map((g) => g.metric);
  if (unsure.length) return result("not_confirmed", `guards unresolved: ${unsure.join(", ")}`);
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

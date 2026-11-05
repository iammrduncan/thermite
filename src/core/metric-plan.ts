import type { HillClimbContract } from "./contract.ts";
import { type GuardRule, guardWords, type MetricRole } from "./metric-roles.ts";

/**
 * A hill climb's metric plan (goal 209): what each metric is for in one run, read from its kit and
 * its contract (core/metric-roles.ts). The judge decides by it; the agents' brief and the run's
 * page show it.
 *
 * A contract's own fields read into it as they were always judged. `objective.primary` is
 * priority 1 and `objective.secondary` the next ones; a tie is broken only by a metric with a
 * min_effect, which a secondary entry takes from the kit, so a contract written before promotes
 * as it did. A guard's `max_step_regression` is a guard against the champion and its
 * `max_total_regression` one against the baseline, at the same limit as before: a fall of r is
 * to the reference ÷ (1 + r). A hard constraint's `min` or `max` is a guard against its value.
 * `monitor_only` is informational, and so is every kit metric nothing else names.
 */

export interface PlannedPriority {
  metric: string;
  /** 1 is the primary. */
  priority: number;
  direction: "max" | "min";
  /** The smallest change that counts; a lower priority breaks no tie without one. */
  min_effect?: number | undefined;
}

export interface PlannedGuard {
  metric: string;
  rule: GuardRule;
  /** Who set it: the kit, or the campaign's contract. */
  from: "kit" | "contract";
  /**
   * From the contract's own `guards` or `hard_constraints`: the judge decides it as it always
   * did, beside the guards of the metric roles.
   */
  legacy?: true | undefined;
}

interface PlannedInfo {
  metric: string;
  /** info, or another kind the kit names. */
  kind: string;
}

export interface MetricPlan {
  priorities: PlannedPriority[];
  guards: PlannedGuard[];
  info: PlannedInfo[];
}

type Plannable = Pick<
  HillClimbContract,
  "objective" | "guards" | "hard_constraints" | "monitor_only" | "metrics"
>;
/** A kit's metrics, as kit.json names them, each with its role. */
type KitMetrics = Record<string, MetricRole>;

const byPriority = (a: [string, MetricRole], b: [string, MetricRole]) =>
  (a[1].priority ?? 0) - (b[1].priority ?? 0);

/** The run's metric plan, from its contract and its kit's metrics. */
export function metricPlan(c: Plannable, kitMetrics: KitMetrics = {}): MetricPlan {
  const kit = Object.entries(kitMetrics);
  const own = Object.entries(c.metrics ?? {});
  const kitRole = (m: string): MetricRole => kitMetrics[m] ?? {};
  // The contract's priorities, else its primary followed by the kit's.
  const asked = [
    {
      metric: c.objective.primary.metric,
      direction: c.objective.primary.direction,
      min_effect: c.objective.primary.min_effect as number | undefined,
    },
    ...c.objective.secondary.map((s) => ({
      metric: s.metric,
      direction: s.direction,
      min_effect: kitRole(s.metric).min_effect,
    })),
    ...own
      .filter(([, r]) => r.kind === "priority")
      .sort(byPriority)
      .map(([m, r]) => ({
        metric: m,
        direction: r.direction ?? kitRole(m).direction ?? "max",
        min_effect: r.min_effect ?? kitRole(m).min_effect,
      })),
  ];
  if (asked.length === 1)
    for (const [m, r] of kit.filter(([, r]) => r.kind === "priority").sort(byPriority))
      asked.push({ metric: m, direction: r.direction ?? "max", min_effect: r.min_effect });
  const seen = new Set<string>();
  const priorities = asked
    .filter((p) => !seen.has(p.metric) && seen.add(p.metric))
    .map((p, i) => ({ ...p, priority: i + 1 }));

  const guards: PlannedGuard[] = [
    ...kit.flatMap(([m, r]) =>
      (r.guards ?? []).map((rule) => ({ metric: m, rule, from: "kit" as const })),
    ),
    ...own.flatMap(([m, r]) =>
      (r.guards ?? []).map((rule) => ({ metric: m, rule, from: "contract" as const })),
    ),
    ...c.guards.flatMap((g) => {
      const stay = g.direction === "max" ? ("above" as const) : ("below" as const);
      const by = (r: number) => (stay === "above" ? r / (1 + r) : r);
      return [
        { against: "champion" as const, r: g.max_step_regression },
        { against: "baseline" as const, r: g.max_total_regression },
      ].map(({ against, r }) => ({
        metric: g.metric,
        rule: { stay, against, by: by(r) },
        from: "contract" as const,
        legacy: true as const,
      }));
    }),
    ...c.hard_constraints.flatMap((h) =>
      h.kind === "check"
        ? []
        : [
            {
              metric: h.metric,
              rule: {
                stay: h.kind === "min" ? ("above" as const) : ("below" as const),
                against: "value" as const,
                value: h.value,
              },
              from: "contract" as const,
              legacy: true as const,
            },
          ],
    ),
  ];

  // Informational: every metric named that neither decides nor is a guard metric.
  const deciding = new Set([
    ...priorities.map((p) => p.metric),
    ...guards.map((g) => g.metric),
    ...[...kit, ...own].filter(([, r]) => r.kind === "guard").map(([m]) => m),
  ]);
  const info = new Map<string, string>();
  for (const [m, r] of [...kit, ...own]) {
    if (deciding.has(m)) continue;
    info.set(m, r.kind && r.kind !== "priority" ? r.kind : (info.get(m) ?? "info"));
  }
  for (const m of c.monitor_only) if (!deciding.has(m) && !info.has(m)) info.set(m, "info");
  return {
    priorities,
    guards,
    info: [...info].map(([metric, kind]) => ({ metric, kind })),
  };
}

/** Whether `a` holds its metric at least as closely as `b`, a guard of the same stay and reference. */
function asTight(a: GuardRule, b: GuardRule): boolean {
  if (a.against === "value")
    return a.stay === "above" ? (a.value ?? 0) >= (b.value ?? 0) : (a.value ?? 0) <= (b.value ?? 0);
  return (a.by ?? 0) <= (b.by ?? 0);
}

/**
 * What a contract asks of its kit's metric roles that it may not, in words: a metric the kit lacks,
 * or a guard looser than one the kit sets on the same metric, the same way and against the same
 * reference. A campaign may add metrics to a kind and tighten a kit's guards, never loosen one.
 */
export function planProblems(c: Plannable, kitMetrics: KitMetrics): string[] {
  const out: string[] = [];
  for (const m of Object.keys(c.metrics ?? {}))
    if (!(m in kitMetrics)) out.push(`metrics names metric ${m}, which the kit does not have`);
  const plan = metricPlan(c, kitMetrics);
  for (const g of plan.guards.filter((x) => x.from === "contract")) {
    const loose = (kitMetrics[g.metric]?.guards ?? []).find(
      (k) => k.stay === g.rule.stay && k.against === g.rule.against && !asTight(g.rule, k),
    );
    if (loose)
      out.push(
        `the guard on ${g.metric}, ${guardWords(g.rule)}, is looser than the kit's, ${guardWords(loose)}: a campaign may tighten a kit's guard, never loosen it`,
      );
  }
  return out;
}

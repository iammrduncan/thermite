import { directionName } from "../../../core/directions.ts";
import type { Assignment } from "../registry.ts";
import type { NewFamily } from "./check.ts";
import { directiveSets, type GoalReport, lanesOf, type PlannerInput } from "./context.ts";

/**
 * The goals of the judge's report a direction names (goal 079): a goal whose id is a word of the
 * direction's name or of its description, such as the goal `fast` in `make-it-fast`.
 */
export function goalsNamed(
  f: { id: string; description: string },
  report: GoalReport,
): GoalReport["goals"] {
  const text = `${f.id} ${f.description}`.toLowerCase();
  return report.goals.filter((g) => {
    const id = g.goal.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${id}($|[^a-z0-9])`).test(text);
  });
}

/**
 * The fixed plan: mandated families first, then tried, then the least explored. With the queue,
 * it only fills an empty one: a lane with no queued experiment to take gets one in this
 * direction, added by the planner.
 */
export function fallbackPlan(input: PlannerInput): {
  assignments: Assignment[];
  newFamilies: NewFamily[];
} {
  const { avoid, mandate, tryFam } = directiveSets(input);
  const newFamilies: NewFamily[] = [];
  // In a goal campaign, a direction whose goals the champion already meets all of is skipped
  // (goal 079): lanes go after what is not met yet. A mandated one stays: a rule asks for it.
  const report = input.goalReport;
  const allMet = (f: { id: string; description: string }) => {
    if (!report || mandate.has(f.id)) return false;
    const named = goalsNamed(f, report);
    return named.length > 0 && named.every((g) => g.status === "met");
  };
  const live = input.families.filter((f) => f.status === "live" && !avoid.has(f.id) && !allMet(f));
  // With every direction's goals met, a direction for each goal still unmet.
  if (report && !live.length) {
    for (const g of report.goals.filter((x) => x.status !== "met")) {
      const id = directionName(g.goal);
      if (!id || avoid.has(id) || newFamilies.some((n) => n.id === id)) continue;
      if (input.families.some((f) => f.id === id && f.status !== "live")) continue;
      newFamilies.push({
        id,
        description: `the goal "${g.goal}", which the champion does not meet yet`,
      });
    }
  }
  for (const m of mandate) {
    if (!live.some((f) => f.id === m)) {
      const d = input.directives.find((x) => x.body.kind === "mandate" && x.body.family === m);
      // A fixed description: a directive's rationale is for the planner, never for workers.
      newFamilies.push({
        id: m,
        description: `the "${m}" direction${d ? ` (named by rule ${d.id})` : ""}`,
      });
    }
  }
  const pool = [
    ...live.map((f) => ({ id: f.id, description: f.description, attempts: f.attempts })),
    ...newFamilies.map((f) => ({ ...f, attempts: 0 })),
  ];
  if (!pool.length) {
    const general = {
      id: "general",
      description: "Any correct change that improves the primary metric",
    };
    newFamilies.push(general);
    pool.push({ ...general, attempts: 0 });
  }
  // Mandated first, then tried; then a direction that names a goal not met yet; then the least
  // explored.
  const unmet = (f: { id: string; description: string }) =>
    report ? goalsNamed(f, report).some((g) => g.status !== "met") : false;
  const rank = (f: { id: string; description: string }) =>
    mandate.has(f.id) ? 0 : tryFam.has(f.id) ? 1 : unmet(f) ? 2 : 3;
  pool.sort((a, b) => rank(a) - rank(b) || a.attempts - b.attempts || a.id.localeCompare(b.id));
  const assignments = lanesOf(input.laneCount).map((lane, i) => {
    const f = pool[i % pool.length] as { id: string; description: string };
    return {
      lane,
      family: f.id,
      focus: `Work on the "${f.id}" direction: ${f.description}`,
      parent: input.laneBests[lane] ? ("lane_best" as const) : ("champion" as const),
    };
  });
  return { assignments, newFamilies };
}

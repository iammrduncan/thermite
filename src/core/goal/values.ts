/**
 * What a code verifier's goal measured (goal 086). A met goal used to say only "verifier V passed
 * on a, b", so a report had no numbers (for example a quality ratio). Now each public cell's run
 * keeps its values, in the goal report, its event and the goal's reasons, in words as a metric
 * threshold goal gives its own. The judge works them out from each run, and control reads them
 * back from the rig's goal report.
 *
 * Never a held-out cell's: the held-out pass keeps names and kinds only (goal 082), so the judge
 * collects no values in it.
 */
export interface GoalCellValues {
  cell: string;
  /** Whether the cell's run passed the kit's check. */
  ok: boolean;
  /** The kit's metrics as the judge worked them out, by name, in the kit's order. */
  metrics: Record<string, number>;
}

/** At most this many cells' values a goal keeps. */
export const GOAL_VALUES_CELLS = 100;

/**
 * A goal's values read back from a rig's goal report, each field checked: the report is data.
 * Null when it has none (another kind of goal, or a report from an older harness).
 */
export function parseGoalValues(raw: unknown): GoalCellValues[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GoalCellValues[] = [];
  for (const c of raw.slice(0, GOAL_VALUES_CELLS)) {
    if (!c || typeof c !== "object") continue;
    const { cell, ok, metrics } = c as Record<string, unknown>;
    if (typeof cell !== "string" || !metrics || typeof metrics !== "object") continue;
    out.push({
      cell: cell.slice(0, 200),
      ok: ok === true,
      metrics: Object.fromEntries(
        Object.entries(metrics as Record<string, unknown>)
          .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]))
          .map(([k, v]) => [k.slice(0, 200), v]),
      ),
    });
  }
  return out.length ? out : null;
}

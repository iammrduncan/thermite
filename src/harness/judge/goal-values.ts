import { GOAL_VALUES_CELLS, type GoalCellValues } from "../../core/goal/index.ts";
import type { Kit } from "../../core/kit.ts";
import type { ArmRun } from "./measure.ts";

/**
 * What a code verifier's goal measured, as the judge works it out from each public cell's run,
 * and its words in the goal's reasons. The values' shape and their reading back by control are
 * in core (`GoalCellValues`).
 */

/** At most this many of a check's own numbers a cell keeps, after the kit's metrics. */
export const CHECK_NUMBERS_MAX = 24;

/**
 * One run's values. A run that passed: every kit metric the judge worked out. A run whose output
 * the kit's check refused: the numbers the check reported for the kit's metrics taken from the
 * check, so an unmet goal shows by how much. Then, for either, the other numbers the check
 * reported at its top level (a ratio, both sides of a comparison, a count), by their names, at
 * most CHECK_NUMBERS_MAX: a kit's metrics must be numbers in every cell's check, so a kit whose
 * cells check different things declares none, and its values are these. A crash or refused
 * outputs: none.
 */
export function runValues(kit: Pick<Kit, "metrics">, r: ArmRun): Record<string, number> {
  if (r.kind === "crash") return {};
  const out: Record<string, number> = {};
  if (r.kind === "ok") {
    for (const [k, v] of Object.entries(r.metrics)) if (Number.isFinite(v)) out[k] = v;
  } else {
    for (const [name, m] of Object.entries(kit.metrics)) {
      if (!("from" in m) || m.from !== "check") continue;
      const v = r.check.details[m.field];
      if (typeof v === "number" && Number.isFinite(v)) out[name] = v;
    }
  }
  // The check's own numbers. Fields a kit metric reads are already there, under the metric's name.
  const read = new Set(
    Object.values(kit.metrics).flatMap((m) => ("from" in m && m.from === "check" ? [m.field] : [])),
  );
  let added = 0;
  for (const [k, v] of Object.entries(r.check.details)) {
    if (added >= CHECK_NUMBERS_MAX) break;
    if (k === "pass" || k === "reasons" || read.has(k) || k in out) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[k.slice(0, 64)] = v;
    added++;
  }
  return out;
}

/** A value as a threshold goal's reasons give one: six significant figures; a small count as it is. */
const fig = (v: number) =>
  Number.isInteger(v) && Math.abs(v) < 1e6 ? String(v) : v.toPrecision(6);

/**
 * Cells' values in words, as a threshold goal's reasons give its own: "small: ops_per_s
 * 4.51235e+7, value 4.20000e+7; big: ops_per_s 4.40000e+7". At most GOAL_VALUES_CELLS cells, and
 * how many more.
 */
export function valuesText(cells: readonly GoalCellValues[]): string {
  const shown = cells.slice(0, GOAL_VALUES_CELLS).map(
    (c) =>
      `${c.cell}: ${Object.entries(c.metrics)
        .map(([k, v]) => `${k} ${fig(v)}`)
        .join(", ")}`,
  );
  const more = cells.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more cells` : ""}`;
}

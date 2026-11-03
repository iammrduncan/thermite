import {
  championValues,
  championWords,
  currentChampion,
  figure,
  type MetricValues,
  pairWords,
  type RunView,
  valuesByCase,
  valuesWords,
} from "../../views/index.ts";
import { signed } from "../words/index.ts";
import { esc, infoLabel } from "./index.ts";

/**
 * A hill climb's gains with the real values they come from (goal 133): a chip `+49.0%` and, beside
 * it, `412 → 614 tok/s`, each case's values on hover. The unit is the main metric's in the run's
 * baseline (goal 115); a run without one shows the values with no unit.
 */

type Run = Pick<RunView, "baseline">;

/** The run's main metric's unit, from its baseline; undefined without one. */
export function metricUnit(r: Run): string | undefined {
  const p = r.baseline?.primary;
  return p ? r.baseline?.units[p.metric] : undefined;
}

/** A change's gain as a chip, with its values beside it when the verdict carried them. */
export function gainChip(
  r: Run,
  a: { delta: number | null; values?: MetricValues | null | undefined },
  tone = typeof a.delta === "number" ? (a.delta > 0 ? "ok" : a.delta < 0 ? "bad" : "") : "",
): string {
  if (typeof a.delta !== "number") return "";
  const unit = metricUnit(r);
  const v = a.values
    ? ` <span class="muted small" title="${esc(valuesByCase(a.values, unit))}">${esc(valuesWords(a.values, unit))}</span>`
    : "";
  return `<span class="chip ${tone}"><b>${esc(signed(a.delta))}</b></span>${v}`;
}

/** What the judge measured, in words: `+49.0% (412 → 614 tok/s)`, without the values when none. */
export function measuredWords(
  r: Run,
  a: { delta: number; values?: MetricValues | null | undefined },
): string {
  const v = a.values ? ` (${valuesWords(a.values, metricUnit(r))})` : "";
  return `${signed(a.delta)}${v}`;
}

/**
 * The starting point's value of the main metric, from the run's baseline: one case's median, or the
 * cases' geometric mean, with the unit (`412 tok/s`); empty without a baseline.
 */
export function startWords(r: Run): string {
  const b = r.baseline;
  const metric = b?.primary?.metric;
  if (!b || !metric) return "";
  const xs = b.cells.flatMap((c) =>
    c.metrics.filter((m) => m.metric === metric && m.median > 0).map((m) => m.median),
  );
  if (!xs.length) return "";
  const mean = Math.exp(xs.reduce((n, x) => n + Math.log(x), 0) / xs.length);
  const unit = metricUnit(r);
  return `${figure(mean)}${unit ? ` ${unit}` : ""}${xs.length > 1 ? `, the mean of ${xs.length} cases` : ""}`;
}

/** A leaderboard row's values: the starting point's and the champion's (`412 → 614 tok/s`). */
export const valuesPairWords = pairWords;

/** The campaign headline's line under its best gain, with that run's values when it has them. */
export function bestGainWords(
  best: Pick<RunView, "baseline" | "champion" | "attempts"> | undefined,
) {
  const w = best ? championWords(best) : "";
  return w ? `best gain over its baseline: ${w}` : "best gain over its baseline";
}

const CHAMPION_TIP =
  "The run's best change so far. The big number: its main metric, as the judge measured it when it confirmed the change (the cases' geometric mean). Under it: its gain over the starting point, measured on this rig, and the starting point's value. ≈: an estimate from the starting point's value and the gain, for a champion whose verdict did not record its values.";

/**
 * A hill climb's champion at the top of its run's page, left of Cost (goal 142): its main metric's
 * value and its gain over the starting point. Empty for another mode, or with nothing to show.
 */
export function championCard(r: Pick<RunView, "mode" | "baseline" | "champion" | "attempts">) {
  const step = currentChampion(r);
  if (r.mode !== "hill_climb" || !step) return "";
  const v = championValues(r);
  const u = v?.unit ? `<span class="u"> ${esc(v.unit)}</span>` : "";
  const big =
    v?.champion != null
      ? `${v.estimated ? "≈" : ""}${esc(figure(v.champion))}${u}`
      : `${esc(signed(step.cumulative - 1))}`;
  const start = v?.start != null ? `${esc(figure(v.start))}${v.unit ? ` ${esc(v.unit)}` : ""}` : "";
  const sub = !step.attempt
    ? "the starting point: no change promoted yet"
    : `<span class="chip ok"><b>${esc(signed(step.cumulative - 1))}</b></span> over the start${start ? `, ${start}` : ""}`;
  return `<div class="fact uf-champ"><div class="k">${infoLabel(`Champion #${step.seq}`, CHAMPION_TIP)}</div><div class="v">${big}</div><div class="s">${sub}</div></div>`;
}

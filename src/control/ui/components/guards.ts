import {
  type AttemptView,
  type ChampionGuard,
  championGuards,
  guardMeasured,
  nearLimit,
  type RunView,
  valuesByCase,
} from "../../views/index.ts";
import { signed } from "../words/index.ts";
import { esc } from "./index.ts";

/**
 * A hill climb's guards beside its main metric (goal 184): a chart for each guard under the
 * champions' gain, with the starting point and the contract's limit; a line of guard values under
 * each champion; and each attempt's guards beside its gain.
 */

type Run = Pick<RunView, "baseline" | "champion" | "attempts">;

const pct = (x: number, digits = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
/** Four significant figures: a guard's limit is often 1%, so three can't tell it from the start. */
function fine(x: number): string {
  if (x === 0) return "0";
  const digits = Math.max(0, 3 - Math.floor(Math.log10(Math.abs(x))));
  return x.toLocaleString("en-US", { maximumFractionDigits: Math.min(digits, 6) });
}
const value = (x: number, unit: string | null) => `${fine(x)}${unit ? ` ${unit}` : ""}`;
const limitWords = (g: ChampionGuard) =>
  `${g.direction === "max" ? "may fall" : "may rise"} at most ${(g.allowed * 100).toFixed(1).replace(/\.0$/, "")}% ${g.direction === "max" ? "below" : "above"} the start`;

const limitPct = (g: ChampionGuard) =>
  `${g.direction === "max" ? "−" : "+"}${(g.allowed * 100).toFixed(1).replace(/\.0$/, "")}%`;
const title = (g: ChampionGuard) =>
  `<div class="gchart-title"><b>${esc(g.metric)}</b><span class="muted small">guard · ${esc(limitWords(g))}</span></div>`;

/** A guard with fewer than two values to draw: the start, the limit and what is known, in words. */
function guardWords(g: ChampionGuard, start: number, limit: number): string {
  const last = g.points.filter((p) => p.value !== null && p.seq !== g.points[0]?.seq).at(-1);
  const now =
    last && last.value !== null
      ? ` · #${last.seq} <b>${last.estimated ? "≈" : ""}${esc(value(last.value, g.unit))}</b> (${pct(last.value / start - 1)})`
      : "";
  return `<div class="gchart gchart-words">${title(g)}<div class="small">start <b>${esc(value(start, g.unit))}</b> · limit <b class="bad">${esc(fine(limit))}</b> (${limitPct(g)})${now}${last ? "" : ` <span class="muted">· each champion's value shows here once the judge has one</span>`}</div></div>`;
}

/**
 * One guard's chart: each champion's value along the champions, the start dotted and the limit
 * dashed in red; an estimated value (a champion judged before verdicts carried values) hollow
 * and dashed.
 */
function guardChart(g: ChampionGuard, w = 560, h = 128): string {
  const { start, limit } = g;
  if (start === null || limit === null) return "";
  const known = g.points.flatMap((p, i) => (p.value === null ? [] : [{ ...p, i, v: p.value }]));
  if (known.length < 2) return guardWords(g, start, limit);
  const n = g.points.length;
  const lo = Math.min(start, limit, ...known.map((p) => p.v));
  const hi = Math.max(start, limit, ...known.map((p) => p.v));
  const span = hi - lo || Math.abs(hi) || 1;
  const y0 = lo - span * 0.15;
  const y1 = hi + span * 0.3;
  const [padL, padR, padT, padB] = [58, 14, 8, 18];
  const X = (i: number) => padL + (i / Math.max(1, n - 1)) * (w - padL - padR);
  const Y = (y: number) => padT + ((y1 - y) / (y1 - y0)) * (h - padT - padB);
  const f = (x: number) => x.toFixed(1);
  const line = known.map((p, k) => `${k ? "L" : "M"}${f(X(p.i))},${f(Y(p.v))}`).join(" ");
  const pts = known
    .map(
      (p) =>
        `<circle class="gpt${nearLimit(g, p.v) ? " near" : ""}${p.estimated ? " est" : ""}" cx="${f(X(p.i))}" cy="${f(Y(p.v))}" r="3.5"><title>#${p.seq}: ${p.estimated ? "≈" : ""}${esc(value(p.v, g.unit))} (${pct(p.v / start - 1)} of the start)${p.estimated ? ", estimated from the judge's change: it was judged before verdicts carried guard values" : ""}</title></circle>`,
    )
    .join("");
  const last = known.at(-1) as (typeof known)[number];
  const lx = X(last.i);
  const anchor = lx > w - padR - 40 ? "end" : lx < padL + 40 ? "start" : "middle";
  // Each champion's number under it; with many, the first, the last and every few between.
  const every = Math.max(1, Math.ceil(n / 8));
  const seqs = g.points
    .map((p, i) =>
      i === 0 || i === n - 1 || i % every === 0
        ? `<text x="${f(X(i))}" y="${h - 4}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">#${p.seq}</text>`
        : "",
    )
    .join("");
  return `<div class="gchart">${title(g)}
<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(g.metric)} of each champion, with the start and its limit">
<line class="start" x1="${padL}" x2="${w - padR}" y1="${f(Y(start))}" y2="${f(Y(start))}"/><text x="${padL - 6}" y="${f(Y(start) + 4)}" text-anchor="end">${esc(fine(start))}</text>
<line class="limit" x1="${padL}" x2="${w - padR}" y1="${f(Y(limit))}" y2="${f(Y(limit))}"/><text class="lbl-limit" x="${padL - 6}" y="${f(Y(limit) + 4)}" text-anchor="end">${esc(fine(limit))}</text>
<path class="gline" d="${line}"/>${pts}<text x="${f(anchor === "start" ? lx + 6 : anchor === "end" ? lx + 2 : lx)}" y="${f(Math.max(padT + 10, Y(last.v) - 8))}" text-anchor="${anchor}" class="glast">${last.estimated ? "≈" : ""}${esc(value(last.v, g.unit))}</text>
${seqs}</svg></div>`;
}

/**
 * The run's guard charts, one for each guard its baseline names, with a legend; empty for a run
 * without guards or a baseline.
 */
export function guardCharts(r: Run): string {
  const guards = championGuards(r);
  const charts = guards.map((g) => guardChart(g)).filter(Boolean);
  if (!charts.length) return "";
  const drawn = guards.some((g) => g.points.filter((p) => p.value !== null).length >= 2);
  const estimated = guards.some((g) => g.points.some((p) => p.estimated));
  return `<div class="guards">${charts.join("")}</div>${
    drawn
      ? `<div class="guard-legend muted small"><span><i class="lg-value"></i>each champion's value</span><span><i class="lg-start"></i>the start</span><span><i class="lg-limit"></i>the limit: no champion may pass it</span>${estimated ? `<span><i class="lg-est"></i>≈ estimated: judged before verdicts carried guard values</span>` : ""}</div>`
      : ""
  }`;
}

/**
 * A champion's guard values under its row: `decode_tps 29.93 tok/s (−0.07% of the start; limit
 * −1%)`, amber within a quarter of the limit; empty when none of its values is known.
 */
export function championGuardLine(r: Run, seq: number): string {
  const parts = championGuards(r).flatMap((g) => {
    const p = g.points.find((x) => x.seq === seq);
    const v = p?.value;
    if (v === null || v === undefined || g.start === null) return [];
    const near = nearLimit(g, v);
    return [
      `<span class="${near ? "near" : ""}"${p?.estimated ? ` title="estimated from the judge's change: judged before verdicts carried guard values"` : ""}>${esc(g.metric)} <b>${p?.estimated ? "≈" : ""}${esc(value(v, g.unit))}</b> (${pct(v / g.start - 1)} of the start; limit ${limitPct(g)})${near ? " · near its limit" : ""}</span>`,
    ];
  });
  return parts.length ? `<div class="lad-guards">${parts.join("")}</div>` : "";
}

/**
 * An attempt's guards beside its gain: each guard's measured change against the champion it was
 * measured with (`decode_tps −0.1%`), red when the judge found it beyond the step's margin, amber
 * while unsure; each case's values on hover.
 */
export function attemptGuards(r: Run, a: Pick<AttemptView, "guards">): string {
  const units = r.baseline?.units ?? {};
  const parts = a.guards.flatMap((g) => {
    const m = guardMeasured(g);
    if (m === null) return [];
    const tone = g.status === "violated" ? "bad" : g.status === "unsure" ? "warn" : "";
    const tip = `${g.metric} against the champion it was measured with${g.values ? `\n${valuesByCase(g.values, units[g.metric])}` : ""}${g.status === "violated" ? "\nbeyond the step's margin the contract allows" : ""}`;
    return [
      `<span class="ag ${tone}" title="${esc(tip)}">${esc(g.metric)} ${esc(signed(m))}</span>`,
    ];
  });
  return parts.length ? `<span class="ar-guards">${parts.join("")}</span>` : "";
}

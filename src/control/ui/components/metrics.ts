import { guardWordsAsks } from "../../../core/metric-roles.ts";
import {
  currentChampion,
  figure,
  type GuardRow,
  type RunMetrics,
  type RunView,
  roomLeft,
  runMetrics,
} from "../../views/index.ts";
import { signed } from "../words/index.ts";
import { esc, gainChart } from "./index.ts";

/**
 * A hill climb's metrics at the top of its Overview (goal 209, the owner's option B2): the
 * primary in a card with the hill-climb chart, as its gain or in its unit; each lower priority in
 * a card with a sparkline of the champions' values; a row for each guard with its bound, a
 * sparkline of the champions' values against the start (dotted), its limits (dashed red) and an
 * allowed band (green), and the room the newest measured attempt leaves; and a tile for each
 * informational metric with its sparkline.
 */

const f = (n: number) => n.toFixed(1);
const unitOf = (u: string | null) => (u ? ` ${u}` : "");
const pct = (v: number, ref: number) => {
  const p = (v / ref - 1) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
};

/** A small chart of values, oldest first, with an optional start, limits and the newest attempt. */
function spark(
  values: (number | null)[],
  o: {
    w: number;
    h: number;
    start?: number | null;
    lows?: (number | null)[];
    highs?: (number | null)[];
    latest?: number | null;
    label: string;
    /** As wide as its card, its height to scale; else `w` pixels wide. */
    fluid?: boolean;
  },
): string {
  const known = values.filter((v): v is number => v !== null);
  const lims = [...(o.lows ?? []), ...(o.highs ?? [])].filter((v): v is number => v !== null);
  const all = [
    ...known,
    ...lims,
    ...(o.start != null ? [o.start] : []),
    ...(o.latest != null ? [o.latest] : []),
  ];
  if (known.length < 1 || !all.length) return `<span class="muted small">no values yet</span>`;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
  lo -= pad;
  hi += pad;
  const n = values.length + (o.latest != null ? 1 : 0);
  const X = (i: number) => 3 + (i / Math.max(1, n - 1)) * (o.w - 8);
  const Y = (v: number) => 3 + ((hi - v) / (hi - lo)) * (o.h - 6);
  const steps = (xs: (number | null)[] | undefined) => {
    let d = "";
    xs?.forEach((v, i) => {
      if (v === null) return;
      d += d ? ` H${f(X(i))} V${f(Y(v))}` : `M${f(X(i))},${f(Y(v))}`;
    });
    return d ? `${d} H${f(o.w - 2)}` : "";
  };
  const lows = o.lows ?? [];
  const highs = o.highs ?? [];
  const band =
    lows.length && highs.length && lows[0] != null && highs[0] != null
      ? `<rect class="ms-band" x="2" y="${f(Y(highs[0]))}" width="${o.w - 4}" height="${f(Y(lows[0]) - Y(highs[0]))}"/>`
      : "";
  let line = "";
  values.forEach((v, i) => {
    if (v !== null) line += `${line ? "L" : "M"}${f(X(i))},${f(Y(v))} `;
  });
  const dots = values
    .map((v, i) =>
      v === null ? "" : `<circle class="ms-pt" cx="${f(X(i))}" cy="${f(Y(v))}" r="2.2"/>`,
    )
    .join("");
  const latest =
    o.latest != null
      ? `<circle class="ms-latest" cx="${f(X(n - 1))}" cy="${f(Y(o.latest))}" r="3"><title>the newest measured attempt</title></circle>`
      : "";
  const start =
    o.start != null
      ? `<line class="start" x1="2" x2="${o.w - 2}" y1="${f(Y(o.start))}" y2="${f(Y(o.start))}"/>`
      : "";
  return `<svg class="chart ms-spark${o.fluid ? " fluid" : ""}" viewBox="0 0 ${o.w} ${o.h}"${o.fluid ? "" : ` style="width:${o.w}px"`} role="img" aria-label="${esc(o.label)}">${band}${start}<path class="limit" d="${steps(o.lows)} ${steps(o.highs)}"/><path class="ms-line" d="${line}"/>${dots}${latest}</svg>`;
}

const last = (xs: { value: number | null }[]) =>
  [...xs].reverse().find((p) => p.value !== null)?.value ?? null;

function primaryCard(r: RunView, m: RunMetrics): string {
  const p = m.priorities[0];
  if (!p) return "";
  const now = last(p.points);
  // The gain as the judge measured it, each champion against the one it replaced, as the champion
  // card and the chart give it: the values compared beside it come from different measurements.
  const step = currentChampion(r);
  const gain = step?.attempt ? signed(step.cumulative - 1) : pct(now ?? 0, p.start ?? 1);
  const valueChart =
    p.start !== null ? gainChart(r, 760, 200, { start: p.start, unit: p.unit ?? "" }) : "";
  const toggle = valueChart
    ? `<span class="ms-switch"><input type="radio" name="ms-mode" id="ms-gain" checked><label for="ms-gain">Gain</label><input type="radio" name="ms-mode" id="ms-unit"><label for="ms-unit">${esc(p.unit || "Value")}</label></span>`
    : "";
  return `<div class="card ms-primary"><div class="ms-head"><span class="chip info">Priority 1 · primary</span><b>${esc(p.metric)}</b><span class="muted small">${p.direction === "max" ? "higher" : "lower"} is better${p.min_effect !== null ? ` · counts from ${(p.min_effect * 100).toFixed(1).replace(/\.0$/, "")}%` : ""}</span></div>${
    now !== null && p.start !== null
      ? `<div class="ms-big"><span class="fig-big">${esc(figure(now))}${esc(unitOf(p.unit))}</span><span class="ok" title="The judge's gain: each champion measured against the one it replaced, in the same blocks. The starting point's value was measured at the run's start.">${esc(gain)} over the start, ${esc(figure(p.start))}</span></div>`
      : ""
  }${toggle}<div class="ms-chart ms-chart-gain">${gainChart(r)}</div>${valueChart ? `<div class="ms-chart ms-chart-unit">${valueChart}</div>` : ""}${
    p.latest
      ? `<div class="muted small">Newest measured: ${esc(p.latest.attempt)}, ${esc(figure(p.latest.value))}${esc(unitOf(p.unit))}</div>`
      : ""
  }</div>`;
}

function lowerCards(m: RunMetrics): string {
  return m.priorities
    .slice(1)
    .map((p) => {
      const now = last(p.points);
      return `<div class="card ms-lower"><div class="ms-head"><span class="chip">Priority ${p.priority}</span><b>${esc(p.metric)}</b></div><div class="muted small">${p.direction === "max" ? "Higher" : "Lower"} is better; breaks a tie on the priorities before it${p.min_effect !== null ? `, from ${(p.min_effect * 100).toFixed(1).replace(/\.0$/, "")}%` : ", with no min_effect: it breaks none"}</div>${
        now !== null
          ? `<div class="ms-mid"><span class="fig">${esc(figure(now))}${esc(unitOf(p.unit))}</span>${p.start ? `<span class="muted small">${esc(pct(now, p.start))} on the start</span>` : ""}</div>`
          : ""
      }${spark(
        p.points.map((x) => x.value),
        {
          w: 300,
          h: 44,
          start: p.start,
          latest: p.latest?.value ?? null,
          label: `${p.metric} of each champion`,
          fluid: true,
        },
      )}</div>`;
    })
    .join("");
}

function guardRows(m: RunMetrics): string {
  if (!m.guards.length) return "";
  const row = (g: GuardRow) => {
    const champ = last(g.points);
    const room = roomLeft(g);
    const past = room?.endsWith("past it");
    return `<div class="ms-guard"><div><b>${esc(g.metric)}</b><div class="muted small">${esc(guardWordsAsks(g.rule))}</div></div>${spark(
      g.points.map((p) => p.value),
      {
        w: 320,
        h: 44,
        start: g.start,
        lows: g.limits.map((l) => l.low),
        highs: g.limits.map((l) => l.high),
        latest: g.latest?.value ?? null,
        label: `${g.metric} of each champion, with its limit`,
      },
    )}<span class="fig">${champ !== null ? esc(`${figure(champ)}${unitOf(g.unit)}`) : "·"}</span><span class="fig">${g.latest ? esc(`${figure(g.latest.value)}${unitOf(g.unit)}`) : "·"}</span><span>${room ? `<span class="chip ${past ? "bad" : "ok"}">${esc(room)}</span>` : ""}</span></div>`;
  };
  return `<div class="card flat ms-guards"><div class="ms-guards-head"><b>Guard metrics</b><span class="muted small">A change past a limit is refused, however much it gains. Each line: the champions' values, the start dotted, the limit dashed red, the allowed band green.</span></div><div class="ms-guard ms-guard-cols muted small"><span>Guard and its bound</span><span>Champions since the start</span><span>The champion</span><span>Newest measured</span><span>Room it leaves</span></div>${m.guards.map(row).join("")}</div>`;
}

function infoTiles(m: RunMetrics): string {
  if (!m.info.length) return "";
  return `<div class="ms-info-head"><b>Informational metrics</b><span class="muted small">Recorded with every measurement; each champion's value. They never pass or fail a change.</span></div><div class="ms-tiles">${m.info
    .map((i) => {
      const now = last(i.points);
      return `<div class="card ms-tile"><div class="muted small">${esc(i.metric)}${i.kind !== "info" ? ` · ${esc(i.kind)}` : ""}</div><div class="ms-tile-row"><span class="fig">${now !== null ? esc(`${figure(now)}${unitOf(i.unit)}`) : "·"}</span>${spark(
        i.points.map((p) => p.value),
        { w: 120, h: 30, latest: i.latest?.value ?? null, label: `${i.metric} of each champion` },
      )}</div>${now !== null && i.start ? `<div class="muted small">${esc(pct(now, i.start))} on the start, ${esc(figure(i.start))}${esc(unitOf(i.unit))}</div>` : ""}</div>`;
    })
    .join("")}</div>`;
}

/** The metrics block of a hill climb's Overview; empty before the judge measured its start. */
export function metricsBlock(r: RunView): string {
  const m = runMetrics(r);
  if (!m?.priorities.length) return "";
  return `<div class="block" data-part="metrics"><div class="head"><h2>Metrics</h2><span class="right muted small">measured on this rig, against the starting point</span></div><div class="ms-top">${primaryCard(r, m)}</div>${m.priorities.length > 1 ? `<div class="ms-lowers">${lowerCards(m)}</div>` : ""}${guardRows(m)}${infoTiles(m)}</div>`;
}

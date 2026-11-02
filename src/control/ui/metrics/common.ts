import { sizeWords } from "../../../core/words.ts";
import type { Place } from "../../system/index.ts";
import { esc, infoLabel } from "../components/index.ts";

/** A size in words; a dash for none. */
export const size = (b: number | null | undefined) =>
  b === null || b === undefined ? "—" : sizeWords(b);
export const count = (n: number) => Math.round(n).toLocaleString("en-US");
/** A rate a second: two decimals under 10, one above. */
export const perSecond = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toFixed(n < 10 ? 2 : 1);
/** A share as a whole percent. */
export const share = (x: number) => `${Math.round(Math.max(0, x) * 100)}%`;
/** A time as the page says it: 2026-11-01 05:20 UTC. */
export const utc = (at: string | null) => (at ? `${at.slice(0, 16).replace("T", " ")} UTC` : "—");

/** How long since `iso`, in words: 4 s, 12 min, 3 h 20 min, 8 days. */
export function since(iso: string | null, now: number): string {
  if (!iso) return "—";
  return duration((now - Date.parse(iso)) / 1000);
}

/** A number of seconds in words: 4 s, 12 min, 3 h 20 min, 8 days. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.round(s / 86_400)} days`;
}

/** A bar's tone by how full it is: amber past 85%, red past 95%. */
const tone = (x: number) => (x > 0.95 ? "bad" : x > 0.85 ? "warn" : "primary");

/** A thin bar of a share. */
export const bar = (x: number) =>
  `<div class="bar ${tone(x)}"><i style="width:${(Math.min(1, Math.max(0, x)) * 100).toFixed(1)}%"></i></div>`;

/** A tile: its label with an info icon, its value, a line under it, and a bar or chart. */
export function tile(label: string, tip: string, value: string, sub: string, foot = ""): string {
  return `<div class="fact"><div class="k">${tip ? infoLabel(label, tip) : esc(label)}</div><div class="v">${value}</div><div class="s">${sub}</div>${foot}</div>`;
}

/** Stacked parts of a whole, as one bar with a legend; the parts' tones s1 to s6. */
export function split(parts: { label: string; bytes: number }[], total: number): string {
  const all = Math.max(
    total,
    parts.reduce((n, p) => n + p.bytes, 0),
    1,
  );
  const segs = parts
    .map(
      (p, i) =>
        `<i class="s${(i % 6) + 1}" style="width:${((p.bytes / all) * 100).toFixed(2)}%"></i>`,
    )
    .join("");
  const legend = parts
    .map(
      (p, i) =>
        `<span><i class="s${(i % 6) + 1}"></i>${esc(p.label)} <b>${esc(size(p.bytes))}</b></span>`,
    )
    .join("");
  return `<div class="sys-split">${segs}</div><div class="sys-legend">${legend}</div>`;
}

/** A small line chart of numbers, scaled to `max`, as inline SVG. */
export function spark(values: (number | null)[], max: number): string {
  const v = values.map((x) => x ?? 0);
  if (v.length < 2 || max <= 0) return "";
  const w = 200;
  const h = 32;
  const pts = v
    .map(
      (x, i) =>
        `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - (Math.min(x, max) / max) * (h - 4)).toFixed(1)}`,
    )
    .join(" ");
  return `<svg class="sys-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="the last few minutes"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

/** Places that hold state, each with what it uses, what it may still take, and its size. */
export function placesTable(places: Place[], tips: { used: string; available: string }): string {
  if (!places.length) return `<div class="empty">Nothing to show.</div>`;
  const rows = places
    .map((p) => {
      const full = p.total ? p.used / p.total : null;
      return `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.of)}</div></td><td class="num">${esc(size(p.used))}</td><td class="num">${esc(size(p.available))}</td><td class="num">${esc(size(p.total))}</td><td class="sys-barcell">${full === null ? `<span class="muted small">no limit known</span>` : `${bar(full)}<span class="muted small">${share(full)} used</span>`}</td></tr>`;
    })
    .join("");
  return `<div class="utw"><table><thead><tr><th>Place</th><th class="num">${infoLabel("Used", tips.used)}</th><th class="num">${infoLabel("Available", tips.available)}</th><th class="num">Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** A block: its heading, a count, words on the right, and its body. */
export const block = (title: string, right: string, body: string, n = "") =>
  `<div class="block"><div class="head"><h2>${title}</h2>${n ? `<span class="n">${n}</span>` : ""}<span class="right">${right}</span></div>${body}</div>`;

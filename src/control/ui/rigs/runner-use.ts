import type { RunnerShare, UseView, UseWindow } from "../../views/index.ts";
import { esc } from "../components/index.ts";

/**
 * The Runners block's **How they spent** (goal 231): for the window chosen, the last hour, the
 * last 24 hours or the rig's newest run, a bar for each runner, its time with the judge, each
 * lane, idle and away, as shares and hours; its GPU's mean use where its core read it; and who
 * waited for a runner, and how long.
 */

const WINDOW_WORDS: Record<UseWindow, string> = {
  hour: "the last hour",
  day: "the last 24 hours",
  run: "its newest run",
};

/** A time, short: `42s`, `17m`, `3h 05m`. */
function spanWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Each part of a runner's time, largest lane first: judge, each lane, idle, away. */
function parts(r: RunnerShare): { key: string; words: string; ms: number }[] {
  const lanes = Object.entries(r.lanes_ms)
    .sort((a, b) => b[1] - a[1])
    .map(([lane, ms]) => ({ key: "lane", words: lane.replace("lane-", "lane "), ms }));
  return [
    { key: "judge", words: "the judge", ms: r.judge_ms },
    ...lanes,
    { key: "idle", words: "idle", ms: r.free_ms },
    { key: "away", words: "away", ms: r.away_ms },
  ].filter((p) => p.ms > 0);
}

function gpuLine(r: RunnerShare): string {
  const g = r.gpu;
  if (!g) return "GPU not read";
  const mean =
    g.mean_pct === null
      ? "not read long enough for a mean"
      : `busy ${g.mean_pct}% of the ${spanWords(g.read_ms)} it was read`;
  const now = g.now_pct === null ? "" : `, ${g.now_pct}% at its last read`;
  const mem =
    g.mem_used_mib !== null && g.mem_total_mib !== null
      ? `, ${Math.round(g.mem_used_mib / 1024)} of ${Math.round(g.mem_total_mib / 1024)} GiB`
      : "";
  return `GPU ${mean}${now}${mem}`;
}

function bar(r: RunnerShare): string {
  const all = parts(r);
  const total = all.reduce((n, p) => n + p.ms, 0);
  if (!total) return `<span class="small muted">no time reported in this window</span>`;
  const pct = (ms: number) => Math.round((1000 * ms) / total) / 10;
  const segs = all
    .map(
      (p) =>
        `<i class="${p.key}" style="width:${pct(p.ms)}%" title="${esc(`${p.words}: ${pct(p.ms)}%, ${spanWords(p.ms)}`)}"></i>`,
    )
    .join("");
  const words = all.map((p) => `${p.words} ${pct(p.ms)}% (${spanWords(p.ms)})`).join(" · ");
  return `<div class="usebar" role="img" aria-label="${esc(words)}">${segs}</div><span class="small">${esc(words)}</span>`;
}

/** Who waited for a runner: the judge's jobs, then each lane's runs. */
function waitedWords(v: UseView): string {
  const keys = Object.keys(v.waited).sort((a, b) =>
    a === "judge" ? -1 : b === "judge" ? 1 : a.localeCompare(b),
  );
  const said = keys
    .filter((k) => (v.waited[k]?.count ?? 0) > 0)
    .map((k) => {
      const w = v.waited[k] ?? { count: 0, ms: 0 };
      const who = k === "judge" ? "The judge's jobs" : `${k.replace("lane-", "Lane ")}'s runs`;
      return `${who} waited ${w.count} time${w.count === 1 ? "" : "s"}, ${spanWords(w.ms)} in all`;
    });
  return said.length ? `${said.join("; ")}.` : "Nothing waited for a runner.";
}

/** The block's part for one window, with links to the others. */
export function useBlock(rig: string, v: UseView, runStarted?: string, heading?: string): string {
  const links = (["hour", "day", "run"] as const)
    .filter((w) => w !== "run" || runStarted)
    .map((w) =>
      w === v.window
        ? `<span class="chip info">${esc(WINDOW_WORDS[w])}</span>`
        : `<a class="chip" href="/ui/rigs/${encodeURIComponent(rig)}?use=${w}#runners">${esc(WINDOW_WORDS[w])}</a>`,
    )
    .join(" ");
  const rows = v.runners
    .map(
      (r) =>
        `<tr><td><b>${esc(r.runner)}</b></td><td style="min-width:0">${bar(r)}<br><span class="small muted">${esc(gpuLine(r))}</span></td></tr>`,
    )
    .join("");
  const since =
    v.first && Date.parse(v.first) - Date.parse(v.from) > 120_000
      ? ` Control's samples begin at ${esc(v.first.slice(11, 16))} UTC: the window's time before has none.`
      : "";
  return `<div class="sub-block" id="runners-use"><h3>How they spent ${esc(heading ?? WINDOW_WORDS[v.window])} <span class="right">${links}</span></h3>${
    rows
      ? `<div class="card flat" style="overflow-x:auto"><table class="ut"><tbody>${rows}</tbody></table></div>`
      : `<div class="card small muted">No runner reported its time in this window: a rig core of an older version reports none.</div>`
  }<div class="small muted" style="margin-top:6px">${esc(waitedWords(v))} The GPU is read every 15 seconds, but never while the judge measures on it, so a reading never disturbs a timing.${since}</div></div>`;
}

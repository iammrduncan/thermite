import type { RunView } from "../../views/index.ts";
import { ago, esc } from "../components/index.ts";
import { attemptHref } from "../urls.ts";
import { clip } from "../words/index.ts";
import { figure } from "./held-out.ts";

/**
 * "Where the run started" (goal 115): a hill climb's baseline on its Overview. Each measured case
 * with the starting point's main metric and guards (the median of the baseline's blocks, ± their
 * median absolute deviation as a share of it), what the kit's check kept, and the rig's noise.
 * While the judge measures it, or could not, the block says so instead.
 */
export function baselineBlock(r: RunView, now: number): string {
  if (r.mode !== "hill_climb") return "";
  const head = (right: string) =>
    `<div class="head"><h2>Where the run started</h2><span class="right">${right}</span></div>`;
  const b = r.baseline;
  if (!b) {
    if (r.setup)
      return `<div class="block" data-part="baseline">${head("the run is in setup")}<div class="card"><p>The judge could not measure the starting point, champion #${r.setup.champion_seq} (<code>${esc(r.setup.commit.slice(0, 8))}</code>), ${esc(ago(r.setup.at, now))} ago. Until it can, no change is judged against it: the lanes work to make the project build and run every case, within the editable paths and never the kit. The first change the judge can measure becomes the starting point.</p><div class="fw muted small">${esc(clip(r.setup.reasons, 1500))}</div></div></div>`;
    if (r.baseline_waiting && r.status !== "closed")
      return `<div class="block" data-part="baseline">${head("waiting for the judge")}<div class="card"><p>The judge measures the starting point alone on every case first. No round or trial starts until it has.</p></div></div>`;
    return "";
  }
  const metrics = [
    ...new Set([...(b.primary ? [b.primary.metric] : []), ...b.guards.map((g) => g.metric)]),
  ];
  const others = new Set(b.cells.flatMap((c) => c.metrics.map((m) => m.metric)));
  for (const m of metrics) others.delete(m);
  const label = (m: string) => {
    const g = b.guards.find((x) => x.metric === m);
    return `${esc(m)}${b.units[m] ? ` <span class="muted small">${esc(b.units[m] as string)}</span>` : ""}<div class="muted xs">${
      b.primary?.metric === m
        ? `main, ${b.primary.direction === "min" ? "lower" : "higher"} is better`
        : g
          ? `guard: at most ${(g.max_total_regression * 100).toFixed(1).replace(/\.0$/, "")}% worse in all`
          : ""
    }</div>`;
  };
  const cell = (c: BaselineCell, m: string) => {
    const v = c.metrics.find((x) => x.metric === m);
    if (!v) return `<td class="muted">·</td>`;
    const spread = v.median ? (100 * v.mad) / Math.abs(v.median) : 0;
    return `<td><b class="fig">${esc(figure(v.median))}</b> <span class="muted small">±${spread.toFixed(2)}%</span></td>`;
  };
  const files = b.files.length
    ? ` The kit's check kept ${b.files.length} file${b.files.length === 1 ? "" : "s"} (${esc(sizeWords(b.bytes))}) in the baseline's folder, which later checks read.`
    : "";
  const noise = r.calibration
    ? ` The rig's noise (A/A): ±${(r.calibration.sigma * 100).toFixed(2)}% per block.`
    : "";
  return `<div class="block" data-part="baseline">${head(`measured ${esc(ago(b.at, now))} ago`)}<div class="card flat"><table><thead><tr><th>Case</th>${metrics.map((m) => `<th>${label(m)}</th>`).join("")}</tr></thead><tbody>${b.cells
    .slice(0, 40)
    .map((c) => `<tr><td>${esc(c.cell)}</td>${metrics.map((m) => cell(c, m)).join("")}</tr>`)
    .join(
      "",
    )}</tbody></table><div class="muted small" style="padding:8px 12px">Champion #${b.champion_seq} (<code>${esc(b.commit.slice(0, 8))}</code>)${b.attempt ? `, the setup change <a href="${attemptHref(r, b.attempt)}"><code>${esc(b.attempt)}</code></a>,` : ""} measured alone: the median of ${b.blocks} blocks, each of ${b.runs_per_cell} run${b.runs_per_cell === 1 ? "" : "s"} a case; ± is their median absolute deviation. Each guard's total allowance holds against these values.${noise}${files}${others.size ? ` ${others.size} more metric${others.size === 1 ? "" : "s"} in get_run.` : ""}</div></div></div>`;
}

type BaselineCell = NonNullable<RunView["baseline"]>["cells"][number];

/** A size in plain words: bytes, KiB or MiB. */
function sizeWords(n: number): string {
  return n < 1024
    ? `${n} bytes`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

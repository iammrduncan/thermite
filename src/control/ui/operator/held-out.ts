import { HELD_OUT_OWNER_WORDS, type HeldOutKind } from "../../../core/held-out.ts";
import type { AttemptView, HeldOutView, RunView } from "../../views/index.ts";
import { ago, esc } from "../components/index.ts";

/** A measured value for the owner: four significant figures, or an exponent for a large one. */
export function figure(x: number): string {
  return Math.abs(x) >= 1e5 ? x.toExponential(3) : String(Number(x.toPrecision(4)));
}

/**
 * The newest held-out check of a confirmation, for the owner (goal 082): each held-out case by
 * name, what it was checked for, how it went, and its value against its threshold where the
 * check gives one. The agents get only that a held-out check failed, and how.
 */
export function heldOutBlock(a: AttemptView, now: number): string {
  return a.held_out ? heldOutCard(a.held_out, "Held-out checks", now) : "";
}

/**
 * The newest held-out check of a goal run's champion, for the owner (goal 086): the second
 * validation of a champion that met every required goal runs the held-out cells of the goals it
 * met, and the run closes only if each passes. On the run's page, under its goals.
 */
export function championHeldOutBlock(r: RunView, now: number): string {
  const h = r.champion_held_out;
  return h ? heldOutCard(h, `Held-out checks of champion #${h.champion_seq}`, now) : "";
}

function heldOutCard(h: HeldOutView, title: string, now: number): string {
  const failed = h.cells.filter((c) => !c.ok).length;
  const rows = h.cells
    .map((c) => {
      const kind = c.kind as HeldOutKind | null;
      const result = c.ok
        ? `<span class="chip ok">passed</span>`
        : `<span class="chip bad">${esc(kind && Object.hasOwn(HELD_OUT_OWNER_WORDS, kind) ? HELD_OUT_OWNER_WORDS[kind] : (c.kind ?? "failed"))}</span>`;
      const forWhat = c.goal
        ? `goal <b>${esc(c.goal)}</b>`
        : c.verifier
          ? `verifier <b>${esc(c.verifier)}</b>`
          : "no worse than the champion";
      const unit = c.unit && c.unit !== "ratio" ? ` ${esc(c.unit)}` : "";
      const measured =
        c.value === null
          ? `<span class="muted">·</span>`
          : `${esc(figure(c.value))}${unit}${c.low !== null && c.high !== null ? ` <span class="muted small">[${esc(figure(c.low))}, ${esc(figure(c.high))}]</span>` : ""}${c.measure ? `<div class="muted small">${esc(c.measure)}</div>` : ""}`;
      const threshold =
        c.threshold === null || c.op === null
          ? `<span class="muted">·</span>`
          : `${esc(c.op)} ${esc(figure(c.threshold))}${unit}`;
      return `<tr><td><code>${esc(c.cell)}</code></td><td>${forWhat}</td><td>${result}</td><td>${measured}</td><td>${threshold}</td></tr>`;
    })
    .join("");
  const more =
    h.cells_total > h.cells.length
      ? `<div class="note small">and ${h.cells_total - h.cells.length} more cases: the rig's held_out record keeps them all</div>`
      : "";
  return `<div class="block"><div class="head"><h2>${esc(title)}</h2><span class="n">${h.pass ? "all passed" : `${failed} failed`}</span><span class="right">${esc(ago(h.at, now))} ago · only you see which case: the agents see only that a held-out check failed, and how</span></div><div class="card flat"><table><thead><tr><th>Case</th><th>Checked for</th><th>Result</th><th>Measured</th><th>Threshold</th></tr></thead><tbody>${rows}</tbody></table>${more}</div></div>`;
}

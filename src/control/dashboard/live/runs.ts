import { lastActivity } from "../../ui/campaigns/list.ts";
import { esc, modeName, runCompleted } from "../../ui/components/index.ts";
import { waitingOn } from "../../ui/operator/index.ts";
import { rigHref, runLiveHref } from "../../ui/urls.ts";
import { podStopped, type RigView, type RunView } from "../../views/index.ts";

/** Where Live's every-agent view is (goal 188). */
export const EVERYTHING_HREF = "/ui/live/everything";

/**
 * Live's list of runs, on the left of its pages: Everything first (goal 188), then the runs at
 * work, the idle rigs and the runs that ended in the last day. `sel`: the run shown, or
 * "everything".
 */
export function liveRunsNav(
  vs: readonly RigView[],
  now: number,
  sel: { u: RigView; r: RunView } | "everything" | undefined,
): { nav: string; ended: { u: RigView; r: RunView }[] } {
  const all = vs.flatMap((u) => u.runs.map((r) => ({ u, r })));
  const atWork = all.filter((x) => x.r.status === "running");
  const chosen = sel === "everything" ? undefined : sel;
  const day = now - 24 * 3600_000;
  const ended = all
    .filter((x) => x.r.status !== "running" && Date.parse(lastActivity(x.r)) > day)
    .sort((a, b) => lastActivity(b.r).localeCompare(lastActivity(a.r)));
  const idle = vs.filter((u) => !u.runs.some((r) => r.status === "running"));
  const runLink = (x: { u: RigView; r: RunView }, sub: string, cls = "") =>
    `<a class="lr${chosen && x.u.id === chosen.u.id && x.r.id === chosen.r.id ? " on" : ""}${cls}" href="${runLiveHref(x.r)}"><span class="t">${x.r.status === "running" ? `<span class="dot ok pulse"></span>` : ""}${esc(x.r.id)}</span><span class="s">${sub}</span></a>`;
  const nav = `<nav class="lruns" aria-label="Runs" data-part="lruns">
<a class="lr${sel === "everything" ? " on" : ""}" href="${EVERYTHING_HREF}"><span class="t">Everything</span><span class="s">every agent of every run, on ${vs.length} rig${vs.length === 1 ? "" : "s"}</span></a>
<div class="hd">At work</div>${atWork.map((x) => runLink(x, `${esc(x.u.id)} · ${esc(modeName(x.r.mode))} · ${Object.keys(x.r.at_work).length} working${waitingOn(x.r, x.u) ? ` · <span class="warn">${waitingOn(x.r, x.u)} wait for you</span>` : ""}`)).join("") || `<div class="lempty">No run is at work.</div>`}
${idle.length ? `<div class="hd">Idle rigs</div>${idle.map((u) => `<a class="lr idle" href="${rigHref(u.id)}"><span class="t">${esc(u.id)}</span><span class="s">no run at work${podStopped(u) ? " · its pod is stopped" : u.stale ? " · not reporting" : ""}</span></a>`).join("")}` : ""}
${ended.length ? `<details class="lended"${chosen && chosen.r.status !== "running" ? " open" : ""}><summary class="hd">Ended in the last day (${ended.length})</summary>${ended.map((x) => runLink(x, `${esc(x.u.id)} · ${runCompleted(x.r) ? "completed" : x.r.status === "closed" ? "finished" : esc(x.r.status)}`, " idle")).join("")}</details>` : ""}
</nav>`;
  return { nav, ended };
}

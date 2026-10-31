import type { ControlStore } from "../../store/index.ts";
import { currentChampion, type RigView, type RunView, runCampaign } from "../../views/index.ts";
import { ago, esc, judgeOnlyMark, modeAvatar } from "../components/index.ts";
import type { LaneExtra } from "../rigs/drain.ts";
import { stuckChip, stuckTrials } from "../stuck.ts";
import { runHref, runLiveHref } from "../urls.ts";
import { clip, span } from "../words/index.ts";
import { jobHtml, runProgress } from "./run.ts";

/** What is happening now on a run: each lane, the final writer, the planner and the judge. */

/** A trial's intro line without its "trial on lane-1: " prefix. */
const introText = (s: string) => s.replace(/^(research )?trial on [^:]+: /, "");

/**
 * What a run is doing now, one line each: every lane's focus and for how long, the judge, and the
 * planner when it waits. With `heading`, the run's name, progress and champion lead; with
 * `detail`, each lane also shows its last step and the judge its latest line; `lane` adds to a
 * lane's row and below it (a drain's trial: ui/drain.ts).
 */
export function runBrief(
  store: ControlStore,
  u: RigView,
  r: RunView,
  now: number,
  opts: { heading?: boolean; detail?: boolean; waiting?: number; lane?: LaneExtra } = {},
): string {
  const rows: string[] = [];
  const row = (who: string, what: string, when = "", cls = "") =>
    rows.push(
      `<div class="br ${cls}"><span class="br-who">${esc(who)}</span><span class="br-what">${what}</span><span class="br-when">${when}</span></div>`,
    );
  const trials = store.liveLines.trials(u.id).filter((t) => t.run === r.id);
  const lanes = [
    ...new Set([
      ...Object.keys(r.at_work),
      ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
      ...trials.map((t) => t.lane).filter((l): l is string => !!l),
    ]),
  ].sort();
  // A stuck trial's lane gets a chip that leads to its card under Needs you (goal 143).
  const stuck = stuckTrials(u, r, now);
  for (const lane of lanes) {
    const extra = opts.lane?.(lane);
    const t = trials.find((x) => x.lane === lane);
    const plan = r.epoch?.assignments.find((a) => a.lane === lane);
    const work = r.at_work[lane];
    // The ledger says who is at work; a live session counts only while it is fresh, since a
    // trial cut off by a restart never writes "trial ended" (the harness closes it as
    // interrupted when it starts again).
    const fresh = t && !t.ended && Date.parse(t.last_at) > now - 15 * 60_000;
    if ((work || fresh) && r.status === "running") {
      const what =
        work?.focus ||
        plan?.focus ||
        introText(t?.intro ?? "") ||
        work?.family ||
        plan?.family ||
        "";
      const last =
        opts.detail && t?.last_tool
          ? `<span class="br-more">last: <code>${esc(clip(t.last_tool, 110))}</code> ${esc(ago(t.last_tool_at, now))} ago</span>`
          : "";
      row(
        lane,
        `${esc(clip(what, 200))}${extra?.mark ?? ""}${stuck
          .filter((s) => s.lane === lane)
          .map((s) => stuckChip(s, r, now))
          .join(
            "",
          )}${t ? ` <a class="small" href="${runLiveHref(r, { w: lane })}">watch</a>` : ""}${last}`,
        esc(span(work?.since ?? t?.started_at ?? null, now)),
      );
    } else {
      const done = r.trials.filter((x) => x.lane === lane).at(-1);
      row(
        lane,
        r.status !== "running"
          ? "stopped"
          : plan
            ? `next: ${esc(clip(plan.focus || plan.family, 160))}`
            : `between trials${done ? ` <span class="muted">· the last ${done.attempt ? "submitted a change" : `ended: ${esc(done.stopped.replace(/_/g, " "))}`} ${esc(ago(done.at, now))} ago</span>` : ""}`,
        "",
        "muted",
      );
    }
    if (extra) rows.push(extra.below);
  }
  if (!lanes.length && r.status === "running")
    row(
      "lanes",
      !r.has_agents
        ? "no agents on this run: changes come from people"
        : r.agents.trials
          ? "between trials"
          : "waiting for the first round",
      "",
      "muted",
    );
  // A research run's final writer, while it writes the run's paper (goal 112).
  if (r.status === "running" && r.paper?.state === "writing")
    row(
      "writer",
      `the final writer is writing the paper${r.paper.refused ? ` <span class="muted">· the harness refused its last draft ${esc(ago(r.paper.refused.at, now))} ago</span>` : ""}`,
      esc(span(r.paper.requested_at, now)),
    );
  // The planner, only when it waits for something.
  const planner = store.liveLines
    .tail(u.id, 40, "planner")
    .filter((l) => !l.run || l.run === r.id)
    .at(-1);
  if (
    r.status === "running" &&
    planner &&
    planner.kind === "status" &&
    (!r.epoch || planner.at > r.epoch.at)
  )
    row("planner", `<span class="warn">${esc(planner.text)}</span>`);
  // The judge.
  const mine = (x: { run: string | null }) => x.run === r.id || x.run === null;
  const j = u.judge.now && mine(u.judge.now) ? u.judge.now : null;
  const queued = u.judge.queued.filter(mine).length;
  if (j) {
    const line = opts.detail ? store.liveLines.tail(u.id, 1, "judge")[0] : undefined;
    row(
      "judge",
      `${jobHtml(u, j)}${queued ? ` <span class="muted">· ${queued} more queued</span>` : ""}${line && j.started_at && line.at >= j.started_at && !/: started$/.test(line.text) ? `<span class="br-more">now: ${esc(clip(line.text, 120))}</span>` : ""}`,
      esc(span(j.started_at, now)),
    );
  } else row("judge", `idle${queued ? `, ${queued} queued` : ""}`, "", "muted");
  if (opts.waiting)
    rows.push(
      `<div class="br"><span class="br-who"></span><a class="br-what warn" href="#needs">${opts.waiting} decision${opts.waiting === 1 ? "" : "s"} from this run wait${opts.waiting === 1 ? "s" : ""} for you ↑</a><span class="br-when"></span></div>`,
    );
  const champ = currentChampion(r);
  const head = opts.heading
    ? `<div class="brief-head">${modeAvatar(r.mode)}<a class="brief-name" href="${runHref(r)}">${esc(runCampaign(r))} › ${esc(r.id)}</a>${judgeOnlyMark(r)}<span class="muted small">on ${esc(u.id)}</span><span class="brief-progress">${runProgress(r)}</span><span class="muted small nowrap">champion #${champ?.seq ?? 1}${r.created_at ? ` · started ${esc(ago(r.created_at, now))} ago` : ""}</span></div>`
    : "";
  return `<section class="brief">${head}${rows.join("")}</section>`;
}

import { isRigCheck } from "../../../core/ids.ts";
import {
  type CampaignView,
  type Earlier,
  newestRun,
  type RigView,
  type RunView,
} from "../../views/index.ts";
import {
  ago,
  esc,
  icon,
  judgeOnlyMark,
  modeAvatar,
  modeName,
  runCompleted,
} from "../components/index.ts";
import { runProgress, waitingOn } from "../operator/index.ts";
import { runHref } from "../urls.ts";
import { earlierWords } from "../words/index.ts";
import { infoLabel } from "./new/index.ts";

// The smoke checks control runs on each new rig make campaigns of their own: hidden by default.
export { isRigCheck };

/**
 * What the Campaigns list shows: active and paused (the default), one state, everything, or the
 * archived campaigns (goal 077), which the other filters leave out and All marks.
 */
export type CampaignFilter = "default" | "active" | "paused" | "check" | "all" | "archived";
export const campaignFilter = (q: string | undefined): CampaignFilter =>
  q === "active" || q === "paused" || q === "check" || q === "all" || q === "archived"
    ? q
    : "default";

/**
 * A campaign's state for the list: at work, paused, finished, or a rig check. With no run at
 * work, its newest run decides (goal 099), as in the navigation: a campaign whose newest run
 * completed or finished counts as finished, even with an older run paused.
 */
export function campaignKind(k: CampaignView): "active" | "paused" | "finished" | "check" {
  if (isRigCheck(k.name)) return "check";
  if (k.runs.some((x) => x.run.status === "running")) return "active";
  if (newestRun(k)?.run.status === "paused") return "paused";
  return "finished";
}

const shows = (f: CampaignFilter, kind: ReturnType<typeof campaignKind>, archived: boolean) =>
  f === "all" ||
  (f === "archived"
    ? archived
    : !archived && (f === "default" ? kind === "active" || kind === "paused" : f === kind));

/** The newest thing a run did: its last event, attempt or start. */
export function lastActivity(r: RunView): string {
  return (
    [r.timeline.at(-1)?.at, r.attempts.at(-1)?.updated_at, r.created_at]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .sort()
      .at(-1) ?? ""
  );
}

/** The runs of a campaign counted by state, as coloured dots; completed runs apart (goal 099). */
export function runCounts(k: CampaignView): string {
  const n = (s: string) => k.runs.filter((x) => x.run.status === s).length;
  const completed = k.runs.filter((x) => runCompleted(x.run)).length;
  const closed = k.runs.length - n("running") - n("paused") - completed;
  return `<span class="kdots">${n("running") ? `<span class="kdot run">${n("running")} at work</span>` : ""}${n("paused") ? `<span class="kdot pause">${n("paused")} paused</span>` : ""}${completed ? `<span class="kdot ok">${completed} completed</span>` : ""}${closed ? `<span class="kdot done">${closed} finished</span>` : ""}</span>`;
}

export interface CampaignsListInput {
  camps: CampaignView[];
  /** One card for each run at work (built by the dashboard, with its buttons). */
  atWork: string[];
  /** Runs whose decisions wait for the owner. */
  waiting: { rig: RigView; run: RunView; n: number }[];
  filter: CampaignFilter;
  query: string;
  now: number;
  /** A campaign's best result so far, in words. */
  best: (k: CampaignView) => string;
  /** What a campaign is for, from its contract, when control has it. */
  about: (k: CampaignView) => string;
  /** The archived campaigns (goal 077), each with when and by whom, in words. */
  archived?: ReadonlyMap<string, string> | undefined;
  /** An archived campaign's Unarchive button (a form). */
  unarchive?: ((name: string) => string) | undefined;
}

/**
 * The Campaigns list: what is at work now first, then what waits for the owner, then every
 * campaign as one row, with filters (links, so they work without the script) and a search box.
 */
export function campaignsListBody(o: CampaignsListInput): string {
  const kinds = new Map(o.camps.map((k) => [k.name, campaignKind(k)]));
  const shelf = o.archived ?? new Map<string, string>();
  const count = (f: CampaignFilter) =>
    o.camps.filter((k) => shows(f, kinds.get(k.name) ?? "finished", shelf.has(k.name))).length;
  const q = o.query.trim().toLowerCase();
  const archivedView = o.filter === "archived";
  const rows = o.camps
    .filter((k) => shows(o.filter, kinds.get(k.name) ?? "finished", shelf.has(k.name)))
    .filter(
      (k) =>
        !q ||
        [k.name, o.about(k), ...k.runs.map((x) => `${x.run.id} ${x.rig.id}`)]
          .join(" ")
          .toLowerCase()
          .includes(q),
    )
    .map((k) => {
      const last = k.runs
        .map((x) => lastActivity(x.run))
        .sort()
        .at(-1);
      const rigs = [...new Set(k.runs.map((x) => x.rig.id))];
      const check = isRigCheck(k.name);
      const shelved = shelf.get(k.name);
      const name = `<td><a class="kname" href="/ui/campaigns/${encodeURIComponent(k.name)}">${check ? `<span class="av ck" title="rig check">CK</span>` : modeAvatar(k.mode)}<span><b>${esc(k.name)}</b> <span class="muted small">${check ? "rig check" : esc(modeName(k.mode))}</span>${shelved !== undefined && !archivedView ? ` <span class="chip">archived</span>` : ""}${o.about(k) ? `<span class="kabout">${esc(o.about(k))}</span>` : ""}</span></a></td>`;
      // The Archived view: when and by whom, and Unarchive, in place of the last activity and rigs.
      if (archivedView)
        return `<tr class="click">${name}<td>${k.runs.length ? runCounts(k) : `<span class="muted small">no runs</span>`}</td><td><b class="fig">${esc(o.best(k))}</b></td><td class="muted nowrap">${esc(shelved ?? "")}</td><td class="right">${o.unarchive?.(k.name) ?? ""}</td></tr>`;
      return `<tr class="click">${name}<td>${runCounts(k)}</td><td><b class="fig">${esc(o.best(k))}</b></td><td class="muted nowrap">${last ? `${esc(ago(last, o.now))} ago` : ""}</td><td class="muted small">${esc(rigs.join(", "))}</td></tr>`;
    })
    .join("");
  const chip = (f: CampaignFilter, label: string) =>
    `<a class="fchip${o.filter === f ? " on" : ""}" href="/ui/campaigns${f === "default" ? "" : `?f=${f}`}${q ? `${f === "default" ? "?" : "&"}q=${encodeURIComponent(o.query)}` : ""}">${esc(label)} <span class="n">${count(f)}</span></a>`;
  const checks = count("check");
  const waiting = o.waiting.length
    ? `<div class="block"><div class="head"><h2>Waiting for you</h2><span class="n">${o.waiting.reduce((a, w) => a + w.n, 0)}</span></div>${o.waiting
        .map(
          (w) =>
            `<div class="kneed">${icon.warn}<span class="grow"><b>${esc(w.run.campaign || w.run.id)} › ${esc(w.run.id)}</b> on ${esc(w.rig.id)}: ${w.n} decision${w.n === 1 ? " waits" : "s wait"} for you.</span><a class="btn sm" href="${runHref(w.run)}#needs">Review</a></div>`,
        )
        .join("")}</div>`
    : "";
  return `<div class="block"><div class="head"><h2>At work now</h2><span class="n">${o.atWork.length}</span><span class="right">running runs, and what their lanes and judge are doing</span></div>${
    o.atWork.length
      ? `<div class="kwork">${o.atWork.join("")}</div>`
      : `<div class="card"><div class="empty">No run is at work.</div></div>`
  }</div>
${waiting}
<div class="block"><div class="head"><h2>All campaigns</h2></div>
<div class="ktools">${chip("default", "Active and paused")}${chip("active", "At work")}${chip("paused", "Paused")}${chip("check", "Rig checks")}${chip("all", "All")}${chip("archived", "Archived")}
<form class="ksearch" method="get" action="/ui/campaigns">${o.filter === "default" ? "" : `<input type="hidden" name="f" value="${o.filter}">`}<input name="q" value="${esc(o.query)}" placeholder="Find a campaign, run or rig" aria-label="Find a campaign, run or rig"></form></div>
${
  rows
    ? `<div class="card flat"><table class="ktable"><thead><tr><th>Campaign</th><th>Runs</th><th>Best so far</th>${archivedView ? "<th>Archived</th><th></th>" : "<th>Last activity</th><th>Rigs</th>"}</tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="card"><div class="empty">${q ? "No campaign matches." : archivedView ? "No campaign is archived." : "No campaign here."}</div></div>`
}
${archivedView ? `<div class="muted small" style="margin-top:8px">Out of the navigation, Needs you and the Overview. Their runs, results and kits stay.</div>` : ""}
${o.filter === "default" && checks ? `<div class="muted small" style="margin-top:8px">Rig checks are hidden: they are the smoke runs a rig check starts. <a href="/ui/campaigns?f=check">Show the ${checks} rig check${checks === 1 ? "" : "s"}</a></div>` : ""}</div>`;
}

/** A run at work as a card: what it is doing now (the brief), then its buttons. */
export function workCard(brief: string, buttons: string, waiting: number): string {
  return `<div class="card flat kcard">${brief}<div class="kfoot">${waiting ? `<span class="warn small grow">${icon.warn} ${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you</span>` : `<span class="grow"></span>`}${buttons}</div></div>`;
}

export interface StartRig {
  id: string;
  hardware: string;
  /** Why the run can't go there (other hardware), if it can't. */
  off?: string | undefined;
  /** The run at work there, if any. */
  busy?: string | undefined;
  stale: boolean;
  /** A RunPod pod that is stopped: a run started there starts it first (issue.ts's wake). */
  stopped?: boolean | undefined;
  /** The agents' model the rig has, if any. */
  model?: string | undefined;
  /**
   * What the campaign's Agents' context gives the rig's workers (goal 070): a note on its option,
   * the panel's line when it is chosen (HTML), and whether the run is refused there.
   */
  context?: { note: string; line: string; refused: boolean } | undefined;
}

/** The Start a run panel: where it runs, agents on or off (with a model if the rig has none). */
export function startDrawer(o: {
  campaign: string;
  csrf: string;
  open: boolean;
  rigs: StartRig[];
  models: { group: string; options: { value: string; label: string }[] }[];
  /** Where the run's contract comes from: a saved version, or an earlier run's assignment. */
  from: string;
  /** Runs of the campaign with experiments not tried yet, to copy into the new run's queue. */
  copyFrom?: { key: string; label: string }[] | undefined;
  /** The run to copy from, chosen first (its name): a judge-only run's link here (goal 099). */
  copyPick?: string | undefined;
  /** "From past research" (goal 065): a search of the collections the campaign may read. */
  past?: string | undefined;
}): string {
  // A stopped pod is chosen only by the owner: starting it costs money.
  const first =
    o.rigs.find((r) => !r.off && !r.busy && !r.stopped) ??
    o.rigs.find((r) => !r.off && !r.busy) ??
    o.rigs.find((r) => !r.off);
  const rigOpts = o.rigs
    .map(
      (r) =>
        `<label class="sopt${r.off ? " dis" : ""}"><input type="radio" name="rig" value="${esc(r.id)}" data-model="${esc(r.model ?? "")}"${r.context?.refused ? " data-cc-refused" : ""}${r.id === first?.id ? " checked" : ""}${r.off ? " disabled" : ""}><span><b>${esc(r.id)}</b> <span class="muted small">${esc(r.hardware)}</span><span class="sd">${r.off ? esc(r.off) : r.busy ? `Busy: ${esc(r.busy)} is at work there, and pauses when this run starts (a rig runs one run at a time).` : r.stopped ? "Its pod is stopped: this run starts it first." : r.stale ? "Not reporting now." : "Free: no run at work."}${r.off ? "" : r.model ? ` Agents' model: ${esc(r.model)}.` : ` <span class="warn">No model for its agents yet.</span>`}${!r.off && r.context ? ` <span class="cc-rignote${r.context.refused ? " bad" : ""}">${esc(r.context.note)}</span>` : ""}</span></span><span class="sr">${r.off ? "" : r.busy ? `<span class="warn">busy</span>` : r.stopped ? `<span class="muted">stopped</span>` : `<span class="ok">free</span>`}</span></label>`,
    )
    .join("");
  const models = o.models
    .map(
      (g) =>
        `<optgroup label="${esc(g.group)}">${g.options.map((m) => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join("")}</optgroup>`,
    )
    .join("");
  return `<div class="drawer-wrap" id="start"${o.open ? "" : " hidden"}><a class="drawer-bg" href="/ui/campaigns/${encodeURIComponent(o.campaign)}" data-close aria-label="Close"></a>
<aside class="drawer" aria-label="Start a run"><form method="post" action="/ui/campaigns/${encodeURIComponent(o.campaign)}/runs" class="drawer-form" data-start>
<header><h3>Start a run of ${esc(o.campaign)}</h3><span class="grow"></span><a class="btn sm ghost" href="/ui/campaigns/${encodeURIComponent(o.campaign)}" data-close>Close</a></header>
<div class="drawer-body"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
<div class="sfd">${infoLabel("Where it runs", "The rig whose judge measures this run and whose agents work on it. A free rig has no run at work; on a busy one, the run at work pauses when this one starts, since a rig runs one run at a time. Rigs with other hardware than the campaign's kit can't take it.")}<div class="sopts">${rigOpts || `<div class="muted">No rig yet.</div>`}</div></div>
<div class="sfd">${infoLabel("Agents", "On: the agents propose changes and the judge measures each one. Off: no agents; only the judge works, and it measures the starting point (a try), which checks a kit or a rig.")}<div class="sopts">
<label class="sopt"><input type="radio" name="agents" value="on" checked><span><b>On</b><span class="sd" data-model-line>The rig's agents and model.</span></span><span></span></label>
<label class="sopt"><input type="radio" name="agents" value="off"><span><b>Off: a try</b><span class="sd">Only the judge works: it measures the starting point. No changes.</span></span><span></span></label></div>
<label class="sfd smodel" data-model-pick>${infoLabel("The agents' model", "For a rig with no model for its agents: the model to give it, as on its Edit rig page. Control gives it to the rig, which takes it within a minute; then start the run again here.")}<select name="agents_model"><option value="">the rig's model</option>${models}</select></label></div>
${
  o.rigs.some((r) => !r.off && r.context)
    ? `<div class="sfd" data-agents-only data-cc-start>${infoLabel("Agents' context", "What the workers get on the rig you chose: their context window, and where their conversation is compacted. Bold: this campaign's; plain: the rig's. The planner and the advisors get the same, or less when the rig gives them less. Control refuses the run when a model of the rig's agents takes less than this campaign's window.")}${o.rigs
        .filter((r) => !r.off && r.context)
        .map(
          (r) =>
            `<div class="small cc-line" data-cc-line="${esc(r.id)}"${r.id === first?.id ? "" : " hidden"}>${r.context?.line ?? ""}</div>`,
        )
        .join("")}</div>`
    : ""
}
${
  o.copyFrom?.length
    ? `<div class="sfd" data-agents-only>${infoLabel("Experiments to start with", "Each run has its own queue. Copy the experiments another run of this campaign had not tried yet, so the new run starts from them; who added each one and why come along. Leave it off for an empty queue the planner fills.")}<label class="sopt"><input type="checkbox" name="copy_queue" value="1" checked><span><b>Copy the untried experiments of</b> <select name="copy_from" aria-label="From which run" style="width:auto;height:28px;display:inline-block;margin-left:4px">${o.copyFrom.map((x) => `<option value="${esc(x.key)}"${x.key === o.copyPick ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select><span class="sd">They join the new run's queue in the same order, up to 500. The tried ones stay with their run.</span></span><span></span></label></div>`
    : ""
}${o.past ?? ""}
<details class="adv"><summary>More options</summary><div class="sgrid">
<label class="sfd">${infoLabel("When a change is confirmed better", "Keep it at once as the new best (the default), or wait for you every time. The rig's default is set on its Edit rig page.")}<select name="promotion"><option value="">the rig's default</option><option value="auto">always keep it</option><option value="owner_approval">ask me every time</option></select></label>
<div class="sfd">${infoLabel("Ask me first about", "Thermite is hands-off by default: when the judge confirms a change is better, it becomes the champion with no step of yours (after the auditor clears it, when the rig has an auditor and the campaign calls for an audit). A review panel's pass is accepted, and a goal campaign the evidence shows is not possible ends. Choose here what you want to decide yourself; it then waits for you in Needs you.")}<span class="act" style="display:grid;gap:4px"><input name="ask_above_gain" inputmode="decimal" placeholder="a gain above this %, such as 15 (empty: never)" aria-label="Ask me about a gain above this percent"><label class="small" title="A change whose agent declared flaws in it waits for you."><input type="checkbox" name="ask_declared_flaws" value="1"> a change whose agent declared flaws</label><label class="small" title="A review goal is met, and a research run writes its paper and ends, only after you accept the review panel's pass."><input type="checkbox" name="ask_reviews" value="1"> a review panel's pass of a goal or of a research run's questions</label><label class="small" title="A goal campaign the evidence shows is not possible ends only after you accept."><input type="checkbox" name="ask_not_possible" value="1"> ending a goal campaign as not possible</label></span></div>
<label class="sfd">${infoLabel("GPUs for the judge", "For a rig with several GPUs: how many the judge measures on; the rest are the agents'. It changes the rig's split for every run on it, and the rig's harness restarts to apply it. Empty: the rig's current split.")}<input name="judge_gpus" inputmode="numeric" placeholder="the rig's current split"></label>
</div></details>
<div class="muted small">${o.from}</div>
</div>
<footer><span class="grow small muted" data-start-sum></span><button class="primary">Start the run</button></footer>
</form></aside></div>`;
}

/** A campaign's earlier runs (paused, completed and finished), newest first, in one table. */
export function earlierRuns(
  /**
   * `result`: more for the result cell (cross-verification); `action`: the row's button;
   * `earlier`: a run of a retired rig or from before its rig's full reset (goal 170), marked so.
   */
  rows: {
    rig: RigView;
    run: RunView;
    earlier?: Earlier | null | undefined;
    result: string;
    action: string;
  }[],
  now: number,
): string {
  if (!rows.length) return "";
  const row = (x: (typeof rows)[number]) => {
    // An earlier run that was not closed was left as it stood: it runs no more.
    const st =
      x.earlier && x.run.status !== "closed"
        ? `<span class="kst done">Stopped</span>`
        : x.run.status === "paused"
          ? `<span class="kst pause">Paused</span>`
          : x.run.status === "closed"
            ? runCompleted(x.run)
              ? `<span class="kst ok">Completed</span>`
              : `<span class="kst done">Finished</span>`
            : `<span class="kst done">${esc(x.run.status)}</span>`;
    const last = lastActivity(x.run);
    const n = waitingOn(x.run, x.rig);
    return `<tr><td>${st}</td><td><a href="${runHref(x.run)}"><b>${esc(x.run.id)}</b></a>${judgeOnlyMark(x.run)}${n ? ` <span class="warn small">${n} wait${n === 1 ? "s" : ""} for you</span>` : ""}</td><td class="muted">${esc(x.earlier ? earlierWords(x.rig.id, x.earlier) : x.rig.id)}</td><td>${runProgress(x.run)}${x.result}</td><td class="muted small">${esc(x.run.pause_reason ?? "")}</td><td class="muted nowrap">${last ? `${esc(ago(last, now))} ago` : ""}</td><td class="right">${x.action}</td></tr>`;
  };
  const head = `<thead><tr><th style="width:90px">State</th><th>Run</th><th>Rig</th><th>Result</th><th>Why it stopped</th><th>Last activity</th><th></th></tr></thead>`;
  const shown = rows.slice(0, 8).map(row).join("");
  const rest = rows.slice(8);
  return `<div class="card flat"><table class="ktable">${head}<tbody>${shown}</tbody></table>${
    rest.length
      ? `<details class="kmore"><summary>Show ${rest.length} more</summary><table class="ktable">${head}<tbody>${rest.map(row).join("")}</tbody></table></details>`
      : ""
  }</div>`;
}

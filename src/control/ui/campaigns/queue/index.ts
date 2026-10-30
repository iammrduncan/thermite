import { directionList, directionParts, RESEARCH_TASK_KINDS } from "../../../../core/directions.ts";
import { labelledQuestion } from "../../../../core/research-check.ts";
import {
  type AttemptView,
  type DirectionView,
  type ExperimentView,
  type RigView,
  type RunView,
  runCampaign,
} from "../../../views/index.ts";
import { ago, esc, icon } from "../../components/index.ts";
import { outcome } from "../../operator/index.ts";
import { campaignHref, runMessageHref } from "../../urls.ts";
import { clip } from "../../words/index.ts";
import { infoLabel } from "../new/index.ts";
import { questionChip, yieldWords } from "../research.ts";

export { PLANNER_JS } from "./client.ts";

/**
 * The run page's Experiments and Planner tabs (goal 064): the experiment queue in order, what
 * each lane is on, the lanes' ideas, everything tried with its result; the rules for the plan,
 * the owner's messages to the planner with its answers, the run's directions (goal 066), and
 * what the planner did at each hand-out. Changes go to the rig as signed owner commands through
 * the dashboard's command form (`cmd`) and its message route.
 */

/** A hidden-field form that posts one owner command; `extra` adds visible fields. */
export type CmdForm = (f: {
  rig: string;
  kind: string;
  fields?: Record<string, string>;
  label: string;
  cls?: string;
  back?: string;
  extra?: string;
}) => string;

/** A research task whose title already names its question ("Question 2 (index 1): …"), or none. */
const namesQuestion = (x: ExperimentView) =>
  x.question === null || labelledQuestion(x.title) === x.question;

/** Who added an experiment or set a rule, as a short label and a tone. */
export function byLabel(by: string): { text: string; cls: string } {
  if (by === "owner" || by.startsWith("control:owner") || by === "you")
    return { text: "you", cls: "you" };
  if (by === "planner" || by.startsWith("planner")) return { text: "planner", cls: "planner" };
  if (/^lane-\d+$/.test(by)) return { text: `${by}'s idea`, cls: "lane" };
  if (/teacher|merged|supervisor/.test(by)) return { text: "teachers", cls: "teacher" };
  if (/auditor/.test(by)) return { text: "auditor", cls: "auditor" };
  if (/panel|review/.test(by)) return { text: "review panel", cls: "auditor" };
  if (by.startsWith("control:")) return { text: by.replace(/^control:/, ""), cls: "you" };
  return { text: by, cls: "auditor" };
}
const src = (by: string) => {
  const b = byLabel(by);
  return `<span class="qsrc ${b.cls}">${esc(b.text)}</span>`;
};

/** An experiment's result in the Tried table: its class for the filters, and its words. */
export function triedResult(
  r: RunView,
  x: ExperimentView,
): {
  cls: "win" | "wait" | "loss" | "broken" | "flat" | "done" | "none";
  text: string;
  /** Drawn muted: a research trial that added nothing. */
  quiet?: boolean;
} {
  if (x.state === "dropped")
    return {
      cls: "none",
      text: `dropped by ${byLabel(x.dropped_by ?? "").text}${x.dropped_why ? `: ${x.dropped_why}` : ""}`,
    };
  const a: AttemptView | undefined = x.attempt
    ? r.attempts.find((y) => y.id === x.attempt)
    : undefined;
  // A research trial ends without an attempt: its sources, claims and findings are its result,
  // and its yield says what it added (goal 117).
  if (!a && x.result === "finished")
    return {
      cls: "done",
      text: x.yield
        ? `finished: ${yieldWords(x.yield, x.question)}`
        : "finished: its research is in the run's notes",
      // A trial that added no verified claim is not shown as a gain.
      ...(x.yield && !x.yield.verified_claims && !x.yield.findings ? { quiet: true } : {}),
    };
  if (!a)
    return {
      cls: "none",
      text: x.attempt
        ? `${x.attempt}: not judged yet`
        : x.result && x.result !== "no_attempt" && x.result !== "submitted"
          ? `no attempt: ${x.result.replace(/_/g, " ")}`
          : "no attempt",
    };
  const o = outcome(r, a);
  const waits = r.pending_promotions.includes(a.id);
  // The filters by the outcome's own word: a win; one waiting for you; not better than the
  // champion ("Lost"); broken or blocked; anything else (unclear, declined, a duplicate, judging).
  return {
    cls:
      waits || o.word === "Needs you"
        ? "wait"
        : o.tone === "ok"
          ? "win"
          : o.word === "Lost"
            ? "loss"
            : o.tone === "bad"
              ? "broken"
              : "flat",
    text: `${a.id}: ${o.word}${waits ? ", waits for you" : ""}`,
  };
}

/**
 * A judge-only run's line over its queue (goal 099): no worker takes its experiments, and how to
 * carry them to a run with workers. Empty for a run with workers, or with nothing waiting.
 */
export function judgeOnlyQueueLine(r: RunView): string {
  if (r.has_agents !== false) return "";
  if (!r.queue.some((x) => x.state === "queued" || x.state === "proposed")) return "";
  const start = `${campaignHref(runCampaign(r))}?start=1&copy=${encodeURIComponent(r.id)}`;
  return `<div class="lnotice qjudge">${icon.warn}<span><b>Judge only:</b> no worker takes these experiments, so they wait for a run with workers. To carry them over, <a href="${esc(start)}">Start a run</a> of the campaign with <b>Copy the untried experiments of</b> ${esc(r.id)} ticked.</span></div>`;
}

/** The Experiments tab, called Tasks on a research run's page. */
export function experimentsTab(o: {
  u: RigView;
  r: RunView;
  now: number;
  csrf: string;
  back: string;
  cmd: CmdForm;
  /** Directions the run has used, to suggest when adding. */
  families: string[];
}): string {
  const { u, r } = o;
  // A research run's queue holds research tasks, each a question, a gap and a kind of task: "task"
  // there, and "experiment" for a hill climb's or goal run's.
  const research = r.mode === "research";
  const thing = research ? "task" : "experiment";
  const kindWord = research ? "Kind of task" : "Direction";
  const up = r.queue
    .filter((x) => x.state === "queued")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const ideas = r.queue.filter((x) => x.state === "proposed");
  const doing = r.queue.filter((x) => x.state === "assigned");
  const tried = r.queue
    .filter((x) => x.state === "done" || x.state === "dropped")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const fields = (x: ExperimentView, extra: Record<string, string> = {}) => ({
    run: r.id,
    id: x.id,
    ...extra,
  });
  const item = (x: ExperimentView, i: number) =>
    `<div class="qi" draggable="true" data-id="${esc(x.id)}" data-rig="${esc(u.id)}" data-run="${esc(r.id)}"><span class="qh" title="Drag to reorder">⋮⋮</span><span class="qn">${i + 1}</span><div class="qmain"><div class="qt">${esc(x.title)}</div>${x.why ? `<div class="qwhy">${esc(x.why)}</div>` : ""}${x.returns ? `<div class="muted xs">Came back ${x.returns === 1 ? "once" : `${x.returns} times`}: its trial never really tried it${x.cause ? ` (${esc(clip(x.cause, 200))})` : ""}.</div>` : ""}<div class="qmeta">${src(x.by)}${questionChip(r, x.question)}${x.family ? `<span class="qdir">${esc(x.family)}</span>` : ""}${x.from_run ? `<span class="muted xs">from ${esc(x.from_run)}</span>` : ""}</div></div><div class="qacts">${i > 0 ? o.cmd({ rig: u.id, kind: "queue_move", fields: fields(x, { position: "top" }), label: "↑ Top", cls: "sm ghost", back: o.back }) : ""}<details class="menu"><summary class="btn sm ghost">Edit</summary><div class="menu-pop qedit">${o.cmd({ rig: u.id, kind: "queue_edit", fields: fields(x), label: "Save", cls: "sm", back: o.back, extra: editFields(x) })}</div></details><details class="menu"><summary class="btn sm ghost">Drop</summary><div class="menu-pop">${o.cmd({ rig: u.id, kind: "queue_drop", fields: fields(x), label: "Drop it", cls: "sm danger", back: o.back, extra: `<input name="why" required placeholder="why" aria-label="Why" style="width:100%;margin-bottom:6px">` })}</div></details></div></div>`;
  // An experiment's words, to change before a lane takes it.
  const editFields = (x: ExperimentView) =>
    `<label class="sfd">${infoLabel(research ? "Task" : "What to try", `The ${thing}'s title: what a lane works on.`)}<input name="title" required maxlength="200" value="${esc(x.title)}"></label><label class="sfd">${infoLabel("Details", "More on how to try it, for the lane that takes it. Empty: none.")}<textarea name="details" rows="3" maxlength="4000">${esc(x.details ?? "")}</textarea></label><label class="sfd">${infoLabel(kindWord, research ? "Explore, primary, contradict or consolidate. Rules apply by kind of task." : "The approach it belongs to. Rules apply by direction.")}<input name="family" maxlength="80" value="${esc(x.family)}"></label><label class="sfd">${infoLabel("Why", "Why it is worth trying. Empty: none.")}<input name="why" maxlength="2000" value="${esc(x.why ?? "")}"></label>`;
  const add = `<form class="qadd" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="kind" value="queue_add"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel(research ? "Add a task" : "Add an experiment", `Something for a lane to ${research ? "research" : "try"}. It joins the queue where you put it; the planner gives it to a free lane when it reaches the top, and keeps two lanes off the same thing.`)}<input name="title" required maxlength="200" placeholder="${research ? "for example: Question 2 (index 1): find the vendor's documentation of the warp scheduler" : "for example: unroll the dequantize loop by 4"}"></label>
<label class="sfd">${infoLabel(kindWord, research ? "Explore, primary, contradict or consolidate. Rules apply by kind of task." : "The approach it belongs to, in your words or one this run has used. The planner keeps similar work on the same lane, and rules apply by direction.")}<input name="family" maxlength="80" list="qfams" placeholder="optional"><datalist id="qfams">${o.families.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
<label class="sfd">${infoLabel("Where", "Its place in the queue. You can drag it later.")}<select name="position"><option value="top">at the top</option><option value="end">at the end</option></select></label>
<button class="primary">Add</button>
<label class="sfd qwhy-f">${infoLabel("Why", `Shown with the ${thing} to the planner and to the lane that gets it.`)}<input name="why" maxlength="2000" placeholder="optional"></label>
<label class="sfd qwhy-f">${infoLabel("Details", "More on how to try it, for the lane that takes it.")}<textarea name="details" rows="2" maxlength="4000" placeholder="optional"></textarea></label></form>`;
  const working = Object.entries(r.at_work)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([lane, w]) => {
      const x = doing.find((d) => d.trial === w.trial || d.lane === lane);
      return `<div class="qlane"><div class="qlt"><span class="dot ok"></span><b>${esc(lane)}</b> · since ${esc(ago(w.since, o.now))} ago</div><div>${esc(x?.title ?? w.focus ?? w.family ?? "working")}</div>${x ? `<div class="muted xs">${src(x.by)}${questionChip(r, x.question)}</div>` : ""}</div>`;
    })
    .join("");
  const ideaRows = ideas
    .map(
      (x) =>
        `<div class="qidea"><div>${esc(x.title)}</div>${x.why ? `<div class="muted xs">${esc(clip(x.why, 200))}</div>` : ""}<div class="muted xs">${src(x.by)} · ${esc(ago(x.at, o.now))} ago</div><div class="qb">${o.cmd({ rig: u.id, kind: "queue_accept", fields: fields(x), label: "Queue it", cls: "sm", back: o.back })}${o.cmd({ rig: u.id, kind: "queue_drop", fields: fields(x, { why: "the owner dropped this idea" }), label: "Drop", cls: "sm ghost", back: o.back })}</div></div>`,
    )
    .join("");
  const counts = { win: 0, wait: 0, loss: 0, broken: 0, flat: 0, done: 0, none: 0 };
  const triedRows = tried
    .map((x) => {
      const res = triedResult(r, x);
      counts[res.cls]++;
      return `<tr data-r="${res.cls}" data-d="${esc(x.family)}" data-b="${esc(byLabel(x.by).text)}"><td><b>${esc(x.title)}</b>${namesQuestion(x) ? "" : ` ${questionChip(r, x.question)}`}${x.why ? `<div class="muted xs">${esc(clip(x.why, 160))}</div>` : ""}${x.cause && x.state === "done" ? `<div class="muted xs">How its trial ended: ${esc(clip(x.cause, 200))}</div>` : ""}</td><td class="qdir">${esc(x.family)}</td><td>${src(x.by)}</td><td class="muted small">${esc([x.lane, x.trial ? `trial ${x.trial.slice(0, 10)}` : ""].filter(Boolean).join(" · ") || "·")}</td><td><span class="qres ${res.cls}${res.quiet ? " flat" : ""}">${esc(res.text)}</span></td><td class="muted small nowrap">${esc(ago(x.updated_at, o.now))} ago</td></tr>`;
    })
    .join("");
  const chip = (key: string, label: string, n: number) =>
    `<button type="button" class="fchip${key === "all" ? " on" : ""}" data-qf="${key}">${esc(label)} <span class="n">${n}</span></button>`;
  // The other two filters: the directions tried, and who added them (as Added by says).
  const pick = (attr: string, label: string, all: string, values: string[]) =>
    `<select class="qsel" ${attr} aria-label="${esc(label)}"><option value="">${esc(all)}</option>${[
      ...new Set(values.filter(Boolean)),
    ]
      .sort((a, b) => a.localeCompare(b))
      .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
      .join("")}</select>`;
  const picks = `${pick(
    "data-qd",
    kindWord,
    research ? "Every kind of task" : "Every direction",
    tried.map((x) => x.family),
  )}${pick(
    "data-qb",
    "Added by",
    "Anyone added it",
    tried.map((x) => byLabel(x.by).text),
  )}`;
  return `<div class="qcols"><div>
<div class="head"><h2>Up next</h2><span class="n">${up.length}</span><span class="right">in order; the planner gives the top ones to free lanes, never the same one to two lanes</span></div>
${judgeOnlyQueueLine(r)}${add}
<div class="qlist" id="qlist" data-part="qlist">${up.map(item).join("") || `<div class="card"><div class="empty">Nothing queued. The planner adds ${thing}s as it plans; you can add one above.</div></div>`}</div>
</div><div class="qside" data-part="qside">
<div class="card qcard"><h3>In progress</h3>${working || `<div class="muted small">No lane is at work.</div>`}</div>
<div class="card qcard"><h3>Ideas from the lanes <span class="muted small">wait for the planner or you</span></h3>${ideaRows || `<div class="muted small">None waiting. Lanes propose ideas while they work.</div>`}${ideaRows ? `<div class="muted xs">The planner's model queues or drops these at its next hand-out, and you can decide first. When up next holds fewer than the campaign's Ideas kept ready, the planner queues the distinct ones, oldest first, even without its model, in a hill climb or a goal run.</div>` : ""}</div>
</div></div>
<div class="block" style="margin-top:26px" id="tried"><div class="head"><h2>Tried</h2><span class="n">${tried.length}</span><span class="right">every ${thing} that ended, with its result, newest first</span></div>
${
  tried.length
    ? `<div class="ktools" id="qf">${chip("all", "All", tried.length)}${chip("win wait", "Wins", counts.win + counts.wait)}${chip("loss", "Not better", counts.loss)}${chip("broken", "Broken or blocked", counts.broken)}${chip("flat", "Other results", counts.flat)}${counts.done ? chip("done", "Research finished", counts.done) : ""}${chip("none", "No attempt or dropped", counts.none)}${picks}</div>
<div class="card flat"><table class="ktable"><thead><tr><th>${research ? "Task" : "Experiment"}</th><th>${kindWord}</th><th>Added by</th><th>Where</th><th>Result</th><th>When</th></tr></thead><tbody id="qtried">${triedRows}</tbody></table></div>`
    : `<div class="card"><div class="empty">Nothing tried yet.</div></div>`
}</div>`;
}

/** A direction as the Planner tab shows it, :name:; dashed while the planner has yet to design it. */
const tok = (name: string, fresh = false) =>
  `<span class="dtok${fresh ? " new" : ""}"><i>:</i>${esc(name)}<i>:</i></span>`;

/** Text such as the owner's message, escaped, with each :name: in it shown as a direction. */
function withTokens(text: string, dirs: readonly DirectionView[]): string {
  return directionParts(text)
    .map((p) =>
      p.name
        ? tok(p.name, dirs.find((d) => d.name === p.name)?.to_design ?? true)
        : // A :name: too long to be one: the planner read it as plain words; its title says why.
          p.bad
          ? `<span class="dtok bad" title="${esc(p.bad)}">${esc(p.text)}</span>`
          : esc(p.text),
    )
    .join("");
}

/** A rule's kind as the tab shows it: its chip and its verb. */
function kindOf(kind: string): { chip: string; verb: string } {
  if (kind === "mandate") return { chip: "always", verb: "Always" };
  if (kind === "avoid") return { chip: "avoid", verb: "Avoid" };
  if (kind === "try") return { chip: "try", verb: "Try" };
  if (kind === "lane_count") return { chip: "lanes", verb: "Lanes" };
  if (kind === "trial_minutes") return { chip: "trial", verb: "Trials last" };
  if (kind === "keep_working") return { chip: "lanes", verb: "Keep working while judged" };
  return { chip: kind, verb: kind };
}

/** A direction's figures in words: tried, wins, up next, the lanes on it now. */
function directionFigures(d: DirectionView): string {
  if (d.to_design)
    return `new: the planner designs it at its next round${d.queued ? ` · ${d.queued} up next` : ""}`;
  return [
    d.tried ? `${d.tried} tried` : "not tried yet",
    d.wins ? `${d.wins} win${d.wins === 1 ? "" : "s"}` : "",
    d.queued ? `${d.queued} up next` : "",
    d.lanes.length ? `${d.lanes.join(", ")} on it now` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a rule in force does now, from its direction's figures: one or two short sentences. */
function ruleEffect(kind: string, d: DirectionView | undefined): string {
  const queued = d?.queued ?? 0;
  const lanes = d?.lanes ?? [];
  const on = lanes.length
    ? ` ${lanes.join(" and ")} ${lanes.length === 1 ? "works" : "work"} on it now.`
    : "";
  if (kind === "avoid")
    return `No lane gets it.${queued ? ` ${queued} up next in it ${queued === 1 ? "is" : "are"} skipped.` : ""}${on ? `${on} ${lanes.length === 1 ? "It finishes its trial" : "They finish their trials"} first.` : ""}`;
  if (kind === "try")
    return `Its experiments go first when a lane is free. ${queued ? `${queued} ${queued === 1 ? "is" : "are"} up next.` : "None is up next."}`;
  if (kind === "mandate") return `One lane works on it at every hand-out.${on}`;
  return "";
}

/** The run's directions busiest first, the ones the planner has yet to design last. */
const byUse = (dirs: readonly DirectionView[]) =>
  [...dirs].sort(
    (a, b) =>
      Number(a.to_design) - Number(b.to_design) ||
      b.tried + b.queued + b.lanes.length - (a.tried + a.queued + a.lanes.length) ||
      a.name.localeCompare(b.name),
  );

/**
 * The Planner tab (goal 066): the rules in force, whoever set them, with Remove; Tell the planner,
 * where rules come from, with the `:` picker of the run's directions and the planner's answers;
 * what the planner did; the run's directions and the planner's model.
 */
export function plannerTab(o: {
  u: RigView;
  r: RunView;
  now: number;
  csrf: string;
  back: string;
  cmd: CmdForm;
  /** The planner's model, in words, or why there is none. */
  model: string;
  /** The run's agent figures (kpis). */
  figures: string;
  /** The champion to another rig, when that is possible. */
  propagate: string;
  /** Why the owner's last message to the planner was not sent or not taken, if so. */
  refused?: string | undefined;
  /** True when the rig is known to have no model for the planner now. */
  noModel?: boolean | undefined;
}): string {
  const { u, r } = o;
  const research = r.mode === "research";
  // Someone reads Tell the planner: a run with its planner on (a research run's too, goal 117).
  const tell = u.settings?.planner !== false;
  const dirs = byUse(r.directions);
  const dirOf = (name: string) => r.directions.find((d) => d.name === name);
  const nextRound = Math.max(r.agents.epochs, ...r.handouts.map((h) => h.round ?? 0)) + 1;
  // An old rule in words converts at the planner's next round with its model (goal 066): what
  // it waits for, in words.
  const converts = research
    ? "Code can't keep it, and a research run's planner converts no rule in words. Remove it. To steer the run, send a rule for a task kind, or tell the planner."
    : !tell
      ? "Code can't keep it. It converts at the planner's next round, and the planner is off on this rig. Switch the planner on in Edit rig, or remove it."
      : o.noModel
        ? "Code can't keep it. It converts at the planner's next round with a model, and this rig has no model for the planner now. Give the planner a model in Edit rig, or remove it."
        : `It converts at the planner's next round: round ${nextRound}. The planner names its direction, and code keeps the new rule. Until then, only the planner's model reads it.`;
  const ruleRow = (x: RunView["rules"][number]) => {
    const kind = String(x.body.kind ?? "");
    const k = kindOf(kind);
    // A direction shows as :name: (goal 066); an old rule in words, in quotes.
    const family = typeof x.body.family === "string" ? x.body.family : "";
    const d = family ? dirOf(family) : undefined;
    const what = family
      ? tok(family, d?.to_design ?? false)
      : x.legacy
        ? esc(`“${String(x.body.match ?? "")}”`)
        : esc(String(x.body.value ?? ""));
    const said =
      kind === "lane_count"
        ? `${what} lanes`
        : kind === "trial_minutes"
          ? `Trials last ${what} minutes`
          : kind === "keep_working"
            ? `Lanes keep working while the judge works: ${what}`
            : kind === "note"
              ? what
              : `${esc(k.verb)} ${what}`;
    const fromMsg =
      typeof x.body.from_message === "number"
        ? r.messages.find((m) => m.id === x.body.from_message)
        : undefined;
    // A rule the planner converted from an old rule in words: the words it replaced.
    const was = (x.body.converted_from ?? undefined) as { words?: unknown } | undefined;
    const effect = family && !d?.to_design ? ruleEffect(kind, d) : "";
    const note = x.legacy
      ? `<div class="xs warn" style="margin-top:3px">${icon.warn} An old rule in words, from before rules named directions. ${esc(converts)}</div>`
      : d?.to_design
        ? `<div class="xs" style="margin-top:3px">A new direction. The planner designs it at its next round, then adds it to the run's directions.</div>`
        : effect
          ? `<div class="xs ok" style="margin-top:3px">${icon.check} Code keeps it at every hand-out. ${esc(effect)}</div>`
          : "";
    const remove = o.cmd({
      rig: u.id,
      kind: "drop_directive",
      fields: { run: r.id, id: String(x.id) },
      label: "Remove",
      cls: "sm ghost",
      back: o.back,
    });
    return `<div class="qrule${x.legacy ? " legacy" : ""}"><span class="qkind ${esc(x.legacy ? "words" : k.chip)}">${esc(x.legacy ? "words" : k.chip)}</span><div><b>${said}</b> <span class="muted small">· set by</span> ${src(x.author)} <span class="muted xs">${esc(ago(x.at, o.now))} ago</span><div class="muted small">${esc(String(x.body.rationale ?? ""))}${fromMsg ? ` <span class="muted">(from your message: “${esc(clip(fromMsg.text, 120))}”)</span>` : ""}</div>${was ? `<div class="muted xs">converted from: “${esc(String(was.words ?? ""))}”</div>` : ""}${note}</div>${remove}</div>`;
  };
  const entry = (at: string, html: string) =>
    `<div class="qhand"><span class="tm">${esc(at.slice(11, 16))}</span><div>${html}</div></div>`;
  const handed = r.handouts.map((h) => ({
    at: h.at,
    html: `${h.round !== null ? `<b>Round ${h.round}</b>: ` : ""}${h.assignments.length ? `<ul>${h.assignments.map((a) => `<li><b>${esc(a.lane)}</b>: ${esc(r.queue.find((x) => x.id === a.experiment)?.title ?? a.experiment ?? "")}${a.why ? ` <span class="muted">· ${esc(a.why)}</span>` : ""}</li>`).join("")}</ul>` : ""}${h.notes ? `<div class="muted small">${esc(clip(h.notes, 400))}</div>` : ""}`,
  }));
  // The planner's own changes to the queue and the rules it set, each with its reason. A copy
  // back in the queue after its trial stopped is not a change of the planner's: History has it,
  // as it has an event control can't read.
  const changed = (r.timeline ?? [])
    .filter(
      (e) =>
        (e.actor === "planner" || (e.kind === "family_added" && e.actor.startsWith("planner:"))) &&
        !e.body.requeued_from &&
        e.unreadable === undefined,
    )
    .map((e) => {
      const b = e.body;
      const x = r.queue.find((y) => y.id === String(b.id));
      const t = `“${esc(clip(x?.title ?? String(b.title ?? b.id ?? ""), 160))}”`;
      const why = (w: unknown) =>
        typeof w === "string" && w ? ` <span class="muted">· ${esc(clip(w, 300))}</span>` : "";
      const d = (b.body ?? {}) as Record<string, unknown>;
      // An old rule in words the planner converted (goal 066): one line, from directive_converted.
      if (e.kind === "directive" && d.converted_from) return { at: e.at, html: "" };
      const said =
        e.kind === "experiment_added" && b.state !== "proposed"
          ? `Added ${t} to the queue${why(b.why)}`
          : e.kind === "experiment_accepted"
            ? `Queued ${esc(x ? byLabel(x.by).text : "the idea")} ${t}${why(b.why)}`
            : e.kind === "experiment_moved"
              ? `Moved ${t} to ${typeof b.position === "number" ? `place ${b.position + 1}` : `the ${esc(String(b.position))}`}${why(b.why)}`
              : e.kind === "experiment_dropped"
                ? `Dropped ${t}${why(b.why)}`
                : e.kind === "directive"
                  ? `Set the rule ${esc(String(d.kind ?? ""))} ${typeof d.family === "string" ? tok(d.family) : typeof d.match === "string" ? esc(`“${d.match}”`) : esc(String(d.value ?? ""))}${why(d.rationale)}${
                      typeof d.from_message === "number"
                        ? ` <span class="muted">(from your message: “${esc(clip(r.messages.find((m) => m.id === d.from_message)?.text ?? `#${d.from_message}`, 120))}”)</span>`
                        : ""
                    }`
                  : // A direction the planner designed for rules that named it (goal 066).
                    e.kind === "family_added" && Array.isArray(b.for_rules) && b.for_rules.length
                    ? `Designed the direction ${tok(String(b.family ?? ""))} for rule ${esc(b.for_rules.join(", "))}${why(b.description)}`
                    : e.kind === "directive_converted"
                      ? `Converted the old rule in words “${esc(clip(String(b.words ?? ""), 160))}” (rule ${esc(String(b.id))}) to ${esc(kindOf(String(b.kind ?? "")).verb)} ${tok(String(b.family ?? ""))} (rule ${esc(String(b.to))})`
                      : "";
      return { at: e.at, html: said };
    })
    .filter((c) => c.html);
  // Each of the owner's messages the planner read, in the round that read it.
  const read = r.messages.flatMap((m) =>
    m.reads
      .filter((x) => x.by === "planner")
      .map((x) => ({
        at: x.at,
        html: `Read your message “${esc(clip(m.text, 120))}”${x.round !== null ? ` in round ${x.round}` : ""}${m.rules.length ? `: made ${m.rules.length} rule${m.rules.length === 1 ? "" : "s"} from it` : ""}`,
      })),
  );
  const handouts = [...handed, ...changed, ...read]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30)
    .map((c) => entry(c.at, c.html))
    .join("");

  // ---------------------------------------- Tell the planner: the owner's messages and its answers
  /** A message the planner reads, and its answer once it read it: the rules it made, its notes. */
  const turn = (m: RunView["messages"][number]) => {
    const said = `<div class="qmsg you"><div class="qmh"><span class="qsrc you">you</span> <span class="muted xs">${esc(m.at.slice(11, 16))}${m.to === "all" ? " · to everyone working" : ""}</span></div>${withTokens(m.text, r.directions)}</div>`;
    const seen = m.reads.find((x) => x.by === "planner");
    if (!seen)
      return `<div class="qturn" data-msg="${m.id}">${said}<div class="qstep wait"><span class="ic"></span><span>Sent. The planner reads it when it next gives out work: round ${nextRound}. Its answer shows here.</span></div></div>`;
    // The round that read it: recorded with the read, or, for a read from before reads named
    // their round, the first hand-out after it.
    const round = seen.round ?? r.handouts.find((h) => h.at >= seen.at)?.round ?? null;
    const hand = r.handouts.find((h) => h.round === round && h.at >= seen.at);
    const items = m.rules.map((x) => {
      const d = x.family ? dirOf(x.family) : undefined;
      // A direction the model designed in that round: new for this rule.
      const made = x.family
        ? r.families.find(
            (f) => f.name === x.family && f.by === "planner:planner" && f.at >= seen.at,
          )
        : undefined;
      const inForce = r.rules.some((y) => y.id === x.id);
      const effect = inForce && d && !d.to_design ? ruleEffect(x.kind, d) : "";
      // The rule and why, the direction the planner designed for it, then what it does now.
      return `<li><b>${esc(kindOf(x.kind).verb)} ${x.family ? tok(x.family, d?.to_design ?? false) : ""}</b>${made ? ` <span class="chip info">new direction</span>` : ""}${x.rationale ? ` <span class="muted">· ${esc(clip(x.rationale, 300))}</span>` : ""}${made ? `<div class="small">The run had none for it, so the planner designed it: ${esc(clip(made.description, 300))}.</div>` : ""}${inForce ? (effect ? `<div class="xs ok">${icon.check} ${esc(effect)}</div>` : "") : `<div class="xs muted">It is no longer in force.</div>`}</li>`;
    });
    // Rules it made that you had removed: the harness left them out, so say so, never "none".
    const left = m.left_out.map(
      (x) =>
        `<li><b>${esc(kindOf(x.kind).verb)} ${x.family ? tok(x.family) : ""}</b><div class="xs warn">${icon.warn} You removed this rule. Only your own <code>redirect</code> sets it again.</div></li>`,
    );
    const notes = hand && hand.notes !== "the planner's plan" ? hand.notes : "";
    return `<div class="qturn" data-msg="${m.id}">${said}<div class="qmsg planner"><div class="qmh"><span class="qsrc planner">planner</span> <span class="muted xs">${round !== null ? `round ${round} · ` : ""}${esc(seen.at.slice(11, 16))}</span></div>${
      items.length
        ? `Read your message. Made ${items.length} rule${items.length === 1 ? "" : "s"}:<ul>${items.join("")}</ul>`
        : left.length
          ? "Read your message."
          : "Read your message. It made no rule from it."
    }${left.length ? `<div>Left out ${left.length === 1 ? "a rule" : `${left.length} rules`} you removed:</div><ul>${left.join("")}</ul>` : ""}${notes ? `<div class="muted small">Its notes for the round: ${esc(clip(notes, 400))}</div>` : ""}</div></div>`;
  };
  const turns = r.messages
    .filter((m) => m.to === "planner" || m.to === "all")
    .slice(-10)
    .reverse()
    .map(turn)
    .join("");
  const named = dirs.filter((d) => !d.to_design).map((d) => d.name);
  const words = (name: string) => name.replace(/-/g, " ");
  const examples =
    named.length >= 2
      ? [
          `stop :${named[1]}: and put :${named[0]}: first`,
          `always keep one lane on :${named[0]}:`,
          `drop ${words(named[named.length - 1] ?? "")} for now`,
        ]
      : named.length === 1
        ? [`put :${named[0]}: first`, `drop ${words(named[0] ?? "")} for now`]
        : ["never change the timing code", "put the cheapest experiments first"];
  const pickData = dirs.map((d) => ({
    name: d.name,
    tried: d.tried,
    wins: d.wins,
    queued: d.queued,
    lanes: d.lanes,
    rules: d.rules.map((x) => kindOf(x.kind).chip),
    new: d.to_design,
  }));
  const tellCard = !tell
    ? // The rig's own settings (Edit rig): with the planner off, nothing would read a message.
      `<div class="card qcard" id="tell" style="margin-top:14px"><h3>Tell the planner</h3><div class="small">The planner is off on this rig, so it reads no messages. ${research ? "The gap-driven plan sets each round from the answer cards' gaps, and keeps to the rules." : "The lanes take the queue in order and keep to the rules."} <a href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Switch it on in Edit rig</a> to tell it something.</div></div>`
    : research
      ? // A research run's planner weighs a message in the tasks it gives out; it makes no rule of it.
        `<div class="card qcard" id="tell" style="margin-top:14px"><h3>Tell the planner</h3>${o.refused ? `<div class="lnotice">${icon.warn}<span><b>Not sent.</b> ${esc(o.refused)}</span></div>` : ""}<form method="post" action="${esc(runMessageHref(r))}" class="qtell" data-act><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="to" value="planner"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel("Your message", "Say what you want, in plain words: a question to work on first, a gap to close, a kind of source to read. The planner reads your message when it next plans a round, and weighs it in the tasks it gives out. It makes no rule from it, and it gives no verdict: the review panel decides the questions.")}<textarea name="text" rows="3" required data-words maxlength="4000" spellcheck="false" placeholder="for example: work on question 2's gaps first, from the vendors' documentation" style="width:100%"></textarea></label>
<div class="act"><button class="primary">Send to the planner</button><span class="muted small">It reads your message when it next plans a round: round ${nextRound}.</span></div></form>
<div class="qthread">${turns}</div></div>`
      : `<div class="card qcard" id="tell" style="margin-top:14px"><h3>Tell the planner</h3>${o.refused ? `<div class="lnotice">${icon.warn}<span><b>Not sent.</b> ${esc(o.refused)}</span></div>` : ""}<form method="post" action="${esc(runMessageHref(r))}" class="qtell" data-act><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="to" value="planner"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel("Your message", "Say what you want, in plain words. To name a direction exactly, type : and pick it, or write :name:. Names may have spaces. The planner reads your message when it next gives out work. From it, it can add or drop experiments, reorder the queue and make rules. Each rule names a direction, so code keeps it. If no direction fits, the planner designs a new one and says what it means.")}<textarea name="text" rows="3" required data-words data-dpick data-dirs="${esc(JSON.stringify(pickData))}" maxlength="4000" spellcheck="false" placeholder="${esc(`for example: ${named.length >= 2 ? `stop :${named[1]}: and put :${named[0]}: first` : "stop :loop tiling: and put vector loads first"}`)}" style="width:100%"></textarea></label>
<div class="ktools qex"><span class="muted small">Examples:</span>${examples.map((x) => `<button type="button" class="fchip" data-example="${esc(x)}">${esc(x)}</button>`).join("")}</div>
<div class="nc-does" id="qmsg-prev">Write what you want in plain words, or type <code>:</code> to name a direction. The planner reads it when it next gives out work. It can add or drop experiments, reorder the queue and make rules. Each rule names a direction, so code keeps it.</div>
<div class="act"><button class="primary">Send to the planner</button><span class="muted small">It reads your message when it next gives out work: round ${nextRound}.</span></div></form>
<div class="qthread">${turns}</div></div>
<script src="/ui/assets/planner.js" defer></script>`;
  const dirRow = (d: DirectionView) =>
    `<div class="dlrow${d.to_design ? " fresh" : ""}"${d.description ? ` title="${esc(d.description)}"` : ""}>${tok(d.name, d.to_design)}<span class="muted xs">${esc(directionFigures(d))}${d.rules.map((x) => ` · <span class="qkind ${esc(kindOf(x.kind).chip)}">${esc(kindOf(x.kind).chip)}</span>`).join("")}</span></div>`;
  return `<div class="qcols"><div>
<div class="head"><h2>Rules</h2><span class="n">${r.rules.length}</span><span class="right">the planner keeps these when it gives out work; a rule changes what lanes work on, never a verdict</span></div>
<div class="qrules">${r.rules.map(ruleRow).join("") || `<div class="card"><div class="empty">No rules. The planner follows the queue and its own judgment.${tell ? " To make one, tell the planner below." : ""}</div></div>`}</div>
${tellCard}
<div class="head" style="margin-top:26px"><h2>What the planner did</h2><span class="right">each hand-out, and each change it made to the queue or the rules, with why</span></div>
<div class="card qhands">${handouts || `<div class="empty">${research ? "No round yet. Each round shows here: planned by the model, or set by the gap-driven plan." : "No hand-out yet."}</div>`}</div>
${o.figures}
</div><div class="qside">
<div class="card qcard"><h3>The run's directions <span class="muted small">${dirs.length}</span></h3><div class="small muted">${
    research
      ? `A research run's directions are its task kinds: ${esc(directionList(RESEARCH_TASK_KINDS))}. Each experiment has one. A rule names one.`
      : `${tell ? "What <code>:</code> offers in Tell the planner. " : ""}Each experiment has one direction. Names may have spaces. When nothing fits what you ask, the planner designs a new direction.`
  }</div><div class="dlist">${dirs.map(dirRow).join("") || `<div class="muted small">None yet. Each experiment adds its own.</div>`}</div></div>
${
  research
    ? `<div class="card qcard"><h3>The plan</h3><div class="small">A research run plans each round from its questions' answer cards and their gaps: by the planner's model when the planner is on, and otherwise by the gap-driven plan in code. Either keeps to the rules, which name its task kinds: send one with <code>redirect</code> over MCP, the REST API or the command line.</div></div>`
    : ""
}
<div class="card qcard"><h3>The planner</h3><div class="small">${esc(o.model)}</div><a class="small" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Change it on Edit rig</a>${
    r.agents.epochs
      ? `<div class="muted small" style="border-top:1px solid var(--border);padding-top:8px">${r.agents.epochs} round${r.agents.epochs === 1 ? "" : "s"} so far: ${r.agents.planner_valid} planned by the model, ${r.agents.fallbacks} ${research ? "set by the gap-driven plan" : "in queue order by the fixed rules"} (no model, the planner off, or no usable answer from the model). History says which for each round.</div>`
      : ""
  }</div>
${o.propagate ? `<div class="card qcard"><h3>Other rigs</h3>${o.propagate}</div>` : ""}
</div></div>`;
}

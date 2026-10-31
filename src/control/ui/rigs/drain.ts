import { drainChoices } from "../../clusters/index.ts";
import { clockUtc, commandProgress } from "../../command-progress.ts";
import type { CommandRow, ControlStore } from "../../store/index.ts";
import { type OpenTrial, type RigView, workOf } from "../../views/index.ts";
import { ago, esc, fmtInt, icon, infoLabel } from "../components/index.ts";
import { clip, span } from "../words/index.ts";

/**
 * A rig's drain on its page (goal 136, item 3): a card at the top says since when it drains, who
 * asked and why, and what it waits for, with **End the drain**. Under **At work**, each trial it
 * waits for gets a row beside its lane: how long it has run, what it last did, a refused request
 * it repeats, its work so far, and **Stop this trial…**, which sends `stop_trial`. The figures
 * come from the rig's report (`work`, which lists the open trials while the rig drains) and from
 * the trial's lines in Live.
 */

/** A rig's drain, from its last report; null when it doesn't drain. */
export interface RigDrain {
  since: string;
  reason: string;
  /** Who asked, as the harness recorded it (`control:owner:api`); null from an older harness. */
  by: string | null;
  trials: number;
  judgeJobs: number;
  /** The trials it waits for; null from a harness older than goal 136, which doesn't list them. */
  open: OpenTrial[] | null;
  /** When it stops waiting by itself, and when it did (goal 173); null from an older harness. */
  deadline: string | null;
  deadlineReached: string | null;
}

export function drainOf(u: Pick<RigView, "summary">): RigDrain | null {
  const w = workOf(u.summary);
  if (!w?.draining) return null;
  const d = w.draining;
  return {
    since: d.since,
    reason: d.reason,
    by: d.by ?? null,
    trials: w.trials,
    judgeJobs: w.judge_jobs,
    open: w.open ?? null,
    deadline: d.deadline ?? null,
    deadlineReached: d.deadline_reached ?? null,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 trials and the judge's job": what the drain waits for, in words; "" when nothing runs. */
function waitsFor(d: RigDrain): string {
  const jobs = d.judgeJobs === 1 ? "the judge's job" : `the judge's ${d.judgeJobs} jobs`;
  return [d.trials ? plural(d.trials, "trial") : "", d.judgeJobs ? jobs : ""]
    .filter(Boolean)
    .join(" and ");
}

/** Who asked for the drain, and how, from the issuer the harness recorded. */
function askedBy(by: string | null): string {
  if (!by) return "It was asked for";
  const who = by.replace(/^control:/, "");
  const how: Record<string, string> = {
    "owner:ui": "The owner asked for it on the dashboard",
    "owner:api": "The owner asked for it over REST",
    "owner:mcp": "The owner asked for it over MCP",
    "owner:operator": "An operator asked for it over MCP",
    owner: "The owner asked for it",
    drain: "Control asked for it again, after the rig's harness started again",
  };
  return how[who] ?? `${esc(who)} asked for it`;
}

/** The rig page's sentence for a drain under way. */
export function drainSaid(rig: string, d: RigDrain): string {
  const w = waitsFor(d);
  return `<b class="warn">${esc(rig)} drains: it starts nothing new${w ? `, and waits for ${esc(w)} to end` : ", and nothing runs any more"}.</b>`;
}

export interface DrainPage {
  rig: string;
  drain: RigDrain;
  /** The rig was set up by control on a cluster, and drains for a change control waits to make. */
  cluster: boolean;
  /** A form that sends a command, as the page's other buttons do. */
  form: (f: {
    kind: string;
    fields?: Record<string, string>;
    label: string;
    cls?: string;
  }) => string;
  csrf: string;
  store: ControlStore;
  now: number;
}

/** The stops sent for this rig's trials during the drain, newest first. */
function stopsSent(o: DrainPage): CommandRow[] {
  return o.store.commands
    .latest(o.rig, "stop_trial", 20)
    .filter((c) => Date.parse(c.issued_at) >= Date.parse(o.drain.since));
}

/**
 * The drain's deadline (goal 173): when it stops waiting by itself; once passed, the owner's two
 * choices, each with what it does. "" from a harness older than goal 173.
 */
function deadlineHtml(o: DrainPage): string {
  const d = o.drain;
  if (!d.deadline) return "";
  if (!d.deadlineReached)
    return `<p class="small" style="margin:0 0 6px;color:var(--foreground)">Its deadline is ${esc(clockUtc(d.deadline))}, ${Date.parse(d.deadline) > o.now ? `in ${esc(span(new Date(o.now).toISOString(), Date.parse(d.deadline)))}` : "now"}. Then it stops waiting by itself and asks you: go ahead now, or end the drain.</p>`;
  const c = drainChoices(o.store, o.rig);
  const form = (choice: "apply" | "end", label: string, cls: string) =>
    `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(o.rig)}/drain/${choice}"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="${cls}">${esc(label)}</button></form>`;
  return `<p class="small" style="margin:0 0 6px;color:var(--foreground)"><b class="warn">Its deadline passed at ${esc(clockUtc(d.deadlineReached))}.</b> It still starts nothing new, and waits for your choice: nothing is chosen for you.</p>
<div class="act" style="margin-bottom:8px">${form("apply", c.apply.label, "primary")}<span class="muted xs">${esc(c.apply.does)}</span></div>
<div class="act" style="margin-bottom:8px">${form("end", c.end.label, "")}<span class="muted xs">${esc(c.end.does)}</span></div>`;
}

/** The card at the top of the rig's page while it drains. */
export function drainBanner(o: DrainPage): string {
  const d = o.drain;
  const w = waitsFor(d);
  const listed = d.open?.map((t) => t.trial) ?? [];
  const waits = !w
    ? "Nothing runs any more: it is ready for what the drain is for."
    : `It waits for ${esc(w)}.${d.open === null && d.trials ? " Its harness is too old to say which trials, or to stop one: update it." : ""}`;
  // Trials stopped during the drain that no longer run: what became of them.
  const stopped = stopsSent(o)
    .filter((c) => !listed.includes(String(c.payload.trial)))
    .map((c) => {
      const p = commandProgress(c, o.now);
      const lane = (c.outcome as { result?: { lane?: unknown } } | null)?.result?.lane;
      const whose = typeof lane === "string" ? `${esc(lane)}'s trial` : "A trial";
      return p.tone === "bad"
        ? `<div class="small bad">${whose}: your stop at ${esc(clockUtc(c.issued_at))} was not taken. ${esc(p.said)}</div>`
        : `<div class="small" style="color:var(--foreground)"><span class="pill">stopped</span> ${whose}, stopped at ${esc(clockUtc(c.issued_at))}: it ended as interrupted, with its counters, and its task went back to the top of the run's queue.</div>`;
    })
    .join("");
  const end = o.cluster
    ? `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(o.rig)}/cluster/drain-cancel"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button>End the drain</button></form>`
    : o.form({ kind: "drain_rig", label: "End the drain" });
  const endWords = o.cluster
    ? "The rig goes back to work on its images, and the change it drains for is called off."
    : "The rig goes back to work on its images.";
  return `<div class="card warn" style="margin-bottom:16px" id="drain" data-state="draining"><div class="card-head">${icon.clock}<span class="title">Draining for ${esc(span(d.since, o.now))}, since ${esc(clockUtc(d.since))}.</span></div>
<p class="small" style="margin:6px 0 6px;color:var(--foreground)">${askedBy(d.by)}: <i>${esc(d.reason)}</i>. The rig starts no new trial, plan or judge job, and the work under way ends as it would. ${waits}${o.cluster ? " Control restarts its pods once nothing runs." : ""}</p>
${deadlineHtml(o)}${stopped}${listed.length ? `<p class="small muted" style="margin:0 0 10px;color:var(--muted-foreground)">Each trial it waits for is under <b>At work</b>, with a way to stop it.</p>` : ""}
${
  // Past its deadline, the two choices above take the place of End the drain.
  d.deadlineReached
    ? ""
    : `<div class="act">${end}<span class="muted xs">${endWords} ${infoLabel("", "Sends drain_rig with drain false: the rig starts new work again. Whoever asked for the drain then moves the rig without one, or asks again.")}</span></div>`
}</div>`;
}

/**
 * What a trial last did, from its lines in Live: its newest line, and its newest tool call. A
 * stuck trial's card says it too (stuck.ts).
 */
export function lastDone(
  o: { store: ControlStore; rig: string; now: number },
  t: { trial: string },
): { at: string | null; html: string } {
  const lines = o.store.liveLines.tail(o.rig, 12, `trial:${t.trial}`);
  const newest = lines.at(-1);
  if (!newest) return { at: null, html: "" };
  const i = lines.map((l) => l.kind).lastIndexOf("tool");
  const tool = lines[i];
  const answer = lines.slice(i + 1).find((l) => l.kind === "result");
  const call = tool
    ? `${esc(ago(tool.at, o.now))} ago: <code>${esc(clip(tool.text, 140))}</code>${answer ? `, answered: ${esc(clip(answer.text, 200))}` : ", no answer yet"}`
    : "no tool call in Live yet";
  const since =
    tool && newest.at > (answer ?? tool).at
      ? ` <span class="muted">· the model wrote since, ${esc(ago(newest.at, o.now))} ago</span>`
      : "";
  return { at: newest.at, html: `${call}${since}` };
}

/** The confirmation under Stop this trial…, as the approved mockup has it. */
const CONFIRM =
  "margin-top:8px;padding:10px 12px;display:grid;gap:8px;border:1px solid var(--error-foreground);border-radius:var(--control-radius);background:var(--error-surface);color:var(--foreground)";

const STUCK_TIP =
  "Its tool calls asked again for a page this run refused for a reason that lasts, such as its size. The trial may be stuck on it. Nothing ends a trial for that: you decide.";

/**
 * What the drain adds beside a lane under At work: a mark on the lane's row, and below it the
 * trial's facts and Stop this trial…. Nothing for a lane whose trial the drain doesn't list.
 */
export function drainLane(
  o: DrainPage,
  run: string,
  lane: string,
): { mark: string; below: string } | undefined {
  const t = o.drain.open?.find((x) => x.run === run && x.lane === lane);
  if (!t) return undefined;
  const r = t.refused_again;
  const mark = r
    ? ` <span class="chip warn" title="${esc(STUCK_TIP)}">repeats a refused request</span>`
    : "";
  const last = lastDone(o, t);
  // What the drain waits for once this trial has ended.
  const rest = waitsFor({ ...o.drain, trials: Math.max(0, o.drain.trials - 1) });
  const facts = [
    [
      infoLabel(
        "Running for",
        "Since the trial started. A trial has no time limit unless one is set.",
      ),
      `${esc(span(t.started_at, o.now))}, since ${esc(clockUtc(t.started_at))}`,
    ],
    ...(last.at
      ? [
          [
            infoLabel(
              "Last did something",
              "Its newest tool call in Live, and the harness's answer to it. Live keeps a trial's lines while control and the harness run.",
            ),
            last.html,
          ],
        ]
      : []),
    ...(r
      ? [
          [
            infoLabel("Same request", STUCK_TIP),
            `This trial asked ${esc(plural(r.times, "time"))} for a page the run refused before: <code>${esc(clip(r.url, 160))}</code>, ${esc(r.reason)}. The run has asked for it ${esc(plural(r.asked, "time"))}, the last ${esc(ago(r.at, o.now))} ago. The harness answers each ask at once, with no download.`,
          ],
        ]
      : []),
    [
      "Work so far",
      [
        plural(t.turns, "turn"),
        plural(t.tool_calls, "tool call"),
        `${fmtInt(t.tokens_in)} tokens in`,
        ...(t.claims === null ? [] : [plural(t.claims, "verified claim")]),
      ]
        .map(esc)
        .join(" · "),
    ],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");
  // A stop sent for this trial: how it stands, instead of the button, unless it was not taken.
  const sent = stopsSent(o).find((c) => c.payload.trial === t.trial);
  const p = sent ? commandProgress(sent, o.now) : undefined;
  const stop =
    p && p.tone !== "bad"
      ? `<div class="small muted">${p.state === "done" ? `${esc(o.rig)} took your stop at ${esc(clockUtc(sent?.acked_at ?? sent?.issued_at ?? ""))}: the trial ends as interrupted within seconds.` : `Stop sent at ${esc(clockUtc(sent?.issued_at ?? ""))}. ${esc(p.said)}`}</div>`
      : `${p ? `<div class="small bad">${esc(p.said)}</div>` : ""}<details data-k="stop-${esc(t.trial)}"><summary class="btn sm" style="width:max-content">Stop this trial…</summary><div class="small" style="${CONFIRM}"><div><b>Stop ${esc(lane)}'s trial now?</b> It ends as interrupted. Its sources, claims and counters stay. Its task goes back to the top of the run's queue, so a lane takes it up again after the drain.${rest ? ` The drain then waits only for ${esc(rest)}.` : " Then nothing runs any more."}</div>${o.form({ kind: "stop_trial", fields: { run, trial: t.trial }, label: "Stop the trial", cls: "danger sm" })}</div></details>`;
  const when = last.at
    ? `last did something ${esc(ago(last.at, o.now))} ago`
    : "nothing in Live from it yet";
  const below = `<div class="br"><span class="br-who"></span><div class="br-what"><details data-k="drain-${esc(t.trial)}"${r ? " open" : ""}><summary class="small">The drain waits for it · ${when}</summary><dl class="facts" style="margin:8px 0">${facts}</dl>${stop}</details></div><span class="br-when"></span></div>`;
  return { mark, below };
}

/** What a drain adds to a lane under At work (runBrief's `lane`). */
export type LaneExtra = (lane: string) => { mark: string; below: string } | undefined;

/** A drain's parts on the rig's page: its sentence, its card and its lanes; null without one. */
export function drainView(
  u: Pick<RigView, "id" | "summary">,
  o: Omit<DrainPage, "rig" | "drain">,
): { said: string; banner: string; lanes: (run: string) => LaneExtra } | null {
  const drain = drainOf(u);
  if (!drain) return null;
  const p = { ...o, rig: u.id, drain };
  return {
    said: drainSaid(u.id, drain),
    banner: drainBanner(p),
    lanes: (run) => (lane) => drainLane(p, run, lane),
  };
}

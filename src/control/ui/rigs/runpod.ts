import type { ExportLeft, ResultsLeft } from "../../results-left.ts";
import { type KeptPodLog, RUNPOD_STEP_WORDS, type RunpodRigView } from "../../runpod/index.ts";
import { infoLabel } from "../campaigns/new/index.ts";
import { ago, esc } from "../components/index.ts";
import type { TimelineRow } from "../operator/index.ts";
import { span } from "../words/index.ts";
import { type RigStep, stepsHtml } from "./states.ts";

/**
 * A RunPod rig's pod on its page (goals 022 and 023): what it costs now and has cost, the owner's
 * spend limit and idle stop (editable), stop, start, restart, full reset and terminate, the change
 * under way with its steps, and the results that must leave the pod before it ends. Every change
 * is a step of the rig's history, which the page shows with the rig's own events.
 */

const money = (usd: number | null | undefined) =>
  usd === null || usd === undefined ? "–" : `$${usd.toFixed(2)}`;
const rigUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}`;

/** The pod's state at RunPod, as the page says it. */
export function podState(v: RunpodRigView): { word: string; tone: string } {
  if (!v.active || v.status === "TERMINATED") return { word: "Terminated", tone: "bad" };
  if (v.op) return { word: `${v.op_words?.split(":")[0] ?? "working"}…`, tone: "info" };
  if (v.status === "EXITED") return { word: "Stopped", tone: "" };
  if (v.status === "RUNNING") return { word: "Running", tone: "ok" };
  return { word: v.status.charAt(0) + v.status.slice(1).toLowerCase(), tone: "info" };
}

/** Whether the pod runs (and costs its price): neither stopped nor gone. */
export const podRuns = (v: RunpodRigView) =>
  v.active && v.status !== "EXITED" && v.status !== "TERMINATED";

/** The steps of the change under way: done, waiting, or still to come. */
function opSteps(v: RunpodRigView): string {
  const op = v.op;
  if (!op) return "";
  type S = { text: string; phase?: string };
  const plans: Record<string, S[]> = {
    stop: [
      { text: "Pause the runs at a safe point." },
      { text: "Send the waiting results out of the pod.", phase: "exporting" },
      { text: "Wait until they have left the pod (15 minutes at most).", phase: "leaving" },
      { text: "Ask RunPod to stop the pod. Its volume stays." },
    ],
    terminate: [
      { text: "Pause the runs at a safe point." },
      { text: "Wait until no judge job and no command waits on the rig.", phase: "quiescing" },
      { text: "Make a full export.", phase: "exporting" },
      { text: "Wait until every result has left the pod.", phase: "leaving" },
      { text: "Ask RunPod to delete the pod and its volume. The rig is retired." },
    ],
    start: [
      { text: "Ask RunPod to start the pod." },
      { text: "Wait for the pod to run.", phase: "starting" },
      { text: "Resume the runs the stop paused." },
    ],
    restart: [
      { text: "Ask RunPod to stop the pod." },
      { text: "Wait for the pod to stop.", phase: "stopping" },
      { text: "Ask RunPod to start it again, and wait for it to run.", phase: "starting" },
      // A restart pauses no run (runpod/lifecycle.ts): the harness starts again with them.
      { text: "The harness starts again: a trial that was in progress is planned again." },
    ],
  };
  const plan = plans[op.kind] ?? [];
  const at = plan.findIndex((s) => s.phase === op.phase);
  return stepsHtml(
    plan.map((s, i) => ({
      text: esc(s.text),
      state: i < at ? "ok" : i === at ? "wait" : "todo",
    })),
  );
}

/** The four facts: cost now, spent so far, the spend limit and the idle stop. */
function facts(v: RunpodRigView, now: number): string {
  const runs = podRuns(v);
  const gone = !v.active || v.status === "TERMINATED";
  const cost = gone
    ? { v: "none", s: "billing ended" }
    : runs
      ? {
          v: `${money(v.price_per_hr)}/h`,
          s: `${v.gpu_count} × ${esc(v.gpu_name)}, at RunPod's price for the pod`,
        }
      : { v: "storage only", s: "its GPU is not billed while it is stopped" };
  const spent = v.spend_usd ?? v.spent_usd;
  const limit = v.spend_limit_usd;
  const left =
    limit !== null && v.price_per_hr && v.price_per_hr > 0
      ? Math.max(0, Math.floor((limit - spent) / v.price_per_hr))
      : null;
  const spentSub = gone
    ? "in all, from launch to the end"
    : limit !== null
      ? `of ${money(limit)}${left !== null ? ` · about ${left} h of work left` : ""}`
      : `since launch, ${esc(ago(v.launched_at, now))} ago`;
  const bar =
    limit !== null
      ? `<div class="bar"><i style="width:${Math.min(100, Math.round((100 * spent) / limit))}%"></i></div>`
      : "";
  const idle = v.idle_stop_minutes;
  const idleSub =
    idle === null
      ? "it never stops by itself"
      : !runs
        ? "it counts while the pod runs"
        : v.idle_since
          ? `no run at work for ${esc(span(v.idle_since, now) || "0 s")} of ${idle} min`
          : v.enrolled_at
            ? "a run is at work"
            : "it counts once the pod enrolls";
  const edit = gone ? "" : ` · <a href="#limits">Change it</a>`;
  return `<div class="facts4">
<div class="fact"><div class="k">${infoLabel("Cost now", "What the pod costs per hour now, from RunPod's price for it. While it is stopped, RunPod bills only its volume, and control does not count that.")}</div><div class="v" data-cost>${esc(cost.v)}</div><div class="s">${cost.s}</div></div>
<div class="fact"><div class="k">${infoLabel("Spent so far", "What the pod has cost while it ran, since launch, at RunPod's price for it. Control counts it every 30 seconds. RunPod's own billing is in Settings › Providers.")}</div><div class="v" data-spent>${money(spent)}</div><div class="s">${spentSub}</div>${bar}</div>
<div class="fact"><div class="k">${infoLabel("Spend limit", "Control stops the pod when it has cost this much in total, since launch. A stopped pod still pays for its volume. Empty: no limit.")}</div><div class="v" data-limit>${limit === null ? "none" : money(limit)}</div><div class="s">${limit === null ? "no limit" : "the pod stops there"}${edit}</div></div>
<div class="fact"><div class="k">${infoLabel("Idle stop", "Control stops the pod when no run has been at work on it for this long: no campaign runs, or every run is paused, blocked or finished. GPU billing then ends, and the volume stays. Starting or resuming a run starts the pod again. Empty: it never stops by itself.")}</div><div class="v" data-idle>${idle === null ? "never" : `${idle} min`}</div><div class="s">${idleSub}${edit}</div></div>
</div>`;
}

/** The form that sets or clears the spend limit and the idle stop. */
function limitsForm(v: RunpodRigView, t: string, minIdle: number): string {
  return `<details class="card flat" id="limits" style="margin:0 0 14px"><summary style="padding:9px 14px">Change the spend limit or the idle stop</summary><form method="post" action="${rigUrl(v.rig)}/runpod/limits" style="padding:4px 14px 12px" autocomplete="off"><input type="hidden" name="csrf" value="${esc(t)}"><div class="g3">
<label class="fd">${infoLabel("Spend limit (USD)", "Control stops the pod when it has cost this much in total, since launch. Empty: no limit.")}<input name="spend_limit_usd" inputmode="decimal" placeholder="none" value="${v.spend_limit_usd === null ? "" : esc(v.spend_limit_usd)}"></label>
<label class="fd">${infoLabel("Stop when idle for (minutes)", `Control stops the pod when no run has been at work on it for this long. ${minIdle} minutes or more. Empty: it never stops by itself.`)}<input name="idle_stop_minutes" inputmode="numeric" placeholder="never" value="${v.idle_stop_minutes === null ? "" : esc(v.idle_stop_minutes)}"></label>
<div class="fd"><span class="lb">&nbsp;</span><span class="act"><button class="primary">Save</button></span></div></div>
<div class="muted small">A limit the pod has reached already stops it at control's next check, within 30 seconds, its results sent out first.</div></form></details>`;
}

/** One box of Start, stop and end it: what it does, maybe a typed confirmation, its button. */
function box(o: {
  rig: string;
  t: string;
  title: string;
  says: string;
  button: string;
  action: string;
  on: boolean;
  off?: string | undefined;
  cls?: string | undefined;
  confirm?: string | undefined;
}): string {
  const confirm = o.confirm
    ? `<input name="confirm" placeholder="type: ${esc(o.confirm)}" data-confirm="${esc(o.confirm)}" aria-label="Type ${esc(o.confirm)} to confirm"${o.on ? "" : " disabled"}>`
    : "";
  return `<form class="lcb${o.on ? "" : " off"}" method="post" action="${esc(o.action)}"><input type="hidden" name="csrf" value="${esc(o.t)}"><b>${esc(o.title)}</b><span class="muted">${o.says}</span>${confirm}<button class="${o.cls ?? ""}"${o.on ? "" : " disabled"}>${esc(o.button)}</button>${!o.on && o.off ? `<span class="muted xs">${esc(o.off)}</span>` : ""}</form>`;
}

/** Results that must leave the pod before it ends, from the supervisor's last report. */
function resultsBlock(
  v: RunpodRigView,
  r: ResultsLeft | null,
  last: { name: string; left: ExportLeft } | null,
  now: number,
): string {
  const dest = r?.to === "repository" ? "the results repository" : "control";
  const row = (tone: string, text: string, state: string) =>
    `<div class="outrow"><span class="dot ${tone}"></span><span>${text}</span><span class="small ${tone}">${esc(state)}</span></div>`;
  const rows: string[] = [];
  if (!r || r.waiting === null)
    rows.push(
      row("", "The rig's supervisor has not reported its exports yet.", "not reported yet"),
    );
  else {
    rows.push(
      row(
        r.waiting ? "warn" : "ok",
        `Exports waiting to leave the pod → ${esc(dest)}`,
        r.waiting ? `${r.waiting} waiting` : "none waiting",
      ),
    );
    if (r.champions_waiting !== null)
      rows.push(
        row(
          r.champions_waiting ? "warn" : "ok",
          "Champions' patches waiting to reach control",
          r.champions_waiting ? `${r.champions_waiting} waiting` : "none waiting",
        ),
      );
  }
  if (last)
    rows.push(
      row(
        last.left.left ? "ok" : last.left.never ? "bad" : "warn",
        `The last export, <code>${esc(last.name)}</code>: ${esc(last.left.why)}`,
        last.left.left ? "out" : last.left.never ? "can't leave" : "on its way",
      ),
    );
  const waiting = (r?.waiting ?? 0) + (r?.champions_waiting ?? 0);
  const head =
    !r || r.waiting === null ? "not reported" : waiting ? `${waiting} waiting` : "all out";
  return `<div class="block" style="margin-top:16px" id="results"><div class="head"><h2>Results in the pod</h2><span class="n">${esc(head)}</span><span class="right">what must leave the pod before it ends</span></div><div class="card"><div class="outlist">${rows.join("")}</div><div class="muted xs" style="margin-top:8px">From the rig's supervisor${r?.reported_at ? `, ${esc(ago(r.reported_at, now))} ago` : ""} (unsigned). Control checks every file of an export it receives against the export's manifest. A stop sends what waits out first, and a terminate waits until all of it has left.${v.active ? " <b>Export</b>, at the top of the page, sends what waits now." : ""}</div></div></div>`;
}

/** The pod block of a RunPod rig's page. */
export function podBlock(o: {
  v: RunpodRigView;
  t: string;
  now: number;
  results: ResultsLeft | null;
  lastExport: { name: string; left: ExportLeft } | null;
  /** A full reset of the rig is open (it waits for its steps or the owner's confirmation). */
  resetOpen: boolean;
  minIdle: number;
}): string {
  const { v, t, now } = o;
  const st = podState(v);
  const gone = !v.active || v.status === "TERMINATED";
  const runs = podRuns(v);
  const stopped = v.active && v.status === "EXITED";
  const free = !v.op && !o.resetOpen;
  const busyWhy = v.op ? `${v.op_words}.` : o.resetOpen ? "A full reset is under way." : "";
  const lc = gone
    ? ""
    : `<div class="head" style="margin-top:4px"><h2>Start, stop and end it</h2><span class="right">the owner's alone</span></div>
<div class="lc">
${box({ rig: v.rig, t, title: "Stop", says: "Pauses the runs at a safe point, sends waiting results out of the pod, then stops it. GPU billing ends; the volume stays.", button: "Stop the pod", action: `${rigUrl(v.rig)}/runpod/stop`, on: runs && free, off: stopped ? "The pod is stopped." : busyWhy })}
${box({ rig: v.rig, t, title: "Start", says: "Starts the pod again and resumes the runs the stop paused. RunPod gives it a GPU on the same machine when one is free.", button: "Start the pod", action: `${rigUrl(v.rig)}/runpod/start`, on: stopped && free, off: runs ? "The pod runs." : busyWhy, cls: "primary" })}
${box({ rig: v.rig, t, title: "Restart", says: "Stops the pod and starts it again, with no export: its volume keeps everything. Its runs are not paused: a trial in progress stops, and the harness plans it again. RunPod may have no GPU free for it: then it stays stopped.", button: "Restart the pod", action: `${rigUrl(v.rig)}/runpod/restart`, on: runs && free, off: stopped ? "The pod is stopped: start it instead." : busyWhy })}
${box({ rig: v.rig, t, title: "Full reset", says: "Pauses the runs, sends every result out of the pod and checks it, then wipes the rig's state once you confirm. The pod and its GPU stay.", button: "Start the full reset", action: `${rigUrl(v.rig)}/reset`, on: runs && free, off: stopped ? "The pod is stopped: start it first, so its results can leave it." : busyWhy, cls: "danger", confirm: `reset ${v.rig}` })}
${box({ rig: v.rig, t, title: "Terminate", says: "Sends every result out of the pod and waits until each one has arrived. Then RunPod deletes the pod and its volume, and the rig is retired. Billing ends.", button: "Terminate", action: `${rigUrl(v.rig)}/runpod/terminate`, on: free, off: busyWhy, cls: "danger", confirm: `terminate ${v.rig}` })}
</div>`;
  const op = v.op
    ? `<div class="card" style="margin-top:12px" id="op"><div class="card-head"><span class="title">${esc(v.op_words ?? "")}</span><span class="right muted small">asked by ${esc(v.op.by)} ${esc(ago(v.op.at, now))} ago</span></div>${opSteps(v)}</div>`
    : "";
  const err = v.error ? `<div class="flash bad" style="margin-top:12px">${esc(v.error)}</div>` : "";
  const where = [
    v.cloud_type === "SECURE" ? "Secure" : "Community",
    v.datacenter,
    `pod ${v.pod}`,
  ].filter(Boolean);
  return `<div class="block" id="pod"><div class="head"><h2>The pod</h2><span class="chip violet">RunPod</span><span class="chip ${st.tone}" data-pod-state>${esc(st.word)}</span><span class="chip">${esc(where.join(" · "))}</span><span class="right">${v.status_at ? `from RunPod, read ${esc(ago(v.status_at, now))} ago` : "not read yet"}</span></div>
${facts(v, now)}${gone ? "" : limitsForm(v, t, o.minIdle)}${lc}${op}${err}
${gone ? "" : resultsBlock(v, o.results, o.lastExport, now)}</div>`;
}

/** The pod's steps for the rig's history (launch, stops, starts, resets...), each its own line. */
export function podRows(steps: RigStep[]): TimelineRow[] {
  return steps
    .filter((s) => s.step.startsWith("runpod_") || s.step.startsWith("reset_"))
    .map((s) => ({
      at: s.at,
      tone: s.ok ? (/(running|launched)$/.test(s.step) ? "ok" : "") : "bad",
      html: `${esc(RUNPOD_STEP_WORDS[s.step] ?? s.step)}${s.detail ? `: ${esc(s.detail)}` : ""}.`,
      k: "pod",
    }));
}

/** The filters of a RunPod rig's history: everything, the pod, the runs, the judge. */
export const HISTORY_FILTERS = `<div class="ktools" id="hf"><button type="button" class="fchip on" data-h="all">All</button><button type="button" class="fchip" data-h="pod">The pod</button><button type="button" class="fchip" data-h="runs">Runs</button><button type="button" class="fchip" data-h="judge">The judge</button></div>`;

/**
 * A RunPod rig before its first report: the steps from the launch to its first report, as far as
 * they went (the pod runs, it enrolled, it reported).
 */
export function readySteps(v: RunpodRigView, reported: boolean): string {
  const runs = v.status === "RUNNING";
  const rows: { text: string; state: "ok" | "bad" | "wait" | "todo" }[] = [
    {
      text: `Launched on RunPod: pod ${esc(v.pod)}, ${v.gpu_count} × ${esc(v.gpu_name)}.`,
      state: "ok",
    },
    {
      text: "The pod pulls the image and runs (a few minutes).",
      state: runs || v.enrolled_at ? "ok" : v.error ? "bad" : "wait",
    },
    {
      text: "Control enrolls it through RunPod's proxy with its one-time code, and pins its keys.",
      state: v.enrolled_at ? "ok" : runs ? "wait" : "todo",
    },
    {
      text: "The rig's first report reaches control. Its isolation check at start is on its page.",
      state: reported ? "ok" : v.enrolled_at ? "wait" : "todo",
    },
  ];
  return stepsHtml(rows);
}

/**
 * A RunPod rig's pod log (the block Pod log): the lines of the last read, oldest first with the
 * newest in view, each marked container or system, and the button that reads it again. The page
 * never reads RunPod as it loads: a read holds RunPod's stream open for up to 10 seconds, and the
 * page's script draws the page again every few seconds while it follows an action. With `auto`
 * and nothing read yet, the page's script reads it once as the page opens (data-autoread).
 */
export function podLogBlock(o: {
  rig: string;
  kept: KeptPodLog | undefined;
  t: string;
  now: number;
  auto: boolean;
}): string {
  const k = o.kept;
  const rows = (k?.lines ?? [])
    .map((l) => {
      const src = l.source === "system" ? "system" : "container";
      return `<div class="pl ${src}"><span class="pl-src">${src}</span><span class="pl-t" title="${esc(l.ts)}">${esc(l.ts.slice(11, 19))}</span><span class="pl-l">${esc(l.line)}</span></div>`;
    })
    .join("");
  const which = k?.source ? `${k.source} lines only` : "container and system";
  const state = !k
    ? `<div class="empty">Not read yet.${o.auto ? " Reading it…" : ""}</div>`
    : k.error
      ? `<div class="flash bad">Not read: ${esc(k.error)}</div>`
      : rows
        ? `<div class="podlog"><div>${rows}</div></div>`
        : `<div class="empty">RunPod has no line in this pod's log yet.</div>`;
  const n = k?.lines.length ?? 0;
  const when = k
    ? `<div class="muted xs" style="margin-top:6px">Read ${esc(ago(k.read_at, o.now))} ago, at ${esc(k.read_at.slice(11, 16))} UTC${k.error ? "" : `: ${n} line${n === 1 ? "" : "s"}, ${which}, oldest first`}.</div>`
    : "";
  return `<div class="block" id="podlog" data-part="podlog"><div class="head"><h2>Pod log</h2><span class="chip violet">RunPod</span><span class="right">what the pod printed, the newest at the bottom</span></div><div class="card">${state}${when}
<form class="row" method="post" action="${rigUrl(o.rig)}/runpod/logs" data-act${o.auto && !k ? " data-autoread" : ""} style="gap:10px;margin-top:10px;align-items:center"><input type="hidden" name="csrf" value="${esc(o.t)}"><button data-busy="Reading…">${k ? "Read again" : "Read the log"}</button><span class="muted xs">From RunPod's API, with the key of the GPU cloud in Settings › Providers, only when asked: a read takes up to 10 seconds. <b>container</b> lines are what the rig image printed; <b>system</b> lines are RunPod's own, such as the image pull. What looks like a key or token is taken out.</span></form></div></div>`;
}

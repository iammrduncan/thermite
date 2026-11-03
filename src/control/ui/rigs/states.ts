import type { BuildInfo } from "../../../core/version.ts";
import {
  BUS_KEY_CHANGE_STEPS,
  BUS_OFF_STEP,
  BUS_REGISTERED_STEP,
  type OffBus,
} from "../../bus/index.ts";
import type { HeldCommand } from "../../issue/index.ts";
import { rigVersionWords, STEP_WORDS, UPDATE_STEP_WORDS } from "../../rigs/index.ts";
import type { RigView } from "../../views/index.ts";
import { infoLabel } from "../campaigns/new/index.ts";
import { ago, esc, icon } from "../components/index.ts";
import type { TimelineRow } from "../operator/index.ts";
import { span } from "../words/index.ts";

/**
 * A rig's state on its page (goal 012): reporting, stale or offline, and its version against
 * control's (behind, ahead, unknown or refused). Each state that needs the owner gets a banner:
 * what control knows, what still works, and what to do, with the buttons that do it. The rig's
 * history gets the state's lines, and the Version fact says where the rig stands.
 */

/** Where a rig runs, and what control can do there for its page. */
export interface RigPlace {
  kind: "machine" | "cluster" | "joined" | "runpod" | "other";
  /** "gpu-box-1, a machine over SSH": for the Placed on fact. */
  words: string;
  /** Control moves it onto its images (Update to …): set up by control on a machine or cluster. */
  update: boolean;
  /** Why control can't, in words, for a rig control set up whose update is not possible now. */
  noUpdate?: string | undefined;
  /** Control checks where it runs (Check again): a machine over SSH or a cluster's API. */
  check: boolean;
  /** "its machine", "the cluster": what Check again reaches. */
  checkWhat: string;
  /** The form action that restarts its containers; null when control can't. */
  restart: string | null;
}

export interface RigStep {
  at: string;
  step: string;
  ok: boolean;
  detail: string | null;
}

export interface RigStateInput {
  u: RigView;
  place: RigPlace;
  control: BuildInfo;
  /** Since when control runs its build (noteControlBuild). */
  controlSince?: string | undefined;
  staleAfterMs: number;
  offlineAfterMs: number;
  /** The rig's steps, oldest first (rig_setup_event): its checks and updates are among them. */
  steps: RigStep[];
  /** What an update under way waits for, in words; null when none is under way. */
  updating: string | null;
  /** A RunPod rig whose pod is stopped: not stale nor offline, just stopped. */
  podStopped: boolean;
  /** Why it is off the message bus, with what to do; undefined while nothing says so. */
  offBus?: (OffBus & { fix: string }) | undefined;
  /** Its commands the bus did not take, which control holds, oldest first. */
  held?: HeldCommand[] | undefined;
  csrf: string;
  now: number;
}

const rigUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}`;

/** "6 minutes", "3 h 12 min": how long since the last report, in words. */
const since = (iso: string, now: number) => {
  const s = span(iso, now);
  return s.replace(/^(\d+) min$/, (_m, n: string) => `${n} minute${n === "1" ? "" : "s"}`);
};

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? "" : "s"}`;
};

/** A form with the CSRF token and one button. */
const button = (action: string, label: string, t: string, cls = "", extra = "", attrs = "") =>
  `<form class="inline" method="post" action="${esc(action)}"${attrs}><input type="hidden" name="csrf" value="${esc(t)}">${extra}<button class="${cls}">${esc(label)}</button></form>`;

/** Retire it, behind a typed confirmation (the rig's page and its banners). */
export function retireMenu(rig: string, t: string): string {
  return `<details class="menu"><summary class="btn">Retire it</summary><div class="menu-pop"><form method="post" action="${rigUrl(rig)}/retire" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${esc(t)}"><div class="small"><b>Retire it.</b> <span class="muted">For a rig that is gone: it leaves the rig lists and Needs you, and control refuses its reports. Its runs stay on their campaigns' pages, under Earlier runs. Its records stay, and you can bring it back. It stops nothing where the rig runs.</span></div><input name="confirm" placeholder="type: retire ${esc(rig)}" data-confirm="retire ${esc(rig)}" aria-label="Type retire ${esc(rig)} to confirm"><button class="danger" style="justify-content:center">Retire it</button></form></div></details>`;
}

/** The steps of a list, each done (✓), failed (✕), under way (a spinner) or still to come. */
export function stepsHtml(rows: { text: string; state: "ok" | "bad" | "wait" | "todo" }[]): string {
  const ic = { ok: "✓", bad: "✕", wait: "", todo: "" };
  return `<div class="steps">${rows
    .map(
      (r) =>
        `<div class="step ${r.state}"><span class="ic">${ic[r.state]}</span><span>${r.text}</span></div>`,
    )
    .join("")}</div>`;
}

/** The steps of the rig's last update, if it began in the last day. */
function lastUpdate(o: RigStateInput): { steps: RigStep[]; failed: boolean } | null {
  const start = o.steps.map((s) => s.step).lastIndexOf("update_started");
  if (start < 0) return null;
  const steps = o.steps.slice(start).filter((s) => s.step.startsWith("update_"));
  const first = steps[0];
  if (!first || (o.now - Date.parse(first.at) > 24 * 3_600_000 && !o.updating)) return null;
  return { steps, failed: steps.some((s) => !s.ok) };
}

function updateSteps(o: RigStateInput, u: { steps: RigStep[] }): string {
  return stepsHtml([
    ...u.steps.map((s) => ({
      text: `${esc(UPDATE_STEP_WORDS[s.step] ?? s.step)}${s.detail ? ` <span class="muted">· ${esc(s.detail)}</span>` : ""}`,
      state: s.ok ? ("ok" as const) : ("bad" as const),
    })),
    ...(o.updating ? [{ text: esc(o.updating), state: "wait" as const }] : []),
  ]);
}

/** The last time control checked where the rig runs, if it did. */
function lastCheck(o: RigStateInput): RigStep | undefined {
  return [...o.steps].reverse().find((s) => s.step === "check");
}

/** What an update does, for a rig control can update, in words. */
function updateWords(o: RigStateInput, to: string): string {
  const where =
    o.place.kind === "cluster" ? `in its namespace on ${o.place.words}` : `on ${o.place.words}`;
  return `Control pauses its runs at a safe point, moves its containers onto control's images ${esc(where)}, waits for a report from ${esc(to)}, runs its isolation check and resumes the runs. Its ledger, runs, results and key stay.`;
}

/** How to move a rig control can't update onto control's version, in words. */
function selfUpdateWords(o: RigStateInput, to: string): string {
  if (o.place.kind === "runpod")
    return `Control can't move a pod onto another image. To run ${esc(to)}, terminate this rig and launch a new one on control's image.`;
  if (o.place.noUpdate) return esc(o.place.noUpdate);
  return `Pull the ${esc(to)} images where the rig runs, and start it again with them.`;
}

/** The Update to … button, or the words to do it oneself. */
function updateAct(o: RigStateInput, to: string): string {
  if (!o.place.update) return "";
  if (o.updating) return `<button disabled>Updating…</button>`;
  // data-act: the page's script sends it and follows the update's steps (goal 080).
  return button(`${rigUrl(o.u.id)}/update`, `Update to ${to}`, o.csrf, "primary", "", " data-act");
}

/** The banner for a rig control refuses. */
function refusedBanner(o: RigStateInput): string {
  const r = o.u.version.refused;
  if (!r) return "";
  const to = o.control.version;
  const newer = /Update control\.$/.test(r.reason);
  const runs = rigVersionWords(o.u.version);
  const last = Date.parse(o.u.last_seen) > 0;
  const update = lastUpdate(o);
  return `<div class="card bad" style="margin-bottom:16px" id="version" data-state="refused"><div class="card-head">${icon.x}<span class="title">Control refuses this rig: its version is too ${newer ? "new" : "old"}.</span></div>
<p class="small" style="margin:6px 0 6px">${esc(o.u.id)} runs Thermite ${esc(runs)}. Control runs ${esc(to)}. ${esc(r.reason)} So control takes none of its reports and sends it no commands. The rig may still run where it is, but nothing it does shows here. ${last ? `What you see below is from its last report that control took, ${esc(ago(o.u.last_seen, o.now))} ago.` : "Control never took a report from it."}${r.calls ? ` Control refused ${r.calls} of its calls in the last ${esc(span(r.since, o.now))}, the last one ${esc(ago(r.last_at, o.now))} ago: the rig still runs and calls.` : ""}</p>
<p class="small" style="margin:0 0 10px">${
    newer
      ? `<b>To fix it, update control to the rig's version or later.</b> When the rig reports a build control works with, the refusal ends by itself.`
      : `<b>To fix it, update the rig to ${esc(to)}.</b> ${o.place.update ? `Control does it on ${esc(o.place.words)}, and the runs go on from what the rig kept.` : selfUpdateWords(o, to)} A rig newer than control is refused the same way: then update control first.`
  }</p>
<div class="act">${newer ? "" : updateAct(o, to)}${retireMenu(o.u.id, o.csrf)}</div>${update ? updateSteps(o, update) : ""}</div>`;
}

/** The banner for a rig whose version differs from control's but works with it. */
function versionBanner(o: RigStateInput): string {
  const v = o.u.version;
  const to = o.control.version;
  const update = lastUpdate(o);
  if (v.state === "current") {
    // Just updated: the steps it took, while they are fresh.
    if (!update) return "";
    return `<div class="card ok" style="margin-bottom:16px" id="version" data-state="updated"><div class="card-head">${icon.check}<span class="title">${update.failed ? "The last update stopped, but it" : "Updated. It"} runs Thermite ${esc(to)}, as control does.</span></div>${updateSteps(o, update)}</div>`;
  }
  if (v.state === "refused") return refusedBanner(o);
  const runs = rigVersionWords(v);
  if (v.state === "behind")
    return `<div class="card warn" style="margin-bottom:16px" id="version" data-state="behind"><div class="card-head">${icon.warn}<span class="title">${esc(o.u.id)} runs Thermite ${esc(runs)}. Control runs ${esc(to)}.</span></div>
<p class="small" style="margin:6px 0 10px">They work together, so nothing stops. Update the rig when its runs allow. ${o.place.update ? updateWords(o, to) : selfUpdateWords(o, to)}</p>
<div class="act">${updateAct(o, to)}</div>${update ? updateSteps(o, update) : ""}</div>`;
  if (v.state === "ahead")
    return `<div class="card warn" style="margin-bottom:16px" id="version" data-state="ahead"><div class="card-head">${icon.warn}<span class="title">${esc(o.u.id)} runs Thermite ${esc(runs)}, newer than control's ${esc(to)}.</span></div>
<p class="small" style="margin:6px 0 0">They work together, so nothing stops. Update control when you can.</p></div>`;
  // unknown: a build from before version checks, or a version control cannot compare. Control
  // works with it as before, so the Version fact says it, with no banner; an update's steps show.
  if (!update) return "";
  return `<div class="card" style="margin-bottom:16px" id="version" data-state="unknown"><div class="card-head">${icon.warn}<span class="title">The update to ${esc(to)} ${o.updating ? "is under way" : "stopped"}. Control does not know the rig's version.</span></div>
<p class="small" style="margin:6px 0 0">${esc(v.notice ?? "")}</p>${updateSteps(o, update)}</div>`;
}

/** The banner for a rig off the message bus: broken until it reaches the bus. */
function offBusBanner(o: RigStateInput): string {
  const off = o.offBus;
  if (!off) return "";
  return `<div class="card bad" style="margin-bottom:16px" id="reporting" data-state="broken"><div class="card-head">${icon.x}<span class="title">Broken: ${esc(o.u.id)} is off the message bus.</span></div>
<p class="small" style="margin:6px 0 6px">${esc(off.words)} A rig reaches control only on the bus, so control gets none of its reports and sends it no commands until it does. This since ${esc(ago(off.since, o.now))} ago.</p>
<p class="small" style="margin:0 0 10px"><b>To fix it:</b> ${esc(off.fix)}</p>
<div class="act">${retireMenu(o.u.id, o.csrf)}</div></div>`;
}

/** The banner for the rig's commands the bus did not take: control holds them. */
function heldBanner(o: RigStateInput): string {
  const held = o.held ?? [];
  const first = held[0];
  if (!first) return "";
  const n = held.length;
  return `<div class="card warn" style="margin-bottom:16px" id="held" data-state="held"><div class="card-head">${icon.clock}<span class="title">${n === 1 ? "A command waits" : `${n} commands wait`} for the message bus.</span></div>
<p class="small" style="margin:6px 0 0">${esc(first.why)}, since ${esc(ago(first.since, o.now))} ago: ${esc([...new Set(held.map((h) => h.kind))].join(", "))}. Control holds ${n === 1 ? "it" : "them"}, and publishes ${n === 1 ? "it" : "them"} again by itself as soon as the bus takes ${n === 1 ? "it" : "them"}. Each still expires at its own time.</p></div>`;
}

/** The banner for a rig that does not report: stale, then offline. */
function reportingBanner(o: RigStateInput): string {
  const u = o.u;
  if (u.state === "reporting" || o.podStopped || u.version.state === "refused") return "";
  if (o.offBus) return offBusBanner(o);
  const never = !(Date.parse(u.last_seen) > 0);
  const check = lastCheck(o);
  const checked = check
    ? `Control checked ${esc(o.place.checkWhat)} ${esc(ago(check.at, o.now))} ago. ${esc(check.detail ?? "")}`
    : o.place.check
      ? `Control has not checked ${esc(o.place.checkWhat)} yet. It checks by itself within a minute, or press <b>Check again</b>.`
      : "Control can't reach where this rig runs. Check it there: do its harness and supervisor run, and does the supervisor reach control?";
  const atWork = u.runs.filter((r) => r.status === "running");
  const lanes = atWork.reduce((n, r) => n + Object.keys(r.at_work).length, 0);
  const work = atWork.length
    ? ` Its run${atWork.length === 1 ? "" : "s"} ${atWork.map((r) => esc(r.id)).join(" and ")} had ${lanes} lane${lanes === 1 ? "" : "s"} at work then.`
    : "";
  const acts = [
    o.place.check
      ? button(
          `${rigUrl(u.id)}/check`,
          o.place.kind === "cluster" ? "Check the cluster" : "Check again",
          o.csrf,
        )
      : "",
    o.place.restart ? button(o.place.restart, "Restart the rig", o.csrf) : "",
  ].join("");
  const restartNote = o.place.restart
    ? `<span class="muted small">Restart: the rig's containers start again. A trial at work stops, and the harness plans it again.</span>`
    : "";
  if (u.state === "stale")
    return `<div class="card warn" style="margin-bottom:16px" id="reporting" data-state="stale"><div class="card-head">${icon.clock}<span class="title">No report for ${esc(since(u.last_seen, o.now))}.</span></div>
<p class="small" style="margin:6px 0 6px">Control calls a rig stale after ${minutes(o.staleAfterMs)} without a report, and offline after ${minutes(o.offlineAfterMs)}. Both are settings of control. A stale rig may still be at work: its runs go on, and what they did arrives with its next report. Nothing is lost.</p>
<p class="small" style="margin:0 0 10px">${checked}</p>
${acts || restartNote ? `<div class="act">${acts}${restartNote}</div>` : ""}</div>`;
  return `<div class="card bad" style="margin-bottom:16px" id="reporting" data-state="offline"><div class="card-head">${icon.x}<span class="title">${never ? "Offline: no report yet." : `Offline: no report for ${esc(since(u.last_seen, o.now))}.`}</span></div>
<p class="small" style="margin:6px 0 10px">${never ? "The rig has not reported since it was added." : `Its last report came ${esc(ago(u.last_seen, o.now))} ago, at ${esc(u.last_seen.slice(11, 16))} UTC.${work}`} ${checked} If the rig still runs, what it did since arrives with its next report. Nothing is lost.</p>
<div class="act">${acts}${retireMenu(u.id, o.csrf)}</div></div>`;
}

/**
 * The banners a rig's state needs, in order: whether it reports (and whether it is on the bus),
 * its commands held off the bus, then its version.
 */
export function stateBanners(o: RigStateInput): string {
  const reporting = o.offBus && o.u.state === "reporting" ? offBusBanner(o) : reportingBanner(o);
  return `${reporting}${heldBanner(o)}${versionBanner(o)}`;
}

/** The Version fact of The rig, with its tip. */
export function versionFact(o: Pick<RigStateInput, "u" | "control">): string {
  const v = o.u.version;
  const to = o.control.version;
  const runs = rigVersionWords(v);
  const dd =
    v.state === "current"
      ? `${esc(runs)} <span class="muted">· as control</span>`
      : v.state === "behind"
        ? `${esc(runs)} <span class="muted">· control ${esc(to)} · they work together</span>`
        : v.state === "ahead"
          ? `${esc(runs)} <span class="muted">· newer than control's ${esc(to)} · they work together</span>`
          : v.state === "refused"
            ? `<span class="bad">${esc(runs)}</span> <span class="muted">· control ${esc(to)} can't work with it</span>`
            : `${esc(runs === "no version" ? "not reported" : runs)} <span class="muted">· control ${esc(to)}</span>`;
  return `<dt>${infoLabel("Version", `The Thermite version of the rig's harness and supervisor, as they report it. Control ${to} works with a rig whose protocol, the contract between control and a rig, it speaks. It refuses a rig outside that range, and says why.`)}</dt><dd data-version="${esc(v.state)}">${dd}</dd>`;
}

/**
 * The rig's summary in the top bar: live, stale, offline, broken (off the bus) or refused, and a
 * version that differs.
 */
export function stateSummary(
  o: Pick<RigStateInput, "u" | "control" | "podStopped" | "now" | "offBus">,
) {
  const u = o.u;
  const v = u.version;
  if (v.state === "refused") return `<span class="bad">refused</span> · ${esc(rigVersionWords(v))}`;
  const live = o.podStopped
    ? `<span class="muted">stopped</span>`
    : o.offBus
      ? `<span class="bad">broken</span> · off the message bus`
      : u.state === "reporting"
        ? `<span class="ok">live</span>`
        : u.state === "stale"
          ? `<span class="warn">stale</span> · no report for ${esc(since(u.last_seen, o.now))}`
          : `<span class="bad">offline</span> · ${Date.parse(u.last_seen) > 0 ? `no report for ${esc(since(u.last_seen, o.now))}` : "no report yet"}`;
  const ver =
    v.state === "behind"
      ? ` · <span class="warn">${esc(rigVersionWords(v))}, behind control</span>`
      : v.state === "ahead"
        ? ` · <span class="warn">${esc(rigVersionWords(v))}, ahead of control</span>`
        : "";
  return `${live}${ver}`;
}

/**
 * The lines the rig's state adds to its history: refusals, stale and offline, versions, checks,
 * and changes of its keys on the message bus.
 */
export function stateRows(o: RigStateInput): TimelineRow[] {
  const u = o.u;
  const rows: TimelineRow[] = [];
  const v = u.version;
  const r = v.refused;
  if (r) {
    rows.push({ at: r.since, tone: "bad", html: `Control refused the rig. ${esc(r.reason)}` });
    if (r.calls && r.last_at)
      rows.push({
        at: r.last_at,
        tone: "bad",
        html: `Control refused a call from the rig (${r.calls} call${r.calls === 1 ? "" : "s"} since the refusal began; shown once).`,
      });
  }
  if (v.state === "behind" || v.state === "ahead") {
    const at = [o.controlSince, v.harness?.since, v.supervisor?.since]
      .filter((x): x is string => Boolean(x))
      .reduce((a, b) => (a > b ? a : b), "");
    if (at)
      rows.push({
        at,
        tone: "warn",
        html: `Control runs ${esc(o.control.version)}, and this rig runs ${esc(rigVersionWords(v))}: they work together. ${v.state === "behind" ? "Update the rig when its runs allow." : "Update control when you can."}`,
      });
  }
  const seen = Date.parse(u.last_seen);
  if (seen > 0 && !o.podStopped && v.state !== "refused") {
    if (u.state !== "reporting")
      rows.push({
        at: new Date(seen + o.staleAfterMs).toISOString(),
        tone: "warn",
        html: `Stale: no report for ${minutes(o.staleAfterMs)}.`,
      });
    if (u.state === "offline")
      rows.push({
        at: new Date(seen + Math.max(o.offlineAfterMs, o.staleAfterMs)).toISOString(),
        tone: "bad",
        html: `Offline: no report for ${minutes(Math.max(o.offlineAfterMs, o.staleAfterMs))}.`,
      });
  }
  for (const s of o.steps) {
    if (s.step === "check")
      rows.push({
        at: s.at,
        tone: s.ok ? "ok" : "bad",
        html: `Control checked ${esc(o.place.checkWhat)}: ${esc(s.detail ?? "")}`,
      });
    else if (s.step.startsWith("update_"))
      rows.push({
        at: s.at,
        tone: s.ok ? (s.step === "update_reported" ? "ok" : "") : "bad",
        html: `${esc(UPDATE_STEP_WORDS[s.step] ?? s.step)}${s.detail ? `: ${esc(s.detail)}` : ""}.`,
      });
    // A change of its keys on the bus took effect at once; a refused one did not. Its keys
    // registered over HTTPS, and its calls with none.
    else if (
      (BUS_KEY_CHANGE_STEPS as readonly string[]).includes(s.step) ||
      s.step === BUS_REGISTERED_STEP ||
      s.step === BUS_OFF_STEP
    )
      rows.push({
        at: s.at,
        tone: s.step === BUS_REGISTERED_STEP ? "" : s.ok ? "warn" : "bad",
        html: `${esc(STEP_WORDS[s.step] ?? s.step)}${s.detail ? `: ${esc(s.detail)}` : ""}.`,
      });
  }
  return rows;
}

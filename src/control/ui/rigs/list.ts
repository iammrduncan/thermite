import type { BuildInfo } from "../../../core/version.ts";
import type { OffBus } from "../../bus/index.ts";
import { rigVersionWords } from "../../rigs/index.ts";
import type { RunpodRigView } from "../../runpod/index.ts";
import { type RigView, runCampaign } from "../../views/index.ts";
import { infoLabel } from "../campaigns/new/index.ts";
import { esc, hardwareLine } from "../components/index.ts";
import { runFigure } from "../operator/index.ts";
import { runHref } from "../urls.ts";
import { span } from "../words/index.ts";
import { podRuns } from "./runpod.ts";

/**
 * The Rigs list (goals 012 and 022): one row for each rig, to scan. Its state, where it runs and
 * on what, its version (with "needs update", which opens the rig's page, where the update runs),
 * the run at work and its progress, its last report, and a RunPod rig's price. The checks, keys,
 * history and the update itself are on each rig's page. The filters are links, so the list works
 * without the script; the script only makes a whole row open its rig.
 */

/** Where a rig runs: the kind of place ("Machine", "Cluster", "RunPod"...) and its name. */
export interface RigWhere {
  kind: string;
  name: string;
}

export interface RigsListRow {
  id: string;
  /** The rig's view; undefined for a RunPod rig that has not reported yet. */
  u?: RigView | undefined;
  where: RigWhere;
  /** The pod of a rig launched on RunPod. */
  pod?: RunpodRigView | undefined;
  /** A key from the rig waits for the owner. */
  keyPending: boolean;
  /** Why it is off the message bus, and so broken; undefined while nothing says so. */
  offBus?: OffBus | undefined;
}

const RIG_FILTERS = ["all", "live", "update", "refused", "lost", "runpod", "stopped"] as const;
export type RigFilter = (typeof RIG_FILTERS)[number];

const FILTER_WORDS: Record<RigFilter, string> = {
  all: "All",
  live: "Live",
  update: "Needs update",
  refused: "Refused",
  lost: "Stale, offline or broken",
  runpod: "On RunPod",
  stopped: "Stopped",
};

type StateKey = "live" | "stale" | "offline" | "broken" | "refused" | "stopped" | "key" | "ready";
const STATES: Record<StateKey, [string, string]> = {
  live: ["Live", "ok"],
  broken: ["Broken: off the bus", "bad"],
  stale: ["Stale", "warn"],
  offline: ["Offline", "bad"],
  refused: ["Refused", "bad"],
  stopped: ["Stopped", ""],
  key: ["Key to accept", "warn"],
  ready: ["Getting ready", "info"],
};

const rigUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}`;
const sub = (html: string) => `<span class="rsub">${html}</span>`;
const money = (usd: number) => `$${usd.toFixed(2)}`;
/** "12 s ago", "3 h 12 min ago". */
const since = (iso: string, now: number) => `${span(iso, now) || "0 s"} ago`;
const reported = (u: RigView | undefined) => Boolean(u && Date.parse(u.last_seen) > 0);

/** A pod control follows that is stopped at RunPod: not stale nor offline, just stopped. */
const stoppedPod = (p: RunpodRigView | undefined) => Boolean(p?.active && p.status === "EXITED");

/** The row's state: refused first, then a stopped pod, off the bus, then whether it reports. */
function rowState(r: RigsListRow): StateKey {
  if (r.u?.version.state === "refused") return "refused";
  if (stoppedPod(r.pod)) return "stopped";
  if (r.offBus) return "broken";
  if (!r.u) return "ready";
  if (r.keyPending) return "key";
  return r.u.state === "reporting" ? "live" : r.u.state;
}

/** A rig that needs an update: behind control, or refused for its version. */
const needsUpdate = (r: RigsListRow) =>
  r.u?.version.state === "behind" || r.u?.version.state === "refused";

/** The filters a row shows under. */
function rowFilters(r: RigsListRow): RigFilter[] {
  const st = rowState(r);
  const out: RigFilter[] = ["all"];
  if (st === "live") out.push("live");
  if (needsUpdate(r)) out.push("update");
  if (st === "refused") out.push("refused");
  if (
    st === "stale" ||
    st === "offline" ||
    st === "broken" ||
    (st === "key" && r.u?.state !== "reporting")
  )
    out.push("lost");
  if (r.pod) out.push("runpod");
  if (st === "stopped") out.push("stopped");
  return out;
}

/** Where a row opens the rig's page: at the banner of its state, if it has one. */
function rowHref(r: RigsListRow): string {
  const st = rowState(r);
  const at =
    st === "refused" || r.u?.version.state === "behind"
      ? "#version"
      : st === "stale" || st === "offline" || st === "broken"
        ? "#reporting"
        : st === "stopped"
          ? "#pod"
          : "";
  return `${rigUrl(r.id)}${at}`;
}

/** The Version cell: the rig's version, with "needs update" when it is behind or refused. */
function versionCell(r: RigsListRow): string {
  const u = r.u;
  if (!u) return `<span class="muted">not reported yet</span>`;
  const v = u.version;
  const runs = rigVersionWords(v);
  const chip = (tone: string, text: string, line: string, title: string) =>
    `<a class="chip ${tone} vchip" href="${rigUrl(r.id)}#version" title="${esc(title)}">${esc(text)} ›</a>${sub(esc(line))}`;
  const update = "Open the rig's page to update it";
  if (v.state === "behind") return chip("warn", "needs update", `${runs} · behind`, update);
  if (v.state === "refused")
    // A rig newer than control can work with: control needs the update, not the rig.
    return /Update control\.$/.test(v.refused?.reason ?? "")
      ? chip(
          "bad",
          "update control",
          `${runs} · refused, newer`,
          "Open the rig's page: control needs the update",
        )
      : chip("bad", "needs update", `${runs} · refused`, update);
  if (v.state === "ahead")
    return `<span class="warn">${esc(runs)}</span>${sub("newer than control")}`;
  if (v.state === "unknown")
    return `<span class="muted">${esc(runs === "no version" ? "not reported" : runs)}</span>`;
  return `<span class="muted">${esc(runs)}</span>`;
}

/** Why a stopped pod stopped, and what starts it again, in words. */
function stoppedWords(p: RunpodRigView, now: number): string {
  const when = p.stopped_at ? ` ${since(p.stopped_at, now)}` : "";
  if (p.stopped_by === "spend_limit")
    return `its spend limit stopped it${when} · raise the limit to start it`;
  const why =
    p.stopped_by === "idle_stop"
      ? `its idle stop stopped it${when}`
      : p.stopped_by === "owner"
        ? `you stopped it${when}`
        : "it is stopped";
  return `${why} · a new run wakes it`;
}

/** The Run at work and Progress cells: the rig's running run, as of its last report. */
function runCells(r: RigsListRow, st: StateKey, now: number): [string, string] {
  const u = r.u;
  if (u?.unreadable)
    return [`<span class="bad">Its events can't be read now</span>${sub(esc(u.unreadable))}`, ""];
  const atWork = u?.runs.filter((x) => x.status === "running") ?? [];
  const run = atWork[0];
  if (!u || !run) {
    const line =
      r.pod && st === "stopped"
        ? stoppedWords(r.pod, now)
        : !u
          ? "not reported yet"
          : u.runs.some((x) => x.status === "paused")
            ? `${u.runs.filter((x) => x.status === "paused").length} paused`
            : u.runs.length
              ? "no run running"
              : "no campaign assigned";
    return [`<span class="muted">No run at work</span>${sub(esc(line))}`, ""];
  }
  const live = st === "live";
  const last = run.attempts
    .map((a) => a.updated_at)
    .sort()
    .at(-1);
  const line = live
    ? last
      ? `last attempt ${since(last, now)}`
      : "no attempt yet"
    : st === "refused" && reported(u)
      ? `as of ${since(u.last_seen, now)}`
      : "as of its last report";
  const more = atWork.length > 1 ? ` · and ${atWork.length - 1} more` : "";
  const fig = runFigure(run);
  const prog =
    fig === null
      ? `<span class="muted small">goals not checked yet</span>`
      : live
        ? `<b class="fig">${esc(fig)}</b>`
        : `<span class="muted">${esc(fig)}</span>`;
  return [
    `<a class="nowrap${live ? "" : " muted"}" href="${runHref(run)}">${esc(run.id)}</a>${sub(`${esc(runCampaign(run))} · ${esc(line)}${more}`)}`,
    prog,
  ];
}

/** The Last report cell: how long ago, toned by the state. */
function lastCell(r: RigsListRow, st: StateKey, now: number): string {
  const u = r.u;
  if (!u || !reported(u)) return `<span class="muted">none yet</span>`;
  const ago = esc(since(u.last_seen, now));
  if (st === "refused") return `<span class="bad">${ago}</span>${sub("refused since")}`;
  if (st === "stopped") return `${ago}${sub("then it stopped")}`;
  if (u.state === "stale") return `<span class="warn">${ago}</span>`;
  if (u.state === "offline") return `<span class="bad">${ago}</span>`;
  return ago;
}

/** The Per hour cell of a RunPod rig: what it costs now, and what it has cost so far. */
function costCell(p: RunpodRigView | undefined): string {
  if (!p) return "";
  const spent = p.spend_usd ?? p.spent_usd;
  if (!p.active || p.status === "TERMINATED") return `none${sub(`${money(spent)} in all`)}`;
  if (!podRuns(p)) return `storage only${sub(`${money(spent)} so far`)}`;
  return `${p.price_per_hr === null ? "–" : `<b>${money(p.price_per_hr)}/h</b>`}${sub(`${money(spent)} so far`)}`;
}

/** The hardware line under where it runs: what it reported, or the pod's GPUs before that. */
function hardwareOf(r: RigsListRow): string {
  const h = hardwareLine(r.u?.hardware ?? null);
  if (h) return h;
  return r.pod ? `${r.pod.gpu_count}× ${esc(r.pod.gpu_name)}` : "";
}

function rowHtml(r: RigsListRow, perHour: boolean, now: number): string {
  const st = rowState(r);
  const [word, tone] = STATES[st];
  const href = rowHref(r);
  const [run, prog] = runCells(r, st, now);
  const where = r.where.kind
    ? `<span class="nowrap">${esc(r.where.kind)}${r.where.name ? ` <span class="muted">· ${esc(r.where.name)}</span>` : ""}</span>`
    : "";
  const hw = hardwareOf(r);
  return `<tr class="click" data-href="${esc(href)}"><td><span class="chip ${tone}">${esc(word)}</span></td><td class="nowrap"><a class="kname" href="${esc(href)}"><b>${esc(r.id)}</b></a></td><td>${where}${hw ? sub(hw) : ""}</td><td class="nowrap">${versionCell(r)}</td><td>${run}</td><td class="num nowrap">${prog}</td><td class="nowrap">${lastCell(r, st, now)}</td>${perHour ? `<td class="num nowrap">${costCell(r.pod)}</td>` : ""}</tr>`;
}

/** The runs at work: running runs on rigs that report or may still be at work (stale). */
function runsAtWork(rows: RigsListRow[]): number {
  return rows
    .filter((r) => ["live", "stale", "key"].includes(rowState(r)))
    .reduce((n, r) => n + (r.u?.runs.filter((x) => x.status === "running").length ?? 0), 0);
}

/** The line beside the title: rigs, those that need an update, stale, offline, stopped, runs. */
export function rigsSummary(rows: RigsListRow[]): string {
  const states = rows.map(rowState);
  const n = (k: StateKey) => states.filter((s) => s === k).length;
  const update = rows.filter(needsUpdate).length;
  const runs = runsAtWork(rows);
  return [
    `${rows.length} rig${rows.length === 1 ? "" : "s"}`,
    update ? `${update} need${update === 1 ? "s" : ""} an update` : "",
    n("stale") ? `${n("stale")} stale` : "",
    n("offline") ? `${n("offline")} offline` : "",
    n("broken") ? `${n("broken")} broken, off the bus` : "",
    n("stopped") ? `${n("stopped")} stopped` : "",
    `${runs} run${runs === 1 ? "" : "s"} at work`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function rigsListBody(o: {
  rows: RigsListRow[];
  filter: RigFilter;
  control: BuildInfo;
  staleAfterMs: number;
  offlineAfterMs: number;
  now: number;
}): string {
  const count = (f: RigFilter) => o.rows.filter((r) => rowFilters(r).includes(f)).length;
  const chip = (f: RigFilter) =>
    `<a class="fchip${o.filter === f ? " on" : ""}" href="/ui/rigs${f === "all" ? "" : `?f=${f}`}">${esc(FILTER_WORDS[f])} <span class="n">${count(f)}</span></a>`;
  const shown = o.rows.filter((r) => rowFilters(r).includes(o.filter));
  // The Per hour column only when a rig runs on RunPod.
  const perHour = o.rows.some((r) => r.pod);
  const minutes = (ms: number) => {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"}`;
  };
  const stateTip = `Live: it reports. Stale: no report for ${minutes(o.staleAfterMs)}. Offline: none for ${minutes(o.offlineAfterMs)}. Refused: control refuses its reports, because their versions don't work together. Stopped: a RunPod pod that is stopped, so it can't report. Key to accept: its new key waits for you. Getting ready: a RunPod pod before its first report.`;
  const versionTip = `The Thermite version of the rig's harness and supervisor. Needs update: the rig is behind control ${o.control.version}, or so old that control refuses it. Open it to update it on the rig's page. Update control: the rig is too new for control.`;
  if (!o.rows.length)
    return `<div class="card"><div class="empty">No rig has reported yet.</div></div>`;
  const rows = shown.map((r) => rowHtml(r, perHour, o.now)).join("");
  return `<div class="ktools" id="rf">${RIG_FILTERS.map(chip).join("")}</div>
${
  rows
    ? `<div class="card flat" style="overflow-x:auto"><table class="ktable rtable"><thead><tr><th style="width:84px">${infoLabel("State", stateTip)}</th><th>Rig</th><th>Where it runs</th><th>${infoLabel("Version", versionTip)}</th><th>Run at work</th><th class="num">Progress</th><th>Last report</th>${perHour ? `<th class="num">Per hour</th>` : ""}</tr></thead><tbody id="rows">${rows}</tbody></table></div>`
    : `<div class="card"><div class="empty">No rig here.</div></div>`
}
<div class="muted small" style="margin-top:8px">Checks, keys, history and the update are on each rig's page.${perHour ? " Per hour: what a RunPod rig costs now." : ""}</div>`;
}

/** The filter a request asks for; anything else is All. */
export function rigFilter(q: string | undefined): RigFilter {
  return RIG_FILTERS.find((f) => f === q) ?? "all";
}

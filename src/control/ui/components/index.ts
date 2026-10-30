import type { Hardware } from "../../../core/hardware.ts";
import { isRigCheck } from "../../../core/ids.ts";
import { ANSWERED, RESEARCH_REVIEW } from "../../../core/research-check.ts";
import { SCREENED_VERDICTS, WON_VERDICTS } from "../../../core/verdicts.ts";
import {
  type CampaignView,
  campaignViews,
  championsInForce,
  championWords,
  newestRun,
  podStopped,
  type RigView,
  type RunView,
} from "../../views/index.ts";
import { STYLE } from "../style/index.ts";
import { campaignHref } from "../urls.ts";
import { ICON_LINKS } from "./icons.ts";

export {
  bestGainWords,
  championCard,
  gainChip,
  measuredWords,
  startWords,
  valuesPairWords,
} from "./gains.ts";
export { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG, ICON_LINKS } from "./icons.ts";
export { MD_CORE_JS, mdHtml } from "./markdown.ts";
export { card } from "./need-card.ts";

/** Everything the dashboard writes into HTML goes through esc (rig data is never markup). */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A long text shown in part, with "more" to read it whole. A details element, so it works without
 * the page's script.
 */
export function moreText(text: string, n: number): string {
  if (text.length <= n) return esc(text);
  return `<details class="more"><summary><span class="more-part">${esc(`${text.slice(0, n - 1)}…`)}</span> <span class="more-tog"></span></summary>${esc(text)}</details>`;
}

/** A label with its info icon: hovering or focusing the icon shows what the field means. */
export const infoLabel = (text: string, tip: string) =>
  `<span class="lb">${esc(text)}<i class="ii" tabindex="0" data-tip="${esc(tip)}">i</i></span>`;

export const pct = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? ""
    : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;

export const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.round(s / 60)}m`
      : s < 172_800
        ? `${Math.round(s / 3600)}h`
        : `${Math.round(s / 86_400)}d`;
};

export const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
export const fmtInt = (x: number) =>
  x >= 1e6
    ? `${(x / 1e6).toFixed(1)}M`
    : x >= 1e4
      ? `${Math.round(x / 1e3)}k`
      : String(Math.round(x));

// ---------------------------------------------------------------- icons (16 px, stroke)
const svg = (d: string, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icon = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  rigs: svg(
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  ),
  trophy: svg(
    '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  ),
  live: svg('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V7"/><path d="M18 17v-8"/>'),
  terminal: svg(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  ),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  file: svg(
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  ),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  book: svg(
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  ),
  warn: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>', 14),
  check: svg('<path d="m5 12 5 5 9-10"/>', 14),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>', 14),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 14),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>', 14),
  pause: svg('<path d="M9 5v14M15 5v14"/>', 14),
  play: svg('<path d="m7 4 13 8-13 8z"/>', 14),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 16),
  copy: svg(
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  ),
  dots: svg('<path d="M5 12h.01M12 12h.01M19 12h.01"/>', 16),
  folder: svg(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    15,
  ),
  newFolder: svg(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
    15,
  ),
  chevron: svg('<path d="m9 6 6 6-6 6"/>', 12),
  down: svg('<path d="m6 9 6 6 6-6"/>', 12),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 14),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
  record: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  blurb: svg('<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>'),
  doc: svg(
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  ),
  archive: svg(
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
    14,
  ),
  chip: svg(
    '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    18,
  ),
  cpu: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>', 18),
  logout: svg('<path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3"/>'),
  cog: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
};

// ---------------------------------------------------------------- small parts
/** A stable colour per name (the same rig or campaign always gets the same chip). */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 8;
}
export function avatar(name: string, large = false): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = (
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2)
  ).toUpperCase();
  return `<span class="av c${hue(name)}${large ? " lg" : ""}">${esc(letters)}</span>`;
}
const MODE: Record<string, [string, string]> = {
  hill_climb: ["HC", "hill climb"],
  goal: ["GL", "goal"],
  research: ["RS", "research"],
};
export function modeAvatar(mode: string | null): string {
  const m = MODE[mode ?? ""] ?? ["??", "campaign"];
  return `<span class="av c${mode === "hill_climb" ? 7 : mode === "goal" ? 5 : 1}" title="${esc(m[1])}">${m[0]}</span>`;
}
export const modeName = (mode: string | null) => MODE[mode ?? ""]?.[1] ?? mode ?? "";

/**
 * What a judge-only run (started with its agents off) says on its page (goal 099): the owner
 * could not tell such a run from one whose workers had not started.
 */
export const JUDGE_ONLY_WORDS =
  "No workers run. The judge checks the champion; the advisors' ideas wait in the queue for a run with workers.";

/** A judge-only run's mark beside its name in lists and cards (goal 099). */
export const judgeOnlyMark = (r: Pick<RunView, "has_agents">) =>
  r.has_agents === false
    ? ` <span class="chip" title="Started with its agents off: no workers run on it, and the judge works alone.">judge only</span>`
    : "";

/**
 * A closed goal run whose newest goal report met its goals for good (goal 099), or a research run
 * that closed because the review panel found every question answered (goal 112).
 */
export const runCompleted = (
  i: Pick<RunView, "status" | "mode" | "goals_complete"> & {
    pause_reason?: string | null | undefined;
  },
) =>
  i.status === "closed" &&
  ((i.mode === "goal" && i.goals_complete === true) ||
    (i.mode === "research" && i.pause_reason === ANSWERED));

/**
 * Why the review panel can't check a research run on this rig (goal 112), or "": the review panel
 * is off on the rig, or its supervisor has none set up. Unknown (no report yet) is not a reason.
 */
function noReviewPanel(u: Pick<RigView, "supervisor" | "settings">): string {
  if (u.settings?.review === false) return "the review panel is off on this rig (Edit rig)";
  const sup = u.supervisor as { advisors?: { roles?: Record<string, unknown> } | null } | null;
  const roles =
    sup && "advisors" in sup ? (sup.advisors === null ? {} : sup.advisors?.roles) : undefined;
  return roles !== undefined && !(Number(roles.review_panel) > 0)
    ? "this rig's supervisor has no review panel set up"
    : "";
}

/**
 * Where a research run's answer check stands (goal 112), in one line for its Overview: before
 * the minimum running time, waiting for verified claims, the review panel checking, not yet (with
 * the newest gaps), passed and waiting for the owner, answered with the final writer writing the
 * paper, answered with the paper in, or ended. From the newest digest or final report, the run's
 * research reviews and its paper's events.
 */
export function researchCheckWords(
  i: RunView,
  u: Pick<RigView, "supervisor" | "settings">,
): string {
  const newest = i.reviews.filter((r) => r.goal === RESEARCH_REVIEW).at(-1);
  const which = newest ? ` (review ${newest.review})` : "";
  const paper = i.paper;
  const final = (i.research ?? {}) as { kind?: unknown; no_paper?: unknown };
  if (i.status === "closed") {
    if (i.pause_reason !== ANSWERED)
      return "The run ended before the review panel found every question answered: its final report says so.";
    if (paper?.state === "in")
      return `Answered: the review panel found every question answered${which}. The final report starts with the research paper, then the review panel's answers and its verdicts on the hypotheses.`;
    const none =
      final.kind === "final" && typeof final.no_paper === "string"
        ? ` There is no research paper: ${final.no_paper}.`
        : "";
    return `Answered: the review panel found every question answered${which}. The final report holds its answers and its verdicts on the hypotheses.${none}`;
  }
  // The final writer's paper (goal 112): asked for, being written, then in.
  if (newest?.owner === "accepted" && paper?.state === "in")
    return `Answered: the review panel found every question answered${which}. The research paper is in${paper.ste_checked ? ", checked against the rig's STE checker" : ", not checked for STE (the rig has no checker)"}. The run ends once its running trials end.`;
  if (newest?.owner === "accepted" && paper?.state === "writing")
    return `Answered: the review panel found every question answered${which}. The final writer is writing the paper${paper.refused ? `; the harness refused its last draft (${paper.refused.problems[0] ?? "see History"})` : ""}. The run ends once the paper is in and its running trials end.`;
  if (newest?.owner === "accepted")
    return `Answered: the review panel found every question answered${which}. The run writes its final report and ends once its running trials end.`;
  if (newest && newest.panel === null) {
    const none = noReviewPanel(u);
    return none
      ? `The check waits for a review panel: ${none}. The run keeps researching.`
      : `The review panel checks whether every question is answered${which}.`;
  }
  if (newest?.panel === "review_passed" && !newest.owner)
    return `The review panel found every question answered${which}. It waits for your acceptance in Needs you.`;
  const d = (i.research ?? {}) as Record<string, unknown>;
  const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
  const min = num(d.min_ms);
  if (min > 0 && num(d.elapsed_ms) < min)
    return `The check starts once the run has run for its minimum, ${hours(min)}. At the newest digest it had run ${hours(num(d.elapsed_ms))}.`;
  const qs = Array.isArray(d.questions) ? (d.questions as { verified?: unknown }[]) : [];
  const bare = qs.flatMap((q, n) => (num(q.verified) === 0 ? [n + 1] : []));
  if (bare.length)
    return `Waiting for a verified claim on question${bare.length === 1 ? "" : "s"} ${bare.join(", ")}.`;
  const floor = num(d.min_verified_claims);
  if (floor > 0 && num(d.verified) < floor)
    return `Waiting for verified claims: ${num(d.verified)} of the ${floor} the campaign asks for.`;
  if (newest?.panel === "review_failed") {
    const gaps = (newest.gaps ?? []).slice(0, 2).join("; ");
    return `Not yet: review ${newest.review} found gaps${gaps ? `: ${gaps}` : ""}. The run goes on, and the review panel is asked again on new evidence.`;
  }
  if (newest?.owner === "rejected")
    return `Not yet: you did not accept review ${newest.review}. The run goes on, and the review panel is asked again on new evidence.`;
  return "The review panel is asked at the next digest whether every question is answered.";
}

/**
 * What a run needs, or is doing, as one coloured label (Magnesium's status words). A paused run
 * reads as paused whatever waits in it: its decisions show in Needs you. A closed run reads
 * Completed when it met its goals (goal 099), else Finished.
 */
export function runState(i: RunView): { text: string; cls: string; icon: string } {
  // A blocked result waits on the owner; an open audit is the auditor's to decide (goal 079).
  const blocked = i.audits.some((a) => a.decision === "block");
  const auditing = i.audits.some((a) => a.decision === null);
  if (runCompleted(i)) return { text: "Completed", cls: "ok", icon: icon.check };
  if (i.status === "closed") return { text: "Finished", cls: "muted", icon: icon.check };
  if (i.status === "paused") return { text: "Paused", cls: "muted", icon: icon.pause };
  if (i.pending_promotions.length) return { text: "Approval", cls: "warn", icon: icon.warn };
  if (i.conclusions.some((c) => c.decision === null))
    return { text: "Decision", cls: "warn", icon: icon.warn };
  if (i.reviews.some((r) => r.panel === "review_passed" && !r.owner))
    return { text: "Review", cls: "violet", icon: icon.warn };
  if (blocked) return { text: "Audit", cls: "warn", icon: icon.shield };
  if (auditing) return { text: "Auditing", cls: "info", icon: icon.shield };
  return { text: "Running", cls: "info", icon: icon.live };
}

/**
 * A campaign's state (goal 099): while a run of it is at work, or needs the owner, the most
 * urgent of those runs' states; otherwise its newest run's (Completed, Finished or Paused), so an
 * older paused run does not hide that the newest one completed.
 */
export function campaignState(k: CampaignView): { text: string; cls: string; icon: string } {
  const order = ["Approval", "Decision", "Review", "Audit", "Auditing", "Running"];
  const live = k.runs
    .map((x) => runState(x.run))
    .filter((s) => order.includes(s.text))
    .sort((a, b) => order.indexOf(a.text) - order.indexOf(b.text))[0];
  const newest = newestRun(k);
  return live ?? (newest ? runState(newest.run) : { text: "Idle", cls: "muted", icon: "" });
}

/**
 * After a rig's name, when it does not report: a RunPod pod that is stopped can't report, which
 * is expected, so it says so; any other rig is not reporting.
 */
export const reportingTag = (u: Pick<RigView, "stale" | "runpod">): string =>
  podStopped(u)
    ? ` <span class="muted">(its pod is stopped)</span>`
    : u.stale
      ? ` <span class="bad">(not reporting)</span>`
      : "";
export function label(text: string, cls: string, ic = ""): string {
  return `<span class="label ${cls}">${ic}${esc(text)}</span>`;
}

export function meter(k: string, v: string, fraction: number, cls = ""): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return `<div class="meter"><span class="k">${esc(k)}</span><span></span><span class="v">${esc(v)}</span><div class="bar ${cls}"><i style="width:${(f * 100).toFixed(1)}%"></i></div></div>`;
}

export function kpi(k: string, v: string, s = "", cls = ""): string {
  return `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
}

/** Verdict colours, shared by the stacked bar, chips and legends. */
export function verdictColor(v: string): string {
  if (WON_VERDICTS.includes(v) || ["promoted", "met", "starting_point"].includes(v))
    return "var(--success)";
  if (SCREENED_VERDICTS.includes(v)) return "color-mix(in srgb, var(--success) 55%, transparent)";
  if (v === "regress" || v === "crash_candidate" || v === "unmet") return "var(--error)";
  if (v === "invalid" || v === "rejected_v0" || v === "duplicate") return "var(--warning)";
  if (v === "queued" || v === "judging" || v === "evaluating") return "var(--info)";
  if (v === "inconclusive" || v === "crash_infra") return "#d4d4d8";
  return "#a1a1aa";
}
export function verdictChip(v: string | null, lifecycle: string): string {
  const k = v ?? lifecycle;
  const cls =
    WON_VERDICTS.includes(k) || k === "promoted" || k === "starting_point"
      ? "ok"
      : k === "regress" || k === "crash_candidate"
        ? "bad"
        : k === "invalid" ||
            k === "rejected_v0" ||
            k === "duplicate" ||
            k === "awaiting_audit" ||
            k === "awaiting_approval"
          ? "warn"
          : k === "queued" || k === "screening" || k === "confirming"
            ? "info"
            : "";
  return `<span class="chip ${cls}">${esc(k.replace(/_/g, " "))}</span>`;
}

export function stackBar(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return `<div class="empty">No attempts yet.</div>`;
  return `<div class="stack-bar">${entries
    .map(
      ([k, n]) =>
        `<i style="width:${((100 * n) / total).toFixed(2)}%;background:${verdictColor(k)}" title="${esc(k)} ${n}"></i>`,
    )
    .join("")}</div><div class="legend">${entries
    .map(
      ([k, n]) =>
        `<span><span class="sw" style="background:${verdictColor(k)}"></span>${esc(k.replace(/_/g, " "))} <b>${n}</b></span>`,
    )
    .join("")}</div>`;
}

export function deltaCell(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return `<span class="muted">·</span>`;
  const w = Math.min(60, Math.round(Math.abs(d) * 600));
  return `<span class="delta ${d > 0 ? "ok" : d < 0 ? "bad" : "muted"}"><i style="width:${w}px;background:currentColor;opacity:.5"></i>${pct(d)}</span>`;
}

/** The champion's gain over time: a stepped line with an area, promotions marked. */
export function gainChart(v: RunView, w = 760, h = 200): string {
  const steps = championsInForce(v);
  if (steps.length < 2)
    return `<div class="empty">No promotion yet: the champion is the seed.</div>`;
  const padL = 46;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const now = Date.now();
  const ts = steps.map((s) => Date.parse(s.at));
  const t0 = Math.min(...ts);
  const t1 = Math.max(now, ...ts, t0 + 1);
  const ys = steps.map((s) => s.cumulative - 1);
  const y0 = Math.min(0, ...ys);
  const y1 = Math.max(...ys, y0 + 0.001) * 1.12;
  const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * (w - padL - padR);
  const Y = (y: number) => padT + ((y1 - y) / (y1 - y0)) * (h - padT - padB);
  let d = "";
  steps.forEach((_s, i) => {
    const x = X(ts[i] as number);
    const y = Y(ys[i] as number);
    d += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` H${x.toFixed(1)} V${y.toFixed(1)}`;
  });
  const lastY = Y(ys.at(-1) as number);
  d += ` H${X(t1).toFixed(1)}`;
  const area = `${d} V${Y(y0).toFixed(1)} H${X(t0).toFixed(1)} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => y0 + f * (y1 - y0))
    .map(
      (y) =>
        `<line class="grid" x1="${padL}" x2="${w - padR}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/><text x="${padL - 8}" y="${(Y(y) + 4).toFixed(1)}" text-anchor="end">${pct(y, 0)}</text>`,
    )
    .join("");
  const fmt = (t: number) => {
    const dt = new Date(t);
    return `${dt.toISOString().slice(5, 10)} ${dt.toISOString().slice(11, 16)}`;
  };
  const pts = steps
    .slice(1)
    .map(
      (s, i) =>
        `<circle class="pt" cx="${X(ts[i + 1] as number).toFixed(1)}" cy="${Y(ys[i + 1] as number).toFixed(1)}" r="3.5"><title>seq ${s.seq} · ${pct(s.cumulative - 1)} · ${esc(s.at.slice(0, 16))}</title></circle>`,
    )
    .join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="champion gain over time">${grid}
<path class="area" d="${area}"/><path class="line" d="${d}"/>${pts}
<text x="${padL}" y="${h - 6}">${esc(fmt(t0))}</text><text x="${w - padR}" y="${h - 6}" text-anchor="end">now</text>
<text x="${(X(t1) - 4).toFixed(1)}" y="${(lastY - 8).toFixed(1)}" text-anchor="end" style="fill:var(--foreground);font-weight:600">${pct(ys.at(-1) as number)}${championWords(v) ? ` · ${esc(championWords(v))}` : ""}</text></svg>`;
}

/** A small sparkline of the champion's gain, for tiles and lists. */
export function sparkline(v: RunView, w = 120, h = 28): string {
  const steps = championsInForce(v);
  if (steps.length < 2) return "";
  const ts = steps.map((s) => Date.parse(s.at));
  const t0 = Math.min(...ts);
  const t1 = Math.max(Date.now(), t0 + 1);
  const ys = steps.map((s) => s.cumulative - 1);
  const y1 = Math.max(...ys, 0.001);
  const X = (t: number) => 1 + ((t - t0) / (t1 - t0)) * (w - 2);
  const Y = (y: number) => h - 2 - (y / y1) * (h - 4);
  let d = "";
  steps.forEach((_s, i) => {
    d +=
      i === 0
        ? `M${X(ts[i] as number).toFixed(1)},${Y(ys[i] as number).toFixed(1)}`
        : ` H${X(ts[i] as number).toFixed(1)} V${Y(ys[i] as number).toFixed(1)}`;
  });
  d += ` H${X(t1).toFixed(1)}`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:${w}px" aria-hidden="true"><path class="line" style="stroke-width:1.5" d="${d}"/></svg>`;
}

// ---------------------------------------------------------------- the page shell
export interface Shell {
  title: string;
  /** Muted text after the title. */
  summary?: string | undefined;
  /** Breadcrumb links before the title. */
  crumbs?: { href: string; text: string }[] | undefined;
  actions?: string | undefined;
  active:
    | "overview"
    | "campaigns"
    | "rigs"
    | "metrics"
    | "live"
    | "knowledge"
    | "commands"
    | "reports"
    | "exports"
    | "audit"
    | "settings"
    | "";
  rigs: RigView[];
  needs: number;
  now: number;
  /** A full-height content area without padding (the live view). */
  flush?: boolean | undefined;
  /** The left navigation's folders and archived campaigns (goal 077); none: no folders. */
  nav?: NavCampaigns | undefined;
  /** The left navigation shows only its icons: the owner collapsed it in this browser (NAV_COOKIE). */
  rail?: boolean | undefined;
}

/**
 * The cookie that keeps the left navigation collapsed in one browser, `rail` when it is: control
 * reads it for each page, so a collapsed navigation is drawn so, before the page's script runs.
 */
export const NAV_COOKIE = "thermite_nav";

/** What the left navigation shows of the campaigns besides their runs (goal 077). */
export interface NavCampaigns {
  /** The folders, in order, each with the campaigns in it. */
  folders: { id: number; name: string; campaigns: string[] }[];
  /** Archived campaigns: not in the navigation. */
  archived: ReadonlySet<string>;
  /** The form token for New folder and the folders' menus. */
  csrf: string;
  /** Where the folders' forms return (a path under /ui). */
  back: string;
  /** The campaign whose page this is, marked in the list. */
  current?: string | undefined;
}

/** A folder's name in the navigation, at most this long (campaigns/folders.ts checks it too). */
const FOLDER_NAME_MAX = 40;
const FOLDER_TIP =
  "A folder groups campaigns in this navigation, and nothing else: a campaign's runs, results and collection in the knowledge base stay as they are. Up to 40 characters; each name once.";

/** What an empty folder says: a folder that holds only archived campaigns says so. */
export const emptyFolder = (archived: number) =>
  archived
    ? `${archived} archived ${archived === 1 ? "campaign" : "campaigns"}, not shown.`
    : "Empty. Drag a campaign here.";

/**
 * The campaigns in the left navigation (goal 077): folders first, each with its campaigns, then
 * the campaigns in no folder. Every campaign that is not archived shows, finished ones too, with
 * its state; a rig check only while it is at work. An archived campaign keeps its folder, but the
 * folder neither shows nor counts it. A row can be dragged onto a folder, or onto
 * "no folder" (client.ts sends the move); a folder folds, and the browser remembers it. Without
 * the script, the folders' forms and the campaign page's Move to folder still work.
 */
function navCampaigns(camps: CampaignView[], nav: NavCampaigns | undefined): string {
  const archived = nav?.archived ?? new Set<string>();
  // A rig check's campaign (the smoke run a rig check starts) shows only while it is at work.
  const shown = camps.filter(
    (k) =>
      !archived.has(k.name) &&
      (!isRigCheck(k.name) || k.runs.some((x) => x.run.status === "running")),
  );
  const row = (k: CampaignView) => {
    const st = campaignState(k);
    return `<a class="side-row" href="${campaignHref(k.name)}" draggable="true" data-campaign="${esc(k.name)}"${nav?.current === k.name ? ` aria-current="page"` : ""}>${modeAvatar(k.mode)}<span class="name">${esc(k.name)}</span><span class="right label ${st.cls}">${esc(st.text)}</span></a>`;
  };
  const hidden = (back: string) =>
    nav
      ? `<input type="hidden" name="csrf" value="${esc(nav.csrf)}"><input type="hidden" name="back" value="${esc(back)}">`
      : "";
  const filed = new Set<string>();
  const folders = (nav?.folders ?? [])
    .map((f) => {
      const rows = shown.filter((k) => f.campaigns.includes(k.name));
      for (const k of rows) filed.add(k.name);
      // An archived campaign keeps its folder, but neither shows in it nor counts.
      const shelved = f.campaigns.filter((c) => archived.has(c)).length;
      return `<div class="side-fold" data-folder="${f.id}"><details class="side-folder" open data-fold="${f.id}" data-archived="${shelved}"><summary>${icon.chevron}${icon.folder}<span class="fname">${esc(f.name)}</span><span class="n">${rows.length}</span></summary>${rows.map(row).join("") || `<div class="side-empty">${emptyFolder(shelved)}</div>`}</details><details class="fmenu"><summary class="ib" title="Rename or delete" aria-label="${esc(f.name)}: rename or delete">${icon.dots}</summary><div class="menu-pop"><form class="sfd" method="post" action="/ui/campaign-folders/${f.id}/rename">${hidden(nav?.back ?? "/ui")}${infoLabel("Folder name", FOLDER_TIP)}<input name="name" value="${esc(f.name)}" maxlength="${FOLDER_NAME_MAX}" required autocomplete="off" aria-label="Folder name"><button class="sm">Rename</button></form><div class="fsep"></div><form method="post" action="/ui/campaign-folders/${f.id}/delete">${hidden(nav?.back ?? "/ui")}<button class="sm">Delete folder</button></form><span class="muted small">Only an empty folder is deleted.</span></div></details></div>`;
    })
    .join("");
  const loose = shown
    .filter((k) => !filed.has(k.name))
    .map(row)
    .join("");
  if (!nav && !loose) return "";
  const head = `<div class="side-head"><span class="section">Campaigns</span>${
    nav
      ? `<details class="fnew"><summary class="ib" title="New folder" aria-label="New folder">${icon.newFolder}</summary><form class="side-new menu-pop" method="post" action="/ui/campaign-folders">${hidden(nav.back)}<label class="sfd">${infoLabel("New folder", FOLDER_TIP)}<input name="name" maxlength="${FOLDER_NAME_MAX}" required autocomplete="off" placeholder="Kernels"></label><button class="sm primary">Create</button></form></details>`
      : ""
  }</div>`;
  return `${head}<div class="side-camps" id="side-camps"${nav ? ` data-csrf="${esc(nav.csrf)}"` : ""}>${folders}${loose}${nav?.folders.length ? `<div class="side-drop" data-drop="">Drop here: no folder</div>` : ""}</div><div class="side-say small" id="side-say" role="status"></div>`;
}

export function shell(s: Shell, body: string): string {
  // A stopped RunPod pod can't report: it counts as stopped, not stale.
  const stopped = s.rigs.filter(podStopped).length;
  const stale = s.rigs.filter((u) => u.stale && !podStopped(u)).length;
  const runs = s.rigs.flatMap((u) => u.runs.map((i) => ({ u, i })));
  const running = runs.filter(({ i }) => i.status === "running").length;
  const jobs = s.rigs.reduce(
    (acc, u) => ({
      queued: acc.queued + num(u.jobs.queued),
      leased: acc.leased + num(u.jobs.leased),
    }),
    { queued: 0, leased: 0 },
  );
  const nav = (href: string, key: Shell["active"], ic: string, text: string, right = "") =>
    `<a href="${href}" class="${s.active === key ? "on" : ""}"${s.rail ? ` title="${esc(text)}"` : ""}>${ic}<span>${esc(text)}</span>${right}</a>`;
  const fold = s.rail ? "Expand the navigation" : "Collapse the navigation";
  // No list of rigs here (goal 077): the Rigs page lists them, with their state.
  const camps = campaignViews(s.rigs);
  const archived = s.nav?.archived;
  const campCount = archived ? camps.filter((k) => !archived.has(k.name)).length : camps.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(s.title)} · Thermite</title>${ICON_LINKS}
<style>${STYLE}</style><script src="/ui/assets/app.js" defer></script></head>
<body><div class="app${s.rail ? " rail" : ""}">
<aside class="sidebar" id="sidebar">
  <div class="side-top"><a class="brand" href="/ui"><span class="mark">Th</span><span class="brand-name">Thermite</span></a><button type="button" class="ib side-tog" id="side-tog" aria-controls="sidebar" aria-expanded="${s.rail ? "false" : "true"}" aria-label="${fold}" title="${fold}">${icon.panel}</button></div>
  <nav class="nav">
    ${nav("/ui", "overview", icon.home, "Overview", s.needs ? `<span class="badge">${s.needs}</span>` : "")}
    ${nav("/ui/campaigns", "campaigns", icon.trophy, "Campaigns", `<span class="count">${campCount}</span>`)}
    ${nav("/ui/rigs", "rigs", icon.rigs, "Rigs", `<span class="count">${s.rigs.length}</span>`)}
    ${nav("/ui/metrics", "metrics", icon.chart, "Metrics")}
    ${nav("/ui/live", "live", icon.terminal, "Live")}
    ${nav("/ui/knowledge", "knowledge", icon.book, "Knowledge")}
    ${nav("/ui/commands", "commands", icon.list, "Commands")}
    ${nav("/ui/reports", "reports", icon.file, "Reports")}
    ${nav("/ui/exports", "exports", icon.download, "Exports")}
    ${nav("/ui/audit", "audit", icon.shield, "Audit log")}
  </nav>
  ${navCampaigns(camps, s.nav)}
  <div class="side-foot"><form method="post" action="/ui/logout"><button class="ghost sm">${icon.logout}<span>Sign out</span></button></form><a class="cog${s.active === "settings" ? " on" : ""}" href="/ui/settings" title="Settings" aria-label="Settings">${icon.cog}</a></div>
</aside>
<div class="main">
  <header class="topbar">
    ${s.crumbs?.length ? `<span class="crumbs">${s.crumbs.map((c) => `<a href="${c.href}">${esc(c.text)}</a><span>›</span>`).join("")}</span>` : ""}
    <h1>${esc(s.title)}</h1>${s.summary ? `<span class="summary">${s.summary}</span>` : ""}
    <div class="actions">${s.actions ?? ""}</div>
  </header>
  <div class="content${s.flush ? " flush" : ""}" id="content">${body}</div>
</div>
<footer class="statusbar">
  <span class="item ${stale ? "warn" : ""}"><span class="dot ${stale ? "warn" : "ok"}"></span>${s.rigs.length} rigs${stale ? ` · ${stale} stale` : ""}${stopped ? ` · ${stopped} stopped` : ""}</span>
  ${s.needs ? `<a class="item warn" href="/ui">${icon.warn}Needs you ${s.needs}</a>` : ""}
  <span class="spacer"></span>
  <span class="item">${running} running <span class="sub">runs</span></span>
  <span class="item">${jobs.leased} judging · ${jobs.queued} queued <span class="sub">judge</span></span>
  <span class="item" id="live-state"><span class="sub">page from ${esc(new Date(s.now).toISOString().slice(11, 19))} UTC</span><a href="" title="Load this page again with what control knows now">refresh</a></span>
</footer></div></body></html>`;
}

const gib = (mib: number | null | undefined) =>
  typeof mib === "number"
    ? `${mib >= 10_240 ? Math.round(mib / 1024) : (mib / 1024).toFixed(1)} GiB`
    : "?";

/** One line for a rig's card: its devices, CPUs and memory. */
export function hardwareLine(h: Hardware | null): string {
  if (!h) return "";
  const byName = new Map<string, number>();
  for (const d of h.devices) byName.set(d.name, (byName.get(d.name) ?? 0) + 1);
  const devices = [...byName].map(([name, n]) => `${n > 1 ? `${n}× ` : ""}${esc(name)}`);
  const cpus = h.cpu.quota ?? h.cpu.usable;
  return [
    ...devices,
    `${esc(String(cpus))} CPU`,
    `${esc(gib(h.memory.limit_mib ?? h.memory.host_mib))} RAM`,
  ].join(" · ");
}

const DEVICE_MODES: Record<Hardware["device_mode"], string> = {
  shared: "one, shared by the judge and agents' dev runs",
  dedicated: "one for the judge, one for agents' dev runs",
  none: "none: the judge measures on the CPU",
};
/** How the rig's devices are used, in words: with several cards, how many of each. */
export function deviceModeText(h: Hardware): string {
  if (h.device_mode !== "dedicated") return DEVICE_MODES[h.device_mode] ?? h.device_mode;
  const judges = h.devices.filter((d) => d.role === "judge").length;
  const devs = h.devices.filter((d) => d.role === "dev").length;
  if (judges <= 1 && devs <= 1) return DEVICE_MODES.dedicated;
  return `${judges} for the judge, ${devs} for agents' dev runs`;
}
const ROLES: Record<string, string> = {
  judge: "Judge",
  dev: "Dev runs",
  shared: "Judge + dev runs",
};

/** A rig's hardware, in full: devices, CPU, memory, disks, system and toolchain. */
export function hardwareCard(h: Hardware | null, now: number): string {
  if (!h) {
    return `<div class="card"><div class="empty">This rig's harness does not report its hardware yet (it needs a newer image).</div></div>`;
  }
  const n = (v: number | null | undefined, unit: string) =>
    typeof v === "number" ? `${esc(String(v))}${unit}` : `<span class="muted">?</span>`;
  const rows = h.devices
    .map(
      (d) =>
        `<tr><td class="nowrap">${esc(ROLES[d.role] ?? d.role)}</td><td><b>${esc(d.name)}</b><div class="muted xs"><code>${esc(d.uuid)}</code></div></td><td class="num nowrap">${esc(gib(d.memory_mib))}</td><td class="nowrap"><code>${esc(d.bus)}</code></td><td class="nowrap">${esc(d.driver ?? "?")}${d.cuda ? ` <span class="muted">· CUDA ${esc(d.cuda)}</span>` : ""}</td><td class="num nowrap">${n(d.power_limit_w, " W")}</td><td class="num nowrap">${n(d.max_sm_mhz, "")} / ${n(d.max_mem_mhz, " MHz")}</td><td class="nowrap">${esc(d.pcie ?? "?")}</td></tr>`,
    )
    .join("");
  const devices = h.devices.length
    ? `<div style="overflow-x:auto"><table><thead><tr><th>Used by</th><th>Device</th><th class="num">Memory</th><th>Bus</th><th>Driver</th><th class="num">Power limit</th><th class="num">Max SM / mem clock</th><th>PCIe</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : "";
  const kv = (k: string, v: string) =>
    `<div class="small"><span class="muted">${esc(k)}</span> ${v}</div>`;
  const cpu = `${esc(h.cpu.model || "?")} · ${h.cpu.quota !== null ? `quota ${esc(String(h.cpu.quota))} CPU` : `${esc(String(h.cpu.usable))} CPU`} of the host's ${esc(String(h.cpu.host))}`;
  const mem =
    h.memory.limit_mib !== null
      ? `${esc(gib(h.memory.limit_mib))} limit, of the host's ${esc(gib(h.memory.host_mib))}`
      : `no limit; the host has ${esc(gib(h.memory.host_mib))}`;
  const disks = h.disks
    .map((d) => `${esc(d.name)} ${esc(String(d.free_gib))} of ${esc(String(d.total_gib))} GiB free`)
    .join(" · ");
  return `<div class="card"><div class="stack" style="gap:10px">
<div class="small"><span class="muted">Devices</span> ${esc(deviceModeText(h))}</div>
${devices}
<div class="grid2" style="gap:8px 16px">
${kv("CPU", cpu)}
${kv("Memory", mem)}
${kv("Disks", disks || "?")}
${kv("System", `${esc(h.os.kernel)} · ${esc(h.os.arch)} · Node ${esc(h.os.node)}${h.os.image ? ` · image <code>${esc(h.os.image.slice(0, 24))}</code>` : ""}`)}
${kv("Compilers", `${esc(h.toolchain.cc ?? "no cc")}${h.toolchain.nvcc ? ` · ${esc(h.toolchain.nvcc)}` : ""}`)}
${kv("Target", `${esc(h.target.type)} · ${esc(h.target.class)}`)}
</div>
${h.errors.length ? `<div class="bad xs">${h.errors.map((e) => esc(e.slice(0, 300))).join("<br>")}</div>` : ""}
<div class="muted xs">Reported by the rig's harness when it started, ${esc(ago(h.collected_at, now))} ago.</div>
</div></div>`;
}

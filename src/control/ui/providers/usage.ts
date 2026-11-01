import {
  CHATGPT_USAGE_PAGE,
  creditsNoteShows,
  type PlanUsage,
  type PlanWindow,
} from "../../providers/index.ts";
import { ago, esc } from "../components/index.ts";

/**
 * A subscription's usage windows on Settings › Providers (goal 151): as chips on a provider's row,
 * and in full in the open row, with where they come from (providers/plan-usage.ts reads them).
 */

const pct = (w: PlanWindow) => `${Math.round(w.used_percent)}%`;
const resets = (w: PlanWindow) =>
  w.resets_at ? ` · resets ${esc(w.resets_at.slice(0, 16).replace("T", " "))} UTC` : "";

/** The windows on a row's closed line, as chips: "5-hour 42%", "Weekly 81%" (marked from 80%). */
export function usageChips(u: PlanUsage | undefined): string {
  return (u?.windows ?? [])
    .map(
      (w) =>
        `<span class="chip${w.used_percent >= 80 ? " warn" : ""}" title="${esc(w.label)} window${w.resets_at ? `, resets ${esc(w.resets_at)}` : ""}">${esc(w.label)} ${pct(w)}</span>`,
    )
    .join("");
}

/** The windows in full in an open row, with where they come from, or why there are none. */
export function usageBlock(
  kind: "claude" | "chatgpt",
  u: PlanUsage | undefined,
  now: number,
): string {
  const bars = (u?.windows ?? [])
    .map(
      (w) =>
        `<div><div class="small"><b>${esc(w.label)} window</b> · ${pct(w)} used${resets(w)}</div><div class="ubar${w.used_percent >= 80 ? " warn" : ""}"><div style="width:${Math.round(w.used_percent)}%"></div></div></div>`,
    )
    .join("");
  const page = `<a href="${CHATGPT_USAGE_PAGE}" target="_blank" rel="noopener">ChatGPT, Settings › Usage ↗</a>`;
  const full =
    kind === "claude"
      ? "When a window is full, the agents on this subscription wait for its reset; nothing pays for more."
      : "When the plan is full, the agents on this subscription wait and try again every 15 minutes; nothing pays for more.";
  if (kind === "claude")
    return u?.windows.length
      ? `<div class="use">${bars}</div><div class="muted small" style="margin-top:4px">As Claude Code on ${esc(u.rig)} reported it ${esc(ago(u.at, now))} ago. ${full}</div>`
      : `<div class="muted small">No usage reported yet: Claude Code on a rig reports the 5-hour and weekly windows once an agent uses this subscription. ${full}</div>`;
  if (!u)
    return `<div class="muted small">OpenAI has not answered yet: reload the page in a moment, or see ${page}. ${full}</div>`;
  if (u.error || !u.windows.length)
    return `<div class="muted small">No usage from OpenAI: ${esc(u.error ?? "its answer had no windows")}. See ${page}. ${full}</div>`;
  return `<div class="use">${bars}</div><div class="muted small" style="margin-top:4px">As OpenAI answered control ${esc(ago(u.at, now))} ago${u.plan ? ` (plan: ${esc(u.plan)})` : ""}; asked again after 5 minutes. ${full}</div>`;
}

/** A time as the Providers page says it: 2026-11-01 14:02 UTC. */
const utc = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;

/**
 * A Claude subscription's usage credits on its row (goal 169): the chip "usage credits on" while
 * Claude Code reports them on, with what a dismissal of its note means in its title. None when
 * they are off, or never reported.
 */
export function creditsChip(u: PlanUsage | undefined, dismissedAt: string | undefined): string {
  if (!u?.credits?.on) return "";
  const title = creditsNoteShows(u.credits, dismissedAt)
    ? "Usage credits are on for this account, as Claude Code reports them."
    : `Usage credits are on for this account. You dismissed the note on ${utc(dismissedAt ?? "")}; it comes back if credits are reported on again after being off.`;
  return `<span class="chip warn" data-credits="on" title="${esc(title)}">usage credits on</span>`;
}

/**
 * The note under a Claude subscription whose usage credits are on, unless the owner dismissed it
 * since they last came on: why it matters, what to do, and Dismiss.
 */
export function creditsNote(
  provider: string,
  u: PlanUsage | undefined,
  dismissedAt: string | undefined,
  csrf: string,
): string {
  const c = u?.credits;
  if (!c || !creditsNoteShows(c, dismissedAt)) return "";
  const dismiss = `<form class="inline" method="post" action="/ui/settings/providers/${encodeURIComponent(provider)}/credits-note/dismiss"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="sm" style="margin-left:8px" title="Hide this note. The chip stays; the note comes back if Claude Code reports credits on again after reporting them off.">Dismiss</button></form>`;
  return `<div class="callout warn small" data-credits-note="${esc(provider)}">Claude Code reports usage credits on for this account (in its last session on ${esc(c.rig)}, ${esc(utc(c.at))}). With credits on, a full window can spend paid usage instead of waiting, so Thermite's rule that a full window waits for its reset holds only with them off. Turn them off in the Claude account's settings; this mark goes once Claude Code reports them off.${dismiss}</div>`;
}

import { CHATGPT_USAGE_PAGE, type PlanUsage, type PlanWindow } from "../../providers/index.ts";
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

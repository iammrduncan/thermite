import type { AgentsContext } from "../../../../core/compaction.ts";
import type { OwnModel, RigContext } from "../../../campaigns/index.ts";
import { esc, infoLabel } from "../../components/index.ts";

export { CAMPAIGN_CONTEXT_JS, CC_CORE_JS } from "./client.ts";

/**
 * A campaign's own Agents' context (goal 070, as the owner approved its revised mockup on
 * 2026-10-21): two fields, Context window and Compact at, and one help line, in four places. New
 * campaign's step 4, the Copy panel and the campaign's page show the fields; the campaign's page
 * adds "What applies on each rig", one row for each rig that can run it; Start a run says what
 * the chosen rig's workers get. The page's script (context/client.ts) checks the fields
 * as you type, in control's words, and keeps the rows and lines in step.
 */

const tokens = (n: number) => n.toLocaleString("en-US");

export const WINDOW_TIP =
  "The most each agent of this campaign's runs reads in one request, in tokens, on any rig. Empty: the rig's, as its Edit rig page sets it for each agent. From 4,096 tokens. Control refuses to start a run on a rig where the model of an agent takes less. An agent that its rig caps lower keeps its own, smaller window. For example, type 131072 to compare two models at the same window. You can change it later on the campaign's page.";
export const POINT_TIP =
  "When each agent's conversation is compacted: a percent of its context window, from 50 to 95. Empty: the rig's (80 when the rig sets none). At that point the conversation is kept, then summarized, and the agent continues. A trial never ends because its conversation grew.";
const HELP = "Empty: the rig's. A number applies to every agent of its runs, on any rig.";
const RIGS_TIP =
  "One row for each rig that can run this campaign: what its workers get with the numbers above, and if a run can start there. The planner and the advisors get the same, or less when their rig gives them less. Bold: this campaign's; plain: the rig's.";

/** A campaign's numbers as the two fields show them: as saved, or as typed. */
export const fieldValues = (c: AgentsContext | undefined) => ({
  cw: c?.context_window ? String(c.context_window) : "",
  at: c?.compact_at ? String(c.compact_at) : "",
});

/** The two fields and the help line, as each place shows them, with the values they start with. */
export function contextFields(
  where: "new" | "copy" | "page",
  v: { cw: string; at: string },
  say = "",
) {
  return `<div class="cc" data-cc="${where}">
<div class="cc-f">
<label class="fd">${infoLabel("Context window", WINDOW_TIP)}<span class="cc-in"><input name="context_window" data-cc-cw value="${esc(v.cw)}" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="the rig's"><span class="small muted">tokens</span></span></label>
<label class="fd">${infoLabel("Compact at", POINT_TIP)}<span class="cc-in"><input name="compact_at" data-cc-ca value="${esc(v.at)}" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="the rig's"><span class="small muted">%</span></span></label>
</div>
<div class="cc-help">${esc(HELP)}</div>
<div class="cc-say" data-cc-say aria-live="polite">${say}</div>
</div>`;
}

/** The workers' window and point on a rig, bold where they are the campaign's. */
export function windowHtml(r: RigContext): string {
  return r.window === null
    ? `<span class="muted">the rig's</span>`
    : r.windowFrom === "campaign"
      ? `<b>${tokens(r.window)}</b>`
      : tokens(r.window);
}
export function pointHtml(r: RigContext): string {
  return r.at === null
    ? `<span class="muted">the rig's</span>`
    : r.atFrom === "campaign"
      ? `<b>${r.at}%</b>`
      : `${r.at}%`;
}

/** One row of "What applies on each rig". */
export function rigRow(rig: string, r: RigContext): string {
  return r.refused
    ? `<tr class="bad" data-cc-row="${esc(rig)}"><td><b>${esc(rig)}</b></td><td class="num">—</td><td class="num">—</td><td><span class="cc-st bad">can't start: ${esc(r.refused.model)} takes at most ${tokens(r.refused.listed)}</span></td></tr>`
    : `<tr data-cc-row="${esc(rig)}"><td><b>${esc(rig)}</b></td><td class="num">${windowHtml(r)}</td><td class="num">${pointHtml(r)}</td><td><span class="cc-st ok">ok</span></td></tr>`;
}

/** The request the page's Save sends, as REST, MCP and the command line send it. */
function requestWords(campaign: string, c: AgentsContext | undefined) {
  const body = {
    ...(c?.context_window ? { context_window: c.context_window } : {}),
    ...(c?.compact_at ? { compact_at: c.compact_at } : {}),
  };
  return {
    json: `POST /v1/campaigns/${campaign}/context\n${JSON.stringify(body, null, 2)}`,
    cli: `Command line: thermite campaign context ${campaign}${c?.context_window ? ` --context-window ${c.context_window}` : ""}${c?.compact_at ? ` --compact-at ${c.compact_at}` : ""}. MCP: set_campaign_context, with campaign: ${campaign}. Without a number: the rig's.`,
  };
}

/** A rig that can run the campaign, with its agents' own models and what applies there now. */
export interface ContextRig {
  id: string;
  own: OwnModel[];
  now: RigContext;
}

/** The campaign's page: its Agents' context, with what applies on each rig. */
export function contextBlock(o: {
  campaign: string;
  csrf: string;
  context: AgentsContext | undefined;
  /** The fields as typed at a refused Save, to show again. */
  typed?: { cw: string; at: string } | undefined;
  rigs: ContextRig[];
  /** What control said at the last Save: an error, or what it saved. */
  error?: string | undefined;
  ok?: string | undefined;
}): string {
  const href = `/ui/campaigns/${encodeURIComponent(o.campaign)}`;
  const req = requestWords(o.campaign, o.context);
  const data = {
    campaign: o.campaign,
    saved: { cw: o.context?.context_window ?? null, at: o.context?.compact_at ?? null },
    rigs: o.rigs.map((r) => ({ id: r.id, own: r.own })),
  };
  return `<div class="block" id="agents-context"><div class="head"><h2>Agents' context</h2><span class="right">every run of ${esc(o.campaign)}</span></div>
${o.error ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not saved.</b> ${esc(o.error)}</div>` : o.ok ? `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(o.ok)}</b></div>` : ""}
<div class="card"><form method="post" action="${href}/context" data-cc-page="${esc(JSON.stringify(data))}" autocomplete="off"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
${contextFields("page", o.typed ?? fieldValues(o.context))}
<div class="cc-rigs-h">${infoLabel("What applies on each rig", RIGS_TIP)}</div>
${
  o.rigs.length
    ? `<div class="cc-tw"><table class="cc-t"><thead><tr><th>Rig</th><th class="num">Workers' window</th><th class="num">Compact at</th><th>Status</th></tr></thead><tbody data-cc-rigs>${o.rigs.map((r) => rigRow(r.id, r.now)).join("")}</tbody></table></div>`
    : `<div class="muted small">No rig can run it now: a rig with the campaign's hardware shows here.</div>`
}
<details class="adv"><summary>The same over REST, MCP and the command line</summary><div><pre class="json cp-req" data-cc-json>${esc(req.json)}</pre><div class="muted small cp-req" data-cc-cli>${esc(req.cli)}</div></div></details>
<div class="act cc-act"><button class="primary" data-cc-save>Save</button><span class="small muted cc-chg" data-cc-chg aria-live="polite">New runs take what you save. A run at work keeps what it started with.</span></div>
</form></div></div>
<script src="/ui/assets/campaign-context.js" defer></script>`;
}

/** Start a run: what the chosen rig's workers get, as a sentence, and a link to change it. */
export function startLine(campaign: string, rig: string, r: RigContext, set: boolean): string {
  const link = ` <a href="/ui/campaigns/${encodeURIComponent(campaign)}#agents-context" data-close-to="#agents-context">${set ? "Change" : "Set"} this campaign's context</a>`;
  if (r.refused)
    return `<span class="bad">${esc(`This campaign's window is above what ${r.refused.model} takes (${tokens(r.refused.listed)} tokens).`)}</span>${link}`;
  const window =
    r.window === null
      ? "the rig's window"
      : `${r.windowFrom === "campaign" ? `<b>${tokens(r.window)}</b>` : tokens(r.window)} tokens`;
  const point = r.at === null ? "the rig's point" : pointHtml(r);
  return `On ${esc(rig)}, the workers get ${window} and compact at ${point}.${link}`;
}

/** Start a run: each rig's note on its workers' window, or why a run can't start there. */
export function startNote(r: RigContext): { text: string; bad: boolean } {
  if (r.refused)
    return {
      text: `Can't start: ${r.refused.model} takes at most ${tokens(r.refused.listed)} tokens.`,
      bad: true,
    };
  return {
    text: `Workers' window: ${r.window === null ? "the rig's" : tokens(r.window)}.`,
    bad: false,
  };
}

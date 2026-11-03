import type { PromptDetail, PromptItem, RoleInfo } from "../prompts.ts";
import { ago, esc, infoLabel } from "./components/index.ts";
import { type RunRef, runHref } from "./urls.ts";

/**
 * The agents' roles and the prompts a run's agents were sent, on the dashboard (goal 166): the
 * Agents page and a role's page, a run's Prompts tab, and one prompt with each section folded and
 * labelled with where it comes from.
 */

/** The Agents page. */
export const agentsHref = "/ui/agents";

/** A role's page. */
export const roleHref = (role: string) => `${agentsHref}/${encodeURIComponent(role)}`;

/** One of a run's prompts, under the run. */
export const promptHref = (r: RunRef, id: number) => `${runHref(r)}/prompts/${id}`;

/** What a section's source means, on the info icon of the Prompts tab's Sections. */
const SOURCES_TIP =
  "Where each part of the prompt comes from: role, the role's own text (the same for every run); assignment, the trial's assignment; contract, the campaign's contract; campaign brief, the brief its author wrote; queue, the experiment from the run's queue; planner, the planner's round; judge, what the judge found; ledger, the run's record; field notes and past research; owner, the owner's messages; owner's addition, the owner's addition to the role for this campaign, from its contract; kit, the MCP servers the kit gives; rig, the rig's and the lane's limits; package, what an advisor is given to read; check, what code's check of the last answer found.";

/** Every role: what it does, where it runs, its model and programs, and its render function. */
export function rolesPage(roles: readonly RoleInfo[]): string {
  const row = (r: RoleInfo) =>
    `<tr><td><a href="${roleHref(r.id)}"><b>${esc(r.name)}</b></a></td><td>${esc(r.what)}</td><td class="small">${esc(r.runs_in)}</td><td class="small">${esc(r.model)}</td><td class="small">${esc(r.programs.join(", "))}</td></tr>`;
  return `<div class="card hl" style="margin-bottom:12px">Each role's definition lives in Thermite's code, in <code>src/agents/roles/</code>: its own texts, and the one function that puts its prompt together for a run. A run's <b>Prompts</b> tab shows what each of its agents was sent, and where each part came from.</div>
<div class="card flat" style="overflow-x:auto"><table class="ktable"><thead><tr><th>Role</th><th>What it does</th><th>Runs in</th><th>Model</th><th>Programs</th></tr></thead><tbody>${roles.map(row).join("")}</tbody></table></div>`;
}

/** One role: its facts and its fixed texts, each folded. */
export function rolePage(r: RoleInfo): string {
  const facts = [
    ["What it does", esc(r.what)],
    ["Runs in", esc(r.runs_in)],
    ["Model", esc(r.model)],
    ["Programs", esc(r.programs.join(", "))],
    ["The owner's messages", r.messages ? "reach it" : "do not reach it"],
    ["Put together by", `<code>${esc(r.render)}</code>, in <code>src/agents/roles/</code>`],
  ]
    .map(([k, v]) => `<dt>${esc(String(k))}</dt><dd>${v}</dd>`)
    .join("");
  const texts = r.texts
    .map(
      (t) =>
        `<details class="card flat" style="margin-top:8px"><summary><b>${esc(t.id)}</b> <span class="muted small">${esc(t.what)} · ${t.chars.toLocaleString("en-US")} characters</span></summary><div class="jtext">${esc(t.text ?? "")}</div></details>`,
    )
    .join("");
  return `<div class="card"><dl class="facts">${facts}</dl></div><h2 style="margin-top:16px">Its texts</h2>${texts}`;
}

/** Where a prompt went: its lane and trial, or its call. */
const where = (p: Pick<PromptItem, "lane" | "trial" | "call">) =>
  [p.lane, p.trial ? `trial ${p.trial}` : "", p.call ?? ""].filter(Boolean).join(", ");

/** A run's Prompts tab: every prompt its agents were sent, newest first. */
export function promptsTab(r: RunRef, items: readonly PromptItem[], now: number): string {
  if (!items.length)
    return `<div class="card"><div class="empty">No prompt sent yet. Each prompt a trial, a planner round or an advisor's call starts with shows here, with where each part came from. See every role on the <a href="${agentsHref}">Agents</a> page.</div></div>`;
  const shown = [...items].reverse().slice(0, 300);
  const row = (p: PromptItem) => {
    const sources = [...new Set(p.sections.map((s) => s.source))].join(", ");
    return `<tr><td><a href="${promptHref(r, p.id)}">${p.id}</a></td><td class="small">${esc(ago(p.at, now))} ago</td><td><a href="${roleHref(p.role)}">${esc(p.role)}</a></td><td class="small">${esc(p.program)}</td><td class="small">${esc(where(p))}</td><td class="num">${p.chars.toLocaleString("en-US")}</td><td class="small">${esc(sources)}</td></tr>`;
  };
  return `<div class="card flat" style="overflow-x:auto"><table class="ktable"><thead><tr><th>Prompt</th><th>Sent</th><th>Role</th><th>Program</th><th>Where</th><th class="num">Characters</th><th>${infoLabel("Sections from", SOURCES_TIP)}</th></tr></thead><tbody>${shown.map(row).join("")}</tbody></table></div>${items.length > shown.length ? `<div class="muted small" style="margin-top:8px">The newest ${shown.length} of ${items.length}.</div>` : ""}<div class="muted small" style="margin-top:8px">The whole text of every prompt is on the rig, and in the run's export. <a href="${agentsHref}">Every role</a>.</div>`;
}

/** One prompt: each section in order, folded, with its part, its source and its size. */
export function promptPage(r: RunRef, p: PromptDetail): string {
  const sections = p.sections
    .map((s) => {
      const said = s.from_definition
        ? " · the role's definition"
        : s.cut
          ? " · cut here: the whole is on the rig and in the run's export"
          : "";
      return `<details class="card flat" style="margin-top:8px"${s.source === "role" ? "" : " open"}><summary><b>${esc(s.id)}</b> <span class="muted small">${esc(s.part)} · from ${esc(s.source)} · ${s.chars.toLocaleString("en-US")} characters${esc(said)}</span></summary><div class="jtext">${s.text === null ? `<span class="muted">Not on control: control's build has another version of this role.</span>` : esc(s.text)}</div></details>`;
    })
    .join("");
  return `<div class="card"><b>${esc(p.role)}</b> in ${esc(p.program)}${where(p) ? `, ${esc(where(p))}` : ""}, on ${esc(p.rig)} · version ${esc(p.version)} · ${p.chars.toLocaleString("en-US")} characters · <a href="${roleHref(p.role)}">the role</a> · <a href="${runHref(r, "prompts")}">all of the run's prompts</a></div>${sections}`;
}

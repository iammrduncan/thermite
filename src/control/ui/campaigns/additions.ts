import {
  ADDITION_ROLES,
  additionRolesOf,
  ROLE_ADDITION_MAX_CHARS,
  type RoleAdditions,
} from "../../../core/role-additions.ts";
import { esc, infoLabel } from "../components/index.ts";

/**
 * The owner's additions to a campaign's roles on the screens (goal 166, decision 1): a text box for
 * each role a campaign of its mode runs, by the role's name, on the campaign's page (its own block
 * and form) and on New campaign (in the draft's form). Each field is `addition_<role id>`, so the
 * form posts without a script. An empty box: no addition for that role.
 */

/** Each role's name, as the Agent roles page names it. */
const ROLE_NAMES: Record<string, string> = {
  worker: "Worker",
  planner: "Planner",
  teacher: "Teacher",
  "merged-by": "Merged by",
  auditor: "Auditor",
  reviewer: "Reviewer (review panel)",
  "research-worker": "Research worker",
  "research-planner": "Research planner",
  "research-teacher": "Research teacher",
  "research-merged-by": "Research merged by",
  "research-reviewer": "Research reviewer (review panel)",
  synthesizer: "Synthesizer",
  "final-writer": "Final writer",
};

const ADDITIONS_TIP = `Your own words for one role of this campaign's agents, such as "Prefer changes that keep the code readable." Each prompt of that role carries them in a part of their own after the role's own instructions, labelled as yours, with the contract's version. They add to the role's instructions and replace none of them; where the two differ, the role's own come first. They never decide a measurement, a verdict or a promotion: code does. At most ${ROLE_ADDITION_MAX_CHARS.toLocaleString("en-US")} characters each. Empty: none for that role.`;

/** The field's name for a role. */
export const additionField = (role: string) => `addition_${role}`;

/** The additions a form posted, by role: every addition_<role> field, empty ones too. */
export function postedAdditions(form: Record<string, unknown>): Record<string, string> {
  const roles = [...ADDITION_ROLES.code, ...ADDITION_ROLES.research] as readonly string[];
  return Object.fromEntries(
    roles
      .filter((r) => additionField(r) in form)
      .map((r) => [r, String(form[additionField(r)] ?? "")]),
  );
}

/** A text box for each role of the mode, filled with what the campaign has. */
export function additionFields(mode: string, additions: RoleAdditions | undefined): string {
  const given = additions as Record<string, string> | undefined;
  return additionRolesOf(mode)
    .map(
      (role) =>
        `<label class="fd">${esc(ROLE_NAMES[role] ?? role)} <span class="muted small"><code>${esc(role)}</code></span><textarea name="${additionField(role)}" rows="3" maxlength="${ROLE_ADDITION_MAX_CHARS}" placeholder="none">${esc(given?.[role] ?? "")}</textarea></label>`,
    )
    .join("");
}

/** New campaign's part: the boxes for the draft's mode, folded until one is filled. */
export function additionsDraftPart(mode: string, additions: RoleAdditions | undefined): string {
  const open = Object.keys(additions ?? {}).length > 0;
  return `<details class="adv"${open ? " open" : ""}><summary>${infoLabel("Your additions to the agents' roles", ADDITIONS_TIP)}</summary><div>${additionFields(mode, additions)}</div></details>`;
}

/** The campaign page's block: the boxes, and Save, which saves a new version of its contract. */
export function additionsBlock(o: {
  campaign: string;
  mode: string;
  csrf: string;
  additions: RoleAdditions | undefined;
  /** What control said at the last Save: an error, or what it saved. */
  error?: string | undefined;
  ok?: string | undefined;
}): string {
  const href = `/ui/campaigns/${encodeURIComponent(o.campaign)}`;
  const roles = Object.keys(o.additions ?? {});
  return `<div class="block" id="role-additions"><div class="head"><h2>${infoLabel("Your additions to the agents' roles", ADDITIONS_TIP)}</h2><span class="right">${roles.length ? esc(roles.join(", ")) : "none"}</span></div>
${o.error ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not saved.</b> ${esc(o.error)}</div>` : o.ok ? `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(o.ok)}</b></div>` : ""}
<div class="card"><form method="post" action="${href}/additions" autocomplete="off"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
<details class="adv"${roles.length || o.error ? " open" : ""}><summary>${roles.length ? "Change them" : "Add text to a role"}</summary><div>${additionFields(o.mode, o.additions)}
<div class="act"><button class="primary">Save</button><span class="small muted">Control saves a new version of ${esc(o.campaign)}. New runs take it; a run at work keeps what it started with.</span></div></div></details>
</form></div></div>`;
}

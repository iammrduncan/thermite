import {
  KB_WRITER_ROLES,
  KB_WRITTEN_KINDS,
  type KbWriterRole,
  type KbWrites,
} from "../../../core/kb.ts";
import { esc, infoLabel } from "../components/index.ts";

/**
 * Which kinds of item each role may write in the campaign's collection of the knowledge base, on
 * the campaign's page (goal 175): a row for each role, a box for each kind, and Save, which saves a
 * new version of the contract. Each box is `w_<role>_<kind>`, so the form posts without a script.
 */

/** Each role's name, as the Agent roles page names it. */
const ROLE_NAMES: Record<KbWriterRole, string> = {
  planner: "Planner",
  worker: "Workers",
  teacher: "Teachers",
  "merged-by": "Merged by",
  auditor: "Auditor",
  "review-panel": "Review panel",
  synthesizer: "Synthesizer",
  "final-writer": "Final writer",
};

const TIP =
  "Which kinds of item each of this campaign's agents may write into Thermite's knowledge base, each in its own slot of its run: a role with one kind or more gets the kb_write tool. Every agent searches and reads it, with kb_search and kb_read. Thermite's own records of each run (its experiments, attempts, notes, sources and claims) go in on their own. Save makes a new version of the campaign's contract: runs started from then take it, and a run keeps what it started with.";

const field = (role: string, kind: string) => `w_${role}_${kind}`;

/** The setting a form posted: for each role, the kinds ticked; none ticked, none. */
export function postedKbWrites(form: Record<string, unknown>): KbWrites {
  const out: KbWrites = {};
  for (const role of KB_WRITER_ROLES) {
    const kinds = KB_WRITTEN_KINDS.filter((k) => field(role, k) in form);
    if (kinds.length) out[role] = kinds;
  }
  return out;
}

/** The campaign page's block: the table of roles and kinds, and Save. */
export function kbWritesBlock(o: {
  campaign: string;
  csrf: string;
  writes: KbWrites;
  /** True when the campaign's contract sets nothing, and the default holds. */
  byDefault: boolean;
  error?: string | undefined;
  ok?: string | undefined;
}): string {
  const href = `/ui/campaigns/${encodeURIComponent(o.campaign)}`;
  const head = `<tr><th>Role</th>${KB_WRITTEN_KINDS.map((k) => `<th class="small">${esc(k)}</th>`).join("")}</tr>`;
  const rows = KB_WRITER_ROLES.map(
    (role) =>
      `<tr><td>${esc(ROLE_NAMES[role])} <span class="muted small"><code>${esc(role)}</code></span></td>${KB_WRITTEN_KINDS.map(
        (k) =>
          `<td><input type="checkbox" name="${field(role, k)}" value="1" aria-label="${esc(`${ROLE_NAMES[role]} write ${k}`)}"${o.writes[role]?.includes(k) ? " checked" : ""}></td>`,
      ).join("")}</tr>`,
  ).join("");
  return `<div class="block" id="kb-writes"><div class="head"><h2>${infoLabel("Who writes in its collection", TIP)}</h2><span class="right">${o.byDefault ? "the default" : "this campaign's own"}</span></div>
${o.error ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not saved.</b> ${esc(o.error)}</div>` : o.ok ? `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(o.ok)}</b></div>` : ""}
<div class="card"><form method="post" action="${href}/kb-writes" autocomplete="off"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
<details class="adv"${o.error ? " open" : ""}><summary>Change who writes what</summary><div style="overflow-x:auto"><table class="ktable">${head}${rows}</table></div>
<div class="act" style="margin-top:8px"><button class="primary">Save</button></div></details></form></div></div>`;
}

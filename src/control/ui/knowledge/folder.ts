import { GRANT_WORDS, type KbFolder, type KbSummary } from "../../kb/index.ts";
import { ago, esc, fmtInt, icon, infoLabel, modeName } from "../components/index.ts";
import { sizeWords } from "../exports.ts";
import { campaignHref, knowledgeHref } from "../urls.ts";

/**
 * A folder's info pane in the knowledge explorer (goal 176), as a file manager's: what the open
 * collection, run or slot holds, from its summary in the owner's list of it (kb_list). A
 * collection's pane is where the owner gives and ends grants, each said before it is done and
 * confirmed in place. At phone width the pane opens from Info, as a sheet.
 */

/** The facts in a small grid: each a name and its value. */
const facts = (rows: [string, string][]) =>
  `<dl class="kx-facts">${rows
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("")}</dl>`;

/** A few names with their counts, as chips. */
const chips = (m: Record<string, number> | { name: string; items: number }[]) => {
  const xs = Array.isArray(m) ? m.map((x) => [x.name, x.items] as const) : Object.entries(m);
  return xs.length
    ? `<span class="kx-chips">${xs.map(([k, n]) => `<span class="chip">${esc(k)} <span class="muted">${fmtInt(n)}</span></span>`).join("")}</span>`
    : `<span class="muted">none</span>`;
};

/** What every folder holds: records, blurbs, files, older versions, bytes and its last write. */
function holds(s: KbSummary, now: number): [string, string][] {
  return [
    ["Records", fmtInt(s.records)],
    ["Blurbs", fmtInt(s.blurbs)],
    ["Files", fmtInt(s.files)],
    ["Older versions", fmtInt(s.older_versions)],
    ["Stored", esc(sizeWords(s.stored_bytes))],
    [
      "Last write",
      s.updated_at
        ? `<span title="${esc(s.updated_at)}">${esc(ago(s.updated_at, now))} ago</span>`
        : "none yet",
    ],
  ];
}

/** What the grant forms need: the form token, the page to come back to, and every collection. */
export interface GrantForms {
  csrf: string;
  back: string;
  collections: readonly string[];
}

/** One grant, with Remove: what removing it does, then the button, in place. */
function grantRow(g: GrantForms, campaign: string, reads: string, shown: string): string {
  return `<li class="kx-grant"><a href="${esc(knowledgeHref(shown))}">${icon.folder}<span>${esc(shown)}</span></a><details class="kx-confirm"><summary class="btn sm ghost">Remove</summary><form method="post" action="/ui/kb/revoke"><input type="hidden" name="csrf" value="${esc(g.csrf)}"><input type="hidden" name="back" value="${esc(g.back)}"><input type="hidden" name="campaign" value="${esc(campaign)}"><input type="hidden" name="reads" value="${esc(reads)}"><p class="small">${esc(GRANT_WORDS.remove(campaign, reads))}</p><button class="sm danger">Remove the grant</button></form></details></li>`;
}

/** Add: the collection to choose, what adding it does, and the button, in place. */
function grantAdd(
  g: GrantForms,
  o: { label: string; tip: string; options: string[]; fixed: "campaign" | "reads"; value: string },
): string {
  if (!o.options.length) return "";
  const other = o.fixed === "campaign" ? "reads" : "campaign";
  return `<details class="kx-confirm"><summary class="btn sm">Add</summary><form method="post" action="/ui/kb/grant" class="kx-grantform"><input type="hidden" name="csrf" value="${esc(g.csrf)}"><input type="hidden" name="back" value="${esc(g.back)}"><input type="hidden" name="${o.fixed}" value="${esc(o.value)}"><label class="sfd">${infoLabel(o.label, o.tip)}<select name="${other}" required><option value="">Choose…</option>${o.options.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select></label><p class="small">${esc(GRANT_WORDS.add)}</p><button class="sm primary">Add the grant</button></form></details>`;
}

/** A collection's grants both ways, each with Remove, and Add for each. */
function grantsHtml(s: Extract<KbSummary, { level: "collection" }>, g: GrantForms): string {
  const others = g.collections.filter((c) => c !== s.campaign);
  const reads = `<div class="kx-psec"><div class="kx-psh">${infoLabel("Reads", `Other campaigns' collections the agents of ${s.campaign} may search and read, read only.`)}</div><ul class="kx-grants">${s.reads.map((r) => grantRow(g, s.campaign, r, r)).join("") || `<li class="muted small">Only its own collection.</li>`}</ul>${grantAdd(
    g,
    {
      label: "Collection it reads",
      tip: `Another campaign's collection the agents of ${s.campaign} may read.`,
      options: others.filter((c) => !s.reads.includes(c)),
      fixed: "campaign",
      value: s.campaign,
    },
  )}</div>`;
  const readBy = `<div class="kx-psec"><div class="kx-psh">${infoLabel("Read by", `Campaigns whose agents may search and read ${s.campaign}'s collection, read only.`)}</div><ul class="kx-grants">${s.read_by.map((r) => grantRow(g, r, s.campaign, r)).join("") || `<li class="muted small">No other campaign.</li>`}</ul>${grantAdd(
    g,
    {
      label: "Campaign that reads it",
      tip: `Another campaign whose agents may read ${s.campaign}'s collection.`,
      options: others.filter((c) => !s.read_by.includes(c)),
      fixed: "reads",
      value: s.campaign,
    },
  )}</div>`;
  return reads + readBy;
}

const LEVEL: Record<KbSummary["level"], string> = {
  knowledge_base: "Knowledge base",
  collection: "Collection",
  run: "Run",
  slot: "Slot",
};

/** The pane of the open folder. `note`: what the owner's last grant change did, or why not. */
export function folderPaneHtml(o: {
  place: KbFolder;
  summary: KbSummary;
  grants: GrantForms;
  /** "Search as this run": the search as the run's agents, in everything (a run's pane). */
  searchAs?: string | undefined;
  note?: { ok?: string | undefined; error?: string | undefined } | undefined;
  now: number;
}): string {
  const s = o.summary;
  let body = "";
  if (s.level === "knowledge_base") body = facts(holds(s, o.now));
  if (s.level === "collection")
    body = `${facts([
      ["Campaign", `<a href="${esc(campaignHref(s.campaign))}">${esc(s.campaign)}</a>`],
      ["Mode", esc(modeName(s.mode)) || "not known"],
      ["Archived", s.archived ? `<span class="kx-tag">archived</span>` : ""],
      ["Runs", fmtInt(s.runs)],
      ...holds(s, o.now),
      ["Slots", chips(s.slots)],
    ])}${grantsHtml(s, o.grants)}`;
  if (s.level === "run") {
    const searches = s.searches.own_run_only ? "only its own run" : "its whole collection";
    const granted = s.searches.granted.length
      ? `, and ${s.searches.granted.map((c) => `<a href="${esc(knowledgeHref(c))}">${esc(c)}</a>`).join(", ")}, read only`
      : "";
    body = `${facts([
      [
        "State",
        s.status
          ? `<span class="dot ${s.status === "running" ? "ok" : ""}"></span> ${esc(s.status)}`
          : "not reported",
      ],
      ["Started fresh", s.searches.own_run_only ? "yes" : "no"],
      ["Its agents search", `${searches}${granted}`],
      ["Rig", s.rig ? esc(s.rig) : ""],
      ...holds(s, o.now),
      ["Slots", chips(s.slots)],
    ])}${
      o.searchAs
        ? `<div class="kx-psec"><a class="btn sm" href="${esc(o.searchAs)}">${icon.search}<span>Search as this run</span></a></div>`
        : ""
    }`;
  }
  if (s.level === "slot") {
    const refused = s.refused.newest
      .map(
        (r) =>
          `<li><span class="muted" title="${esc(r.at)}">${esc(ago(r.at, o.now))} ago</span> ${esc(r.why)}</li>`,
      )
      .join("");
    body = `${facts([
      ["Writer", esc(s.writer.words)],
      [
        "May write",
        s.writes === null
          ? "every kind, from the run's own records"
          : s.writes.length
            ? `<span class="kx-chips">${s.writes.map((k) => `<span class="chip">${esc(k)}</span>`).join("")}</span>`
            : `<span class="muted">nothing</span>`,
      ],
      ["Holds", chips(s.kinds)],
      ...holds(s, o.now),
    ])}<div class="kx-psec"><div class="kx-psh">${infoLabel("Refused writes", "Items this writer sent that control did not store, newest first, with why: another writer's slot, a kind the campaign does not let it write, or an item that did not read.")}<span class="n">${fmtInt(s.refused.total)}</span></div>${refused ? `<ul class="kx-refused">${refused}</ul>${s.refused.total > s.refused.newest.length ? `<div class="muted small">The newest ${s.refused.newest.length} of ${fmtInt(s.refused.total)}.</div>` : ""}` : `<div class="muted small">None</div>`}</div>`;
  }
  const note = o.note?.error
    ? `<div class="kx-note bad"><b>Not changed.</b> ${esc(o.note.error)}</div>`
    : o.note?.ok
      ? `<div class="kx-note ok">${esc(o.note.ok)}</div>`
      : "";
  return `<aside class="kx-prev kx-info" id="kx-prev" aria-label="About this folder" tabindex="-1"><div class="kx-phead">${icon.folder}<span class="kx-pid">${LEVEL[s.level]}${o.place.name ? ` · ${esc(o.place.name)}` : ""}</span><button type="button" class="kx-x kx-infox" data-info-close aria-label="Close">${icon.x}</button></div><div class="kx-pbody">${note}${body}</div></aside>`;
}

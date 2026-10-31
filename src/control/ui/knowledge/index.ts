import type { KbCollection, KbItem, KbKind } from "../../kb/index.ts";
import { JOURNAL_KINDS } from "../../kb/index.ts";
import type { JournalNoteView, RunView } from "../../views/index.ts";
import { ago, esc, fmtInt, infoLabel } from "../components/index.ts";
import { attemptHref, campaignHref, knowledgeHref, runHref } from "../urls.ts";
import { clip } from "../words/index.ts";

export { KNOWLEDGE_JS } from "./client.ts";
export {
  contentsHtml,
  crumbsHtml,
  type ExplorerHit,
  type ExplorerPage,
  type ExplorerQuery,
  type ExplorerSearch,
  explorerFrame,
  explorerHref,
} from "./explorer.ts";
export { folderPaneHtml, type GrantForms } from "./folder.ts";
export { fileHref, type ReaderLinks, readerHtml, readerMissing } from "./item.ts";
export { treeList } from "./tree.ts";

/**
 * Goal 065 on the dashboard: a run's Journal tab (the agents' field notes), a campaign's Knowledge
 * section (what its agents may read, granted by the owner), and "From past research" in Start a
 * run; and the Knowledge page, the explorer of the knowledge base (goal 176: explorer.ts). Every
 * note and item is agents' text: escaped, never markup.
 */

// ---------------------------------------------------------------- words shared by the pages
const KIND_WORD: Record<KbKind, [string, string]> = {
  run: ["Run", "runs"],
  trial: ["Trial", "trials"],
  experiment: ["Experiment", "experiments"],
  attempt: ["Attempt", "attempts"],
  note: ["Note", "notes"],
  doc: ["Document", "documents"],
  source: ["Source", "sources"],
  claim: ["Claim", "claims"],
  hypothesis: ["Hypothesis", "hypotheses"],
  finding: ["Finding", "findings"],
  report: ["Report", "reports"],
  decision: ["Decision", "decisions"],
  surprise: ["Surprise", "surprises"],
  journal: ["Journal entry", "journal entries"],
  review: ["Review", "reviews"],
  reference: ["Reference", "references"],
  paper: ["Paper", "papers"],
};
const JK: Record<string, string> = {
  observation: "obs",
  decision: "dec",
  surprise: "sur",
  question: "que",
  lesson: "les",
};

/**
 * Who wrote a note or an item, as a filter key, a short label and a tone (the queue's colours).
 * The owner writes no field notes, but adds experiments the knowledge base keeps ("by you").
 */
export function writer(by: string): { key: string; text: string; cls: string } {
  if (/^lane-\d+$/.test(by)) return { key: by, text: by, cls: "lane" };
  if (by === "planner" || by.startsWith("planner"))
    return { key: "planner", text: "planner", cls: "planner" };
  if (/teacher|merged/.test(by)) return { key: "teachers", text: "teachers", cls: "teacher" };
  if (/auditor/.test(by)) return { key: "auditor", text: "auditor", cls: "auditor" };
  if (/panel|review/.test(by)) return { key: "review_panel", text: "review panel", cls: "auditor" };
  if (by === "owner" || by.startsWith("owner") || by.startsWith("control:owner"))
    return { key: "you", text: "you", cls: "you" };
  return { key: by, text: by, cls: "auditor" };
}
/** The Journal's writer filters after the lanes: the agents that write field notes. */
const WRITER_ORDER = ["planner", "teachers", "auditor", "review_panel"];
const WRITER_WORD: Record<string, string> = {
  planner: "Planner",
  teachers: "Teachers",
  auditor: "Auditor",
  review_panel: "Review panel",
};

// ---------------------------------------------------------------- a run's Journal tab
/**
 * What a note is about, linked to the experiment or the attempt where the page has it. A note
 * about the run itself (what a note that names nothing is about) needs no line on its run's page.
 */
function aboutHtml(r: RunView, n: JournalNoteView): string {
  const parts: string[] = [];
  const a = n.about;
  if (a && !(a.type === "run" && a.id === r.id)) {
    if (a.type === "experiment") {
      const x = r.queue.find((q) => q.id === a.id);
      parts.push(
        `<a href="${runHref(r, "experiments")}">${esc(x ? clip(x.title, 120) : `experiment ${a.id}`)}</a>`,
      );
    } else if (a.type === "attempt") {
      const x = r.attempts.find((y) => y.id === a.id);
      parts.push(
        `<a href="${attemptHref(r, a.id)}"><code>${esc(a.id)}</code></a>${x?.hypothesis ? ` ${esc(clip(x.hypothesis, 100))}` : ""}`,
      );
    } else if (a.type === "message") {
      const m = r.messages.find((y) => String(y.id) === a.id);
      parts.push(m ? `your message “${esc(clip(m.text, 100))}”` : `your message ${esc(a.id)}`);
    } else parts.push(`${esc(a.type)} ${esc(a.id)}`);
  }
  if (n.trial && !(a?.type === "trial" && a.id === n.trial))
    parts.push(`trial ${esc(n.trial.slice(0, 12))}`);
  return parts.join(" · ");
}

/** One note as the Journal shows it: who, its kind, when, its words and what it is about. */
function noteHtml(r: RunView, n: JournalNoteView): string {
  const w = writer(n.by);
  const ctx = aboutHtml(r, n);
  return `<div class="jnote" data-who="${esc(w.key)}" data-kind="${esc(n.kind)}"><div class="jhead"><span class="qsrc ${w.cls}" title="${esc(n.by)}">${esc(w.text)}</span><span class="jk ${JK[n.kind] ?? ""}">${esc(n.kind)}</span><span title="${esc(n.at)}">${esc(n.at.slice(5, 10))} ${esc(n.at.slice(11, 16))}</span></div><div class="jtext">${esc(n.text)}</div>${ctx ? `<div class="jctx">${ctx}</div>` : ""}</div>`;
}

/** The newest field notes the tab shows at once (the rest are in the knowledge base). */
export const JOURNAL_SHOWN = 500;

/**
 * A field note as the knowledge base keeps it (core/kb-index.ts): its words, then what it is about
 * on a line of its own, which its fields keep too, with its lane and trial. A note about nothing
 * named is about its run, as on the run's events.
 */
export function fieldNote(x: KbItem): JournalNoteView {
  const cut = x.body.lastIndexOf("\nAbout: ");
  const named = cut >= 0 ? x.body.slice(cut + 8).trim() : "";
  const space = named.indexOf(" ");
  const type = x.meta.about_type ?? (space > 0 ? named.slice(0, space) : named);
  const id = x.meta.about_id ?? (space > 0 ? named.slice(space + 1) : "");
  return {
    id: Number(x.ref) || x.id,
    by: x.by,
    kind: x.sub || "note",
    text: cut >= 0 ? x.body.slice(0, cut) : x.body,
    about: type ? { type, id } : { type: "run", id: x.run },
    lane: x.meta.lane || null,
    trial: x.meta.trial || null,
    at: x.at,
  };
}

/**
 * The Journal tab: the agents' field notes, newest first, filtered by writer and by kind, read from
 * the run's records in the knowledge base (goal 176).
 */
export function journalTab(o: {
  r: RunView;
  now: number;
  /** The run's field notes in the knowledge base, newest first, and how many it has. */
  field: { total: number; items: KbItem[] };
  /** The run's items in the knowledge base, by kind. */
  counts: Partial<Record<KbKind, number>>;
  /** The other collections the run's campaign reads. */
  reads: string[];
}): string {
  const { r } = o;
  const field = o.field.items.map(fieldNote);
  const total = Math.max(o.field.total, field.length);
  // Research notes have negative ids on the run's events (views.ts), whatever the kind.
  const notes = r.journal.filter((n) => n.id < 0).reverse();
  const writers = [...new Map(field.map((n) => [writer(n.by).key, writer(n.by)])).values()].sort(
    (a, b) => {
      const rank = (x: string) =>
        /^lane-\d+$/.test(x) ? Number(x.slice(5)) : 1000 + (WRITER_ORDER.indexOf(x) + 1 || 99);
      return rank(a.key) - rank(b.key) || a.key.localeCompare(b.key);
    },
  );
  const chip = (attr: string, key: string, label: string, on = false) =>
    `<button type="button" class="fchip${on ? " on" : ""}" ${attr}="${esc(key)}">${esc(label)}</button>`;
  const kinds = [...JOURNAL_KINDS, ...new Set(field.map((n) => n.kind))].filter(
    (k, i, xs) => xs.indexOf(k) === i,
  );
  const kindWord = (k: string) =>
    ({
      observation: "Observations",
      decision: "Decisions",
      surprise: "Surprises",
      question: "Questions",
      lesson: "Lessons",
    })[k] ?? k;
  const tried = r.queue.filter((x) => x.state === "done").length;
  const stat = (k: string, v: number) => `<span>${esc(k)}</span><b>${fmtInt(v)}</b>`;
  const others = o.reads.filter((f) => f !== r.campaign);
  const noteRow = (n: JournalNoteView) =>
    `<div class="jsnote"><span>${esc(n.text)}</span><span class="muted xs">${esc(writer(n.by).text)} · ${esc(ago(n.at, o.now))} ago${n.about && !(n.about.type === "run" && n.about.id === r.id) ? ` · ${esc(n.about.type)} ${esc(n.about.id)}` : ""}</span></div>`;
  return `<div class="jcols"><div>
<div class="small muted" style="margin-bottom:10px">Field notes the agents keep as they work: what they observe, the decisions they make and why, what surprised them, open questions and lessons. What was tried, and its result, is in <a href="${runHref(r, "experiments")}">Experiments</a>.</div>
${
  field.length
    ? `<div class="ktools" id="jf">${chip("data-jw", "all", "Everyone", true)}${writers.map((w) => chip("data-jw", w.key, WRITER_WORD[w.key] ?? w.text)).join("")}<input class="jsearch" type="search" placeholder="Search the journal" aria-label="Search the journal"></div>
<div class="ktools" id="jk">${chip("data-jk", "all", "Every kind", true)}${kinds.map((k) => chip("data-jk", k, kindWord(k))).join("")}</div>
<div id="jl">${field
        .slice(0, JOURNAL_SHOWN)
        .map((n) => noteHtml(r, n))
        .join(
          "",
        )}</div>${total > field.length ? `<div class="muted small" style="margin-top:8px">The newest ${fmtInt(field.length)} of ${fmtInt(total)}. All of them are in the run's records on <a href="${knowledgeHref(`${r.campaign ?? r.id}/${r.id}/records`)}?kind=note">Knowledge</a> and in the run's export.</div>` : ""}`
    : `<div class="card"><div class="empty">No field notes yet. The lanes, the planner and the advisors write them as they work.</div></div>`
}
</div><div class="jside">
<div class="card qcard"><h3>This run's corpus</h3><div class="jstat">${stat("Field notes", total)}${stat("Notes", notes.length)}${stat("Sources read", o.counts.source ?? 0)}${stat("Experiments tried", tried)}${o.counts.claim ? stat("Claims", o.counts.claim) : ""}${stat("Findings", o.counts.finding ?? 0)}</div><div class="small muted">Everything here goes into the run's export, with the final report.</div></div>
${
  r.campaign
    ? `<div class="card qcard"><h3>The campaign's collection</h3><div class="small">Everything here goes into <b>${esc(r.campaign)}</b>'s collection in Thermite's knowledge base, under this run, with its writer and time.</div><div class="small muted">${others.length ? `Its agents also read: ${others.map((f) => `<b>${esc(f)}</b>`).join(", ")}.` : "Its agents read only this campaign's collection."}</div><div class="kbbtns"><a class="btn sm" href="${knowledgeHref(`${r.campaign}/${r.id}`)}">Open the run's folders</a><a class="btn sm ghost" href="${campaignHref(r.campaign)}#knowledge">What it can read</a></div></div>`
    : ""
}
<div class="card qcard"><h3>Notes</h3>${
    notes.length
      ? `${notes.slice(0, 5).map(noteRow).join("")}${notes.length > 5 ? `<details class="jmore"><summary class="small">All ${notes.length} notes</summary>${notes.slice(5).map(noteRow).join("")}</details>` : ""}`
      : `<div class="muted small">No notes yet. Agents note facts they found, with their source.</div>`
  }</div>
</div></div>`;
}

// ---------------------------------------------------------------- a campaign's Knowledge section
/**
 * A campaign's Knowledge section: a short summary of its collection (what it holds, its last
 * write, its grants both ways), read only, with Open the collection: the explorer, where the owner
 * gives and ends grants (goal 176, question 4).
 */
export function campaignKnowledge(o: {
  campaign: string;
  collection: KbCollection;
  now: number;
}): string {
  const f = o.collection;
  const stat = (k: string, v: number) => `<span>${esc(k)}</span><b>${fmtInt(v)}</b>`;
  const names = (xs: string[], none: string) =>
    xs.length
      ? xs.map((x) => `<a href="${knowledgeHref(x)}"><b>${esc(x)}</b></a>`).join(", ")
      : `<span class="muted">${esc(none)}</span>`;
  return `<div class="block" id="knowledge"><div class="head"><h2>Knowledge</h2><span class="right">${esc(o.campaign)}'s collection in Thermite's knowledge base</span></div>
<div class="card kbcard"><div class="jstat">${stat("Items", f.items)}${stat("Runs", f.runs)}${stat("Field notes", f.journal)}${stat("Experiments", f.counts.experiment ?? 0)}${stat("Attempts", f.counts.attempt ?? 0)}${stat("Notes and documentation", (f.counts.note ?? 0) - f.journal + (f.counts.doc ?? 0))}${stat("Sources read", f.counts.source ?? 0)}${f.counts.finding ? stat("Findings", f.counts.finding) : ""}${f.counts.report ? stat("Reports", f.counts.report) : ""}</div>
<dl class="kx-facts"><dt>Last write</dt><dd>${f.updated_at ? `<span title="${esc(f.updated_at)}">${esc(ago(f.updated_at, o.now))} ago</span>` : "none yet"}</dd><dt>Reads</dt><dd>${names(f.reads, "None: its agents read only this campaign's collection.")}</dd><dt>Read by</dt><dd>${names(f.read_by, "No other campaign.")}</dd></dl>
<div class="kbbtns"><a class="btn sm" href="${knowledgeHref(o.campaign)}">Open the collection</a><span class="muted small">Grants are added and removed there.</span></div></div></div>`;
}

// ---------------------------------------------------------------- Start a run: from past research
/** What a picked item is called in the list, and its line under the title. */
export function pastWords(x: KbItem, result: string | null): { label: string; line: string } {
  const label =
    x.kind === "experiment"
      ? "Past experiment"
      : x.kind === "note" && x.sub && x.sub !== "note"
        ? `${x.sub[0]?.toUpperCase() ?? ""}${x.sub.slice(1)}`
        : KIND_WORD[x.kind][0];
  const line = [
    x.run,
    result ?? (x.kind === "claim" && x.sub ? x.sub : ""),
    `by ${writer(x.by).text}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { label, line };
}

/** The drawer's "From past research": a search of the readable collections, results to tick. */
export function pastSection(o: {
  campaign: string;
  /** The collections this campaign may read: its own first. */
  readable: string[];
  q: string;
  results: KbItem[];
  result: (x: KbItem) => string | null;
}): string {
  const row = (x: KbItem) => {
    const w = pastWords(x, o.result(x));
    return `<label class="pastrow"><input type="checkbox" name="past" value="${x.id}"><span><b>${esc(w.label)}</b> · ${esc(x.title)}<br><span class="muted">${esc(w.line)}</span></span><span class="muted xs">${esc(x.campaign)}</span></label>`;
  };
  return `<div class="sfd" data-past="${esc(o.campaign)}" data-agents-only>${infoLabel("From past research", "Search the collections this campaign can read (its own and the campaigns you granted) for related experiments and findings. Ticked experiments join the new run's queue, each saying where it came from; a ticked finding, claim, note or report goes to every agent's brief as background.")}<input type="search" data-past-q value="${esc(o.q)}" placeholder="Search past experiments, findings and notes" aria-label="Search past research"><div class="small muted">Searching: ${o.readable.map((f) => esc(f)).join(", ")}. <a href="${campaignHref(o.campaign)}#knowledge" style="color:var(--info-foreground)">Change</a></div>
<div class="past" data-past-list>${o.results.map(row).join("") || `<div class="muted small" data-past-none>Nothing found in these collections yet.</div>`}</div></div>`;
}

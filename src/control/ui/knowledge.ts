import type { KbCollection, KbItem, KbKind } from "../kb/index.ts";
import { JOURNAL_KINDS } from "../kb/index.ts";
import type { JournalNoteView, RunView } from "../views/index.ts";
import { infoLabel } from "./campaigns/new/index.ts";
import { ago, esc, fmtInt } from "./components/index.ts";
import { attemptHref, campaignHref, runHref } from "./urls.ts";
import { clip } from "./words/index.ts";

/**
 * Goal 065 on the dashboard: a run's Journal tab (the agents' field notes), the Knowledge page
 * (every campaign's collection in Thermite's knowledge base, and a search across them), a
 * campaign's Knowledge section (what its agents may read, granted by the owner), and "From past
 * research" in Start a run. Every note and item is agents' text: escaped, never markup.
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
const KIND_ICON: Record<KbKind, string> = {
  run: "▶",
  trial: "⏱",
  experiment: "🧪",
  attempt: "🎯",
  note: "📓",
  doc: "📝",
  source: "🔗",
  claim: "💬",
  hypothesis: "💡",
  finding: "📄",
  report: "📑",
  decision: "⚖",
  surprise: "❗",
  journal: "📓",
  review: "🔎",
  reference: "📚",
  paper: "📜",
};
/** The kinds the Knowledge page filters by, in its order. */
export const SEARCH_KINDS: KbKind[] = [
  "run",
  "trial",
  "experiment",
  "attempt",
  "note",
  "doc",
  "source",
  "claim",
  "hypothesis",
  "finding",
  "report",
  "decision",
  "surprise",
  "journal",
  "review",
  "reference",
  "paper",
];
const JK: Record<string, string> = {
  observation: "obs",
  decision: "dec",
  surprise: "sur",
  question: "que",
  lesson: "les",
};

/** A collection's contents in a line: "412 field notes · 86 experiments · …". */
export function collectionLine(f: Pick<KbCollection, "counts" | "journal" | "runs">): string {
  const notes = (f.counts.note ?? 0) - f.journal;
  const parts: [number, string][] = [
    [f.runs, "runs"],
    [f.counts.trial ?? 0, "trials"],
    [f.journal, "field notes"],
    [f.counts.experiment ?? 0, "experiments"],
    [f.counts.attempt ?? 0, "attempts"],
    [notes, "notes"],
    [f.counts.doc ?? 0, "documents"],
    [f.counts.source ?? 0, "sources"],
    [f.counts.claim ?? 0, "claims"],
    [f.counts.hypothesis ?? 0, "hypotheses"],
    [f.counts.finding ?? 0, "findings"],
    [f.counts.report ?? 0, "reports"],
    [f.counts.decision ?? 0, "decisions"],
    [f.counts.surprise ?? 0, "surprises"],
    [f.counts.journal ?? 0, "journal entries"],
    [f.counts.review ?? 0, "reviews"],
    [f.counts.reference ?? 0, "references"],
    [f.counts.paper ?? 0, "papers"],
  ];
  return (
    parts
      .filter(([n]) => n > 0)
      .map(([n, w]) => `${fmtInt(n)} ${n === 1 ? w.replace(/ies$/, "y").replace(/s$/, "") : w}`)
      .join(" · ") || "nothing yet"
  );
}

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
const JOURNAL_SHOWN = 500;

/** The Journal tab: the agents' field notes, newest first, filtered by writer and by kind. */
export function journalTab(o: {
  r: RunView;
  now: number;
  /** The run's items in the knowledge base, by kind. */
  counts: Partial<Record<KbKind, number>>;
  /** The other collections the run's campaign reads. */
  reads: string[];
}): string {
  const { r } = o;
  // Field notes have the ledger's ids; research notes negative ones (views.ts), whatever the kind.
  const field = r.journal.filter((n) => n.id > 0).reverse();
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
        )}</div>${field.length > JOURNAL_SHOWN ? `<div class="muted small" style="margin-top:8px">The newest ${JOURNAL_SHOWN} of ${field.length}. All of them are in the campaign's collection on <a href="/ui/knowledge?collection=${encodeURIComponent(r.campaign ?? "")}&amp;kind=note">Knowledge</a> and in the run's export.</div>` : ""}`
    : `<div class="card"><div class="empty">No field notes yet. The lanes, the planner and the advisors write them as they work.</div></div>`
}
</div><div class="jside">
<div class="card qcard"><h3>This run's corpus</h3><div class="jstat">${stat("Field notes", field.length)}${stat("Notes", notes.length)}${stat("Sources read", o.counts.source ?? 0)}${stat("Experiments tried", tried)}${o.counts.claim ? stat("Claims", o.counts.claim) : ""}${stat("Findings", o.counts.finding ?? 0)}</div><div class="small muted">Everything here goes into the run's export, with the final report.</div></div>
${
  r.campaign
    ? `<div class="card qcard"><h3>The campaign's collection</h3><div class="small">Everything here goes into <b>${esc(r.campaign)}</b>'s collection in Thermite's knowledge base, under this run, with its writer and time.</div><div class="small muted">${others.length ? `Its agents also read: ${others.map((f) => `<b>${esc(f)}</b>`).join(", ")}.` : "Its agents read only this campaign's collection."}</div><a class="btn sm ghost" href="${campaignHref(r.campaign)}#knowledge" style="justify-self:start">What it can read</a></div>`
    : ""
}
<div class="card qcard"><h3>Notes</h3>${
    notes.length
      ? `${notes.slice(0, 5).map(noteRow).join("")}${notes.length > 5 ? `<details class="jmore"><summary class="small">All ${notes.length} notes</summary>${notes.slice(5).map(noteRow).join("")}</details>` : ""}`
      : `<div class="muted small">No notes yet. Agents note facts they found, with their source.</div>`
  }</div>
</div></div>`;
}

// ---------------------------------------------------------------- search results, with their origin
/** Where a run's page is, wherever the run ran (goal 170); none for a run no rig created. */
export type RunLink = (run: string) => string | undefined;

/** One item with its origin (campaign, run, who, when), its result, and its text on demand. */
function resultHtml(x: KbItem, now: number, link: RunLink, result: string | null): string {
  const href = link(x.run);
  const run = href ? `<a href="${esc(href)}">${esc(x.run)}</a>` : esc(x.run);
  const kind =
    x.kind === "note" && x.sub && x.sub !== "note" ? `Field note (${x.sub})` : KIND_WORD[x.kind][0];
  const meta = [
    `<a href="${campaignHref(x.campaign)}">${esc(x.campaign)}</a>`,
    run,
    `by ${esc(writer(x.by).text)}`,
    ...(result ? [esc(result)] : x.sub && x.kind !== "note" ? [esc(x.sub)] : []),
  ].join(" · ");
  return `<details class="kbres"><summary><span class="kbic">${KIND_ICON[x.kind]}</span><span><b>${esc(kind)}</b> · ${esc(x.title)}<br><span class="muted">${meta}</span></span><span class="muted xs nowrap" title="${esc(x.updated_at)}">${esc(ago(x.updated_at, now))} ago</span></summary><div class="kbbody">${esc(x.body)}${
    x.url
      ? `<div>${/^https?:\/\//i.test(x.url) ? `<a href="${esc(x.url)}" rel="noreferrer noopener">${esc(clip(x.url, 120))}</a>` : esc(clip(x.url, 120))}</div>`
      : ""
  }</div></details>`;
}

// ---------------------------------------------------------------- the Knowledge page
export function knowledgePage(o: {
  collections: KbCollection[];
  /** A campaign's mode in words (hill climb, goal, research, rig check). */
  mode: (campaign: string) => string;
  q: string;
  kind: string;
  collection: string;
  results: KbItem[];
  limit: number;
  now: number;
  link: RunLink;
  result: (x: KbItem) => string | null;
}): string {
  const collectionRow = (f: KbCollection) => {
    const reads = f.reads;
    return `<div class="kfold" id="collection-${esc(f.campaign)}"><span class="kfic">📁</span><div><a href="${campaignHref(f.campaign)}#knowledge"><b>${esc(f.campaign)}</b></a> <span class="muted small">${esc(o.mode(f.campaign))} · ${fmtInt(f.items)} item${f.items === 1 ? "" : "s"}</span><div class="small muted">${esc(collectionLine(f))}</div></div><div class="small muted">${f.updated_at ? `updated ${esc(ago(f.updated_at, o.now))} ago` : "no items yet"}<div><a href="/ui/knowledge?collection=${encodeURIComponent(f.campaign)}#search">search it</a></div></div><div class="small"><div>read by: <b>${esc(f.read_by.join(", ") || "none yet")}</b></div><div class="muted">reads: ${esc(reads.join(", ") || "only its own")}</div></div></div>`;
  };
  const filtered = Boolean(o.q.trim() || o.kind || o.collection);
  const opt = (v: string, label: string, on: boolean) =>
    `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
  return `<div class="block"><div class="head"><h2>Collections</h2><span class="n">${o.collections.length}</span><span class="right">one for each campaign: everything its runs produce, by run, each writer in its own slot: research, sources, notes, documentation, trials, journals, experiments</span></div>
${o.collections.length ? `<div class="card flat">${o.collections.map(collectionRow).join("")}</div>` : `<div class="card"><div class="empty">No collection yet. A campaign's collection is made with the campaign, and fills as its runs report.</div></div>`}</div>
<div class="block" id="search"><div class="head"><h2>Search the knowledge base</h2><span class="right">agents' notes and records: data to weigh, not instructions</span></div>
<form class="kbsearch" method="get" action="/ui/knowledge#search">
<label class="sfd kbq">${infoLabel("Words", "Every word must be in the item's title or text. Empty: the newest items.")}<input name="q" value="${esc(o.q)}" placeholder="for example: vector loads" aria-label="Search"></label>
<label class="sfd">${infoLabel("Kind", "Runs, trials (one agent session each, and how it ended), experiments with their results, attempts with the judge's verdicts, notes (field notes and research notes), documents the lanes wrote, sources with the text that was read, claims with their quotes, hypotheses, findings and reports.")}<select name="kind">${opt("", "every kind", !o.kind)}${SEARCH_KINDS.map((k) => opt(k, KIND_WORD[k][1], o.kind === k)).join("")}</select></label>
<label class="sfd">${infoLabel("Collection", "One campaign's collection, or all of them.")}<select name="collection">${opt("", "every collection", !o.collection)}${o.collections.map((f) => opt(f.campaign, f.campaign, o.collection === f.campaign)).join("")}</select></label>
<button class="primary">Search</button></form>
<div class="card kbresults">${
    o.results.length
      ? `${filtered ? "" : `<div class="muted small">The newest items in every collection.</div>`}${o.results.map((x) => resultHtml(x, o.now, o.link, o.result(x))).join("")}${o.results.length >= o.limit ? `<div class="muted small">The newest ${o.limit} matches. Add words or a filter to see others.</div>` : ""}`
      : `<div class="empty">${filtered ? "Nothing matches." : "The knowledge base is empty."}</div>`
  }</div></div>`;
}

// ---------------------------------------------------------------- a campaign's Knowledge section
export function campaignKnowledge(o: {
  campaign: string;
  collection: KbCollection;
  /** Every collection, for the grants' names and the Add list. */
  collections: KbCollection[];
  mode: (campaign: string) => string;
  csrf: string;
  now: number;
  /** Why the owner's last grant or removal was refused, if it was. */
  error?: string | undefined;
}): string {
  const f = o.collection;
  const action = (what: "grant" | "revoke") =>
    `/ui/campaigns/${encodeURIComponent(o.campaign)}/kb/${what}`;
  const byName = new Map(o.collections.map((x) => [x.campaign, x]));
  const stat = (k: string, v: number) => `<span>${esc(k)}</span><b>${fmtInt(v)}</b>`;
  const readRow = (name: string) => {
    const x = byName.get(name);
    return `<div class="readrow"><span>📁</span><div><b>${esc(name)}</b> <span class="muted small">${x ? `${esc(o.mode(name))} · ${fmtInt(x.items)} items${x.updated_at ? ` · ${esc(ago(x.updated_at, o.now))} ago` : ""}` : "no items yet"}</span></div><form class="inline" method="post" action="${action("revoke")}"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="reads" value="${esc(name)}"><button class="sm ghost">Remove</button></form></div>`;
  };
  const addable = o.collections.filter(
    (x) => x.campaign !== o.campaign && !f.reads.includes(x.campaign),
  );
  return `<div class="block" id="knowledge"><div class="cols kbcols"><div>
<div class="head"><h2>Knowledge</h2><span class="right">${esc(o.campaign)}'s collection in Thermite's knowledge base</span></div>
${o.error ? `<div class="card warn" style="margin-bottom:12px"><b class="bad">Not changed.</b> ${esc(o.error)}</div>` : ""}
<div class="card kbcard"><div class="jstat">${stat("Field notes", f.journal)}${stat("Experiments", f.counts.experiment ?? 0)}${stat("Attempts", f.counts.attempt ?? 0)}${stat("Notes and documentation", (f.counts.note ?? 0) - f.journal + (f.counts.doc ?? 0))}${stat("Sources read", f.counts.source ?? 0)}${f.counts.trial ? stat("Trials", f.counts.trial) : ""}${f.counts.claim ? stat("Claims", f.counts.claim) : ""}${f.counts.hypothesis ? stat("Hypotheses", f.counts.hypothesis) : ""}${f.counts.finding ? stat("Findings", f.counts.finding) : ""}${f.counts.report ? stat("Reports", f.counts.report) : ""}</div><div class="small muted">Every run of this campaign writes here, each item under its run, in its writer's slot, with its time. Agents read it; Thermite's records of each run write to it.</div><div class="kbbtns"><a class="btn sm" href="/ui/knowledge?collection=${encodeURIComponent(o.campaign)}#search">Search it</a><a class="btn sm ghost" href="/ui/knowledge#collection-${encodeURIComponent(o.campaign)}">Open the collection</a></div></div>
<div class="head" style="margin-top:18px"><h2>Can read from</h2><span class="right">other collections this campaign's agents may search and read; change it any time</span></div>
<div class="card flat kbreads">${f.reads.map(readRow).join("") || `<div class="readrow"><span></span><div class="muted small">None: its agents read only this campaign's collection.</div><span></span></div>`}</div>
<form class="kbadd" method="post" action="${action("grant")}"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><label class="sfd">${infoLabel("Add a collection", "Another campaign's collection this campaign's agents may search and read: its experiments with their results, journals, notes, sources and findings. They never write to it. Its runs at work get it at their next sync, and new runs start with it.")}<select name="reads" required><option value="">Add a collection…</option>${addable.map((x) => `<option value="${esc(x.campaign)}">${esc(x.campaign)} (${esc(o.mode(x.campaign))} · ${fmtInt(x.items)} items)</option>`).join("")}</select></label><button class="sm">Add</button><span class="muted small">Runs at work see the change at their next sync.</span></form>
</div><div class="side">
<div class="card qcard"><h3>Who reads ${esc(o.campaign)}'s collection</h3><div class="small">${f.read_by.length ? f.read_by.map((x) => `<a href="${campaignHref(x)}#knowledge"><b>${esc(x)}</b></a>`).join(", ") : "No other campaign."}</div><div class="small muted">Granted from that campaign's page. A campaign never writes to another's collection.</div></div>
</div></div></div>`;
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

import {
  KB_ITEM_TYPES,
  KB_OUTCOMES,
  type KbItemType,
  type KbKind,
  type KbListSort,
  type KbOutcome,
  kbItemType,
} from "../../../core/kb.ts";
import type { KbFolder, KbListAnswer } from "../../kb/index.ts";
import type { KbCounts } from "../../store/index.ts";
import { ago, esc, fmtInt, icon, infoLabel } from "../components/index.ts";
import { sizeWords } from "../exports.ts";
import { knowledgeHref } from "../urls.ts";
import { treeHtml } from "./tree.ts";

/**
 * The Knowledge page (goal 176): an explorer of the knowledge base, laid out as a file manager.
 * The toolbar holds the open folder's path and a one-line search; on the left, the tree of
 * folders (tree.ts); in the middle, what the open folder holds, folders first, under one row of
 * dropdown filters. Every fact on it comes from the owner's reads that REST and MCP also give:
 * kb_list for the folders, the items and the counts, kb_search for a search, kb_read for an item.
 * Agents' text is escaped, never markup, and the only links an item gets here are to its own page.
 */

/** What the page's address asks: a search's words, the filters, the sort and the page. */
export interface ExplorerQuery {
  q: string;
  kinds: KbKind[];
  outcomes: KbOutcome[];
  types: KbItemType[];
  slots: string[];
  sort: KbListSort | undefined;
  order: "asc" | "desc" | undefined;
  offset: number;
  /** The item in the preview pane, by its address, and its version (none: its newest). */
  item?: string | undefined;
  version?: number | undefined;
}

/** One hit of a search, as the owner's search gives it. */
export interface ExplorerHit {
  address: string;
  title: string;
  kind: string;
  outcome: string | null;
  slot: string;
  at: string;
  excerpt: string;
  file: { bytes: number } | null;
  /** Why its evidence was withdrawn; none when it stands, or a search did not say. */
  withdrawn?: string | null | undefined;
}

/** A search of the open folder, as the owner's search answers it, or why it was refused. */
export interface ExplorerSearch {
  matched: number;
  next_offset: number | null;
  counts: Pick<KbCounts, "kind" | "outcome" | "slot">;
  hits: ExplorerHit[];
  error?: string | undefined;
}

/** The contents' facts: the open folder, and its list or its search. */
export interface ExplorerPage {
  /** The open folder, as kb_list gives it (the whole knowledge base at the root). */
  place: KbFolder;
  query: ExplorerQuery;
  list?: KbListAnswer | undefined;
  search?: ExplorerSearch | undefined;
  /** How many items a page holds: the list's, or the search's. */
  pageSize: number;
  now: number;
}

const FACETS = ["kind", "outcome", "type", "slot"] as const;
type Facet = (typeof FACETS)[number];
const FACET_LABEL: Record<Facet, string> = {
  kind: "Kind",
  outcome: "Outcome",
  type: "Type",
  slot: "Writer",
};
const FACET_TIP: Record<Facet, string> = {
  kind: "What the item is, such as an experiment, an attempt, a note or a finding. Pick one or more: an item of any of them shows.",
  outcome:
    "How an experiment or an attempt ended, from Thermite's records: won, screened (being confirmed), regress (worse than the champion), neutral (no better), broken, unclear (no answer about the change), dropped by the planner, or open (no outcome yet). Other items have none.",
  type: "Records: what Thermite's code wrote about a run. Blurbs: short texts an agent wrote. Files: documents kept whole.",
  slot: "Who wrote the item: records (Thermite's code), or the agent's slot, such as planner or worker-1.",
};
const TYPE_WORD: Record<KbItemType, string> = {
  record: "records",
  blurb: "blurbs",
  file: "files",
};
export const TYPE_ICON: Record<KbItemType, string> = {
  record: icon.record,
  blurb: icon.blurb,
  file: icon.doc,
};
const LEVEL_WORD: Record<KbFolder["level"], [string, string]> = {
  knowledge_base: ["Knowledge base", "knowledge bases"],
  collection: ["Collection", "collections"],
  run: ["Run", "runs"],
  slot: ["Slot", "slots"],
};
/** The folders a level holds. */
const CHILD_LEVEL: Record<KbFolder["level"], KbFolder["level"]> = {
  knowledge_base: "collection",
  collection: "run",
  run: "slot",
  slot: "slot",
};
/** An outcome's chip tone, as the dashboard's other chips say good, bad and waiting. */
const OUTCOME_TONE: Record<string, string> = {
  won: "ok",
  screened: "info",
  regress: "bad",
  broken: "bad kx-broken",
  unclear: "warn",
  dropped: "kx-dim",
};
/** An item's outcome as a small coloured chip. */
export const outcomeChip = (outcome: string) =>
  `<span class="chip ${OUTCOME_TONE[outcome] ?? ""}">${esc(outcome)}</span>`;

const SORT_WORD: Record<KbListSort, string> = {
  name: "Name",
  kind: "Kind",
  outcome: "Outcome",
  writer: "Writer",
  modified: "Modified",
  size: "Size",
};
/** The order a column sorts in when first pressed. */
const firstOrder = (k: KbListSort): "asc" | "desc" =>
  k === "modified" || k === "size" ? "desc" : "asc";

const values = (q: ExplorerQuery, f: Facet): readonly string[] =>
  f === "kind" ? q.kinds : f === "outcome" ? q.outcomes : f === "type" ? q.types : q.slots;

/** The page's address for a folder (or an item) with these words, filters, sort and page. */
export function explorerHref(path: string, q: ExplorerQuery): string {
  const p = new URLSearchParams();
  if (q.q.trim()) p.set("q", q.q);
  for (const f of FACETS) if (values(q, f).length) p.set(f, values(q, f).join(","));
  if (q.sort) p.set("sort", q.sort);
  if (q.order) p.set("order", q.order);
  if (q.offset) p.set("offset", String(q.offset));
  if (q.item) p.set("item", q.item);
  if (q.item && q.version) p.set("version", String(q.version));
  const s = p.toString();
  return `${knowledgeHref(path)}${s ? `?${s}` : ""}`;
}

const withFacet = (q: ExplorerQuery, f: Facet, vs: string[]): ExplorerQuery => ({
  ...q,
  offset: 0,
  ...(f === "kind"
    ? { kinds: vs as KbKind[] }
    : f === "outcome"
      ? { outcomes: vs as KbOutcome[] }
      : f === "type"
        ? { types: vs as KbItemType[] }
        : { slots: vs }),
});

/** A path's crumbs: Knowledge, then each part of the open folder, each a link. */
export function crumbsHtml(parts: { path: string; name: string }[], current: string): string {
  const all = [{ path: "", name: "Knowledge" }, ...parts];
  return `<nav class="kx-crumbs" aria-label="Folder path">${all
    .map(
      (c, i) =>
        `${i ? `<span class="kx-sep" aria-hidden="true">›</span>` : ""}<a href="${esc(knowledgeHref(c.path))}"${c.path === current ? ` aria-current="page"` : ""}>${esc(c.name)}</a>`,
    )
    .join("")}</nav>`;
}

/** The toolbar's search: one line, which searches the open folder; the filters stay. */
function searchHtml(folder: string, q: ExplorerQuery): string {
  const kept = (["kind", "outcome", "slot"] as const)
    .filter((f) => values(q, f).length)
    .map((f) => `<input type="hidden" name="${f}" value="${esc(values(q, f).join(","))}">`)
    .join("");
  const clear = q.q.trim()
    ? `<a class="kx-qx" href="${esc(explorerHref(folder, { ...q, q: "", offset: 0 }))}" aria-label="Clear the search">${icon.x}</a>`
    : "";
  return `<form class="kx-search" role="search" method="get" action="${esc(knowledgeHref(folder))}">${icon.search}<input type="search" name="q" value="${esc(q.q)}" placeholder="Search" aria-label="Search this folder" maxlength="300" autocomplete="off">${kept}${clear}</form>`;
}

/** The page around its main part: the toolbar, the tree, and the main part. */
export function explorerFrame(o: {
  crumbs: string;
  folder: string;
  query: ExplorerQuery;
  collections: readonly KbFolder[];
  kids: ReadonlyMap<string, readonly KbFolder[]>;
  current: string;
  main: string;
  /** The preview pane, on the right of the table (item.ts). */
  pane?: string | undefined;
}): string {
  return `<div class="kx" data-folders="closed">
<div class="kx-bar">${o.crumbs}${searchHtml(o.folder, o.query)}</div>
<div class="kx-body">${treeHtml(o.collections, o.kids, o.current)}<section class="kx-main" aria-label="Contents">${o.main}</section>${o.pane ?? ""}</div>
</div><script src="/ui/assets/knowledge.js" defer></script>`;
}

/** One dropdown filter: its button, and a popover with a checkbox for each value and its count. */
function facetHtml(
  p: ExplorerPage,
  f: Facet,
  options: { value: string; label: string; n: number }[],
): string {
  const picked = values(p.query, f);
  const clear = picked.length
    ? `<a class="kx-clear" href="${esc(explorerHref(p.place.path, withFacet(p.query, f, [])))}">Clear</a>`
    : "";
  const rows = options
    .map(
      (o) =>
        `<label class="kx-opt${o.n ? "" : " zero"}"><input type="checkbox" name="${f}" value="${esc(o.value)}"${picked.includes(o.value) ? " checked" : ""}><span class="${f === "outcome" ? `chip ${OUTCOME_TONE[o.value] ?? ""}` : "lbl"}">${esc(o.label)}</span><span class="n">${fmtInt(o.n)}</span></label>`,
    )
    .join("");
  return `<details class="kx-dd" data-dd="${f}"><summary class="kx-ddb${picked.length ? " on" : ""}">${esc(FACET_LABEL[f])}${picked.length ? `<span class="kx-badge">${picked.length}</span>` : ""}${icon.down}</summary><div class="menu-pop kx-pop" role="group" aria-label="Filter by ${esc(FACET_LABEL[f].toLowerCase())}"><div class="kx-pophead">${infoLabel(FACET_LABEL[f], FACET_TIP[f])}${clear}</div>${rows || `<div class="muted small">None here</div>`}<noscript><button class="sm">Apply</button></noscript></div></details>`;
}

/** Each filter's values and counts, picked ones too: the list's, or where a search's words land. */
function facetOptions(p: ExplorerPage, f: Facet): { value: string; label: string; n: number }[] {
  const counts: Record<string, number> =
    (p.search ? p.search.counts[f as "kind" | "outcome" | "slot"] : p.list?.counts[f]) ?? {};
  const picked = values(p.query, f);
  if (f === "outcome") return KB_OUTCOMES.map((v) => ({ value: v, label: v, n: counts[v] ?? 0 }));
  if (f === "type")
    return KB_ITEM_TYPES.map((v) => ({ value: v, label: TYPE_WORD[v], n: counts[v] ?? 0 }));
  const names = [...new Set([...Object.keys(counts), ...picked])].filter((v) => v !== "other");
  const sorted =
    f === "slot"
      ? names.sort(
          (a, b) =>
            Number(b === "records") - Number(a === "records") ||
            a.localeCompare(b, "en", { numeric: true }),
        )
      : names.sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  return sorted.map((v) => ({ value: v, label: v, n: counts[v] ?? 0 }));
}

/** The row of filters: Folders (at phone width), the dropdowns, the picks as chips, the count. */
function filterRow(p: ExplorerPage, count: string): string {
  const q = p.query;
  // A search keeps kinds, outcomes and slots; a type is the list's alone.
  const shown = FACETS.filter((f) => !(p.search && f === "type"));
  const chips = shown
    .flatMap((f) =>
      values(q, f).map((v) => {
        const label = `${FACET_LABEL[f]}: ${f === "type" ? TYPE_WORD[v as KbItemType] : v}`;
        const href = explorerHref(
          p.place.path,
          withFacet(
            q,
            f,
            values(q, f).filter((x) => x !== v),
          ),
        );
        return `<a class="kx-chip" href="${esc(href)}" aria-label="Remove the filter ${esc(label)}"><span>${esc(label)}</span>${icon.x}</a>`;
      }),
    )
    .join("");
  const any = shown.some((f) => values(q, f).length);
  const none: ExplorerQuery = { ...q, kinds: [], outcomes: [], types: [], slots: [], offset: 0 };
  const keep = [
    q.q.trim() ? `<input type="hidden" name="q" value="${esc(q.q)}">` : "",
    q.sort ? `<input type="hidden" name="sort" value="${esc(q.sort)}">` : "",
    q.order ? `<input type="hidden" name="order" value="${esc(q.order)}">` : "",
  ].join("");
  return `<form class="kx-filters" method="get" action="${esc(knowledgeHref(p.place.path))}">${keep}<button type="button" class="kx-foldbtn" aria-controls="kx-tree" aria-expanded="false">${icon.folder}<span>Folders</span>${icon.down}</button><button type="button" class="kx-infobtn" aria-controls="kx-prev" aria-expanded="false">${icon.file}<span>Info</span></button>${shown.map((f) => facetHtml(p, f, facetOptions(p, f))).join("")}${chips}${any ? `<a class="kx-clearall" href="${esc(explorerHref(p.place.path, none))}">Clear</a>` : ""}<span class="kx-count" role="status">${esc(count)}</span></form>`;
}

/** A column's header: a link that sorts by it, with ▲ or ▼ on the column it sorts by now. */
function head(p: ExplorerPage, k: KbListSort, cls: string, sortable: boolean): string {
  if (!sortable) return `<th class="${cls}">${SORT_WORD[k]}</th>`;
  const sort = p.query.sort ?? "modified";
  const order = p.query.order ?? firstOrder(sort);
  const on = sort === k;
  const next: ExplorerQuery = {
    ...p.query,
    sort: k,
    order: on ? (order === "asc" ? "desc" : "asc") : firstOrder(k),
    offset: 0,
  };
  return `<th class="${cls}" aria-sort="${on ? (order === "asc" ? "ascending" : "descending") : "none"}"><a href="${esc(explorerHref(p.place.path, next))}">${SORT_WORD[k]}${on ? `<span class="kx-arrow" aria-hidden="true">${order === "asc" ? "▲" : "▼"}</span>` : ""}</a></th>`;
}

const when = (iso: string | null, now: number) =>
  iso ? `<span title="${esc(iso)}">${esc(ago(iso, now))} ago</span>` : "";

/** A folder's row: its name with its tags, its level, and its newest change. */
function folderRow(f: KbFolder, now: number): string {
  const href = esc(knowledgeHref(f.path));
  const tags = [
    f.archived ? `<span class="kx-tag">archived</span>` : "",
    f.running ? `<span class="dot ok" role="img" aria-label="running"></span>` : "",
    f.fresh ? `<span class="kx-tag">fresh</span>` : "",
  ].join("");
  return `<tr data-href="${href}"${f.archived ? ` class="dim"` : ""}><td class="c-name"><span class="kx-cell">${icon.folder}<span class="kx-title"><span class="kx-line"><a href="${href}">${esc(f.name)}</a>${tags}</span></span></span></td><td class="c-kind">${LEVEL_WORD[f.level][0]}</td><td class="c-out"></td><td class="c-writer">${f.writer ? esc(f.writer) : ""}</td><td class="c-mod">${when(f.updated_at, now)}</td><td class="c-size num"></td></tr>`;
}

/** A search's excerpt: escaped, then each word it matched (between ** and **) marked. */
const markedExcerpt = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>");

/**
 * An item's row: its type's icon, its title, which opens it in the preview pane, with its address
 * under it, its kind, outcome, writer, newest change and a file's size.
 */
function itemRow(x: ExplorerHit, p: ExplorerPage): string {
  const href = esc(explorerHref(p.place.path, { ...p.query, item: x.address, version: undefined }));
  const type = kbItemType(x);
  const out = x.outcome ? outcomeChip(x.outcome) : "";
  const wd = x.withdrawn
    ? `<span class="kx-wd" role="img" aria-label="Evidence withdrawn" title="${esc(x.withdrawn)}">${icon.warn}</span>`
    : "";
  return `<tr data-item-href="${href}"${p.query.item === x.address ? ` class="on"` : ""}><td class="c-name"><span class="kx-cell" title="${TYPE_WORD[type]}">${TYPE_ICON[type]}<span class="kx-title"><span class="kx-line"><a href="${href}" data-item>${esc(x.title || x.address)}</a>${wd}</span><span class="kx-addr">${esc(x.address)}</span>${x.excerpt ? `<span class="kx-snip">${markedExcerpt(x.excerpt)}</span>` : ""}</span></span></td><td class="c-kind">${esc(x.kind)}</td><td class="c-out">${out}</td><td class="c-writer">${esc(x.slot)}</td><td class="c-mod">${when(x.at, p.now)}</td><td class="c-size num">${x.file ? esc(sizeWords(x.file.bytes)) : ""}</td></tr>`;
}

const plural = (n: number, w: [string, string]) =>
  `${fmtInt(n)} ${n === 1 ? w[0].toLowerCase() : w[1]}`;

/** Where the open folder is, in words, for a search's count. */
const folderWords = (f: KbFolder) => (f.level === "knowledge_base" ? "the knowledge base" : f.path);

/** The open folder's contents: the filter row, the table, and the pages. */
export function contentsHtml(p: ExplorerPage): string {
  const q = p.query;
  const filtered = FACETS.some((f) => values(q, f).length);
  const folders = !p.search && !filtered && p.place.level !== "slot" ? p.list?.folders : undefined;
  let count = "";
  let rows = "";
  let empty = "";
  let matched = 0;
  let next: number | null = null;
  if (p.search) {
    matched = p.search.matched;
    next = p.search.next_offset;
    count = `${fmtInt(matched)} ${matched === 1 ? "result" : "results"} in ${folderWords(p.place)}`;
    rows = p.search.hits.map((h) => itemRow(h, p)).join("");
    empty = p.search.error ?? "No items match.";
  } else if (folders && p.list) {
    const child = LEVEL_WORD[CHILD_LEVEL[p.place.level]];
    count = `${plural(folders.length, child)} · ${plural(p.list.total, ["item", "items"])}`;
    rows = folders.map((f) => folderRow(f, p.now)).join("");
    empty = "Empty.";
  } else if (p.list) {
    matched = p.list.matched;
    next = p.list.next_offset;
    count = filtered
      ? `${fmtInt(matched)} of ${plural(p.list.total, ["item", "items"])}`
      : plural(p.list.total, ["item", "items"]);
    rows = p.list.items.map((x) => itemRow({ ...x, excerpt: "" }, p)).join("");
    empty = filtered ? "No items match the filters." : "Empty.";
  }
  const sortable = !p.search;
  const table = `<div class="kx-scroll"><table class="kx-table"><thead><tr>${head(p, "name", "c-name", sortable)}${head(p, "kind", "c-kind", sortable && !folders)}${head(p, "outcome", "c-out", sortable && !folders)}${head(p, "writer", "c-writer", sortable && !folders)}${head(p, "modified", "c-mod", sortable)}${head(p, "size", "c-size num", sortable && !folders)}</tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">${esc(empty)}</td></tr>`}</tbody></table>${folders ? "" : pager(p, matched, next)}</div>`;
  return `${filterRow(p, count)}${table}`;
}

/** The pages of a long list: where this one is, its size, and the pages before and after it. */
function pager(p: ExplorerPage, matched: number, next: number | null): string {
  const from = p.query.offset;
  const shown = (p.search?.hits.length ?? p.list?.items.length ?? 0) + from;
  if (!matched || (from === 0 && next === null)) return "";
  const prev = Math.max(0, from - p.pageSize);
  return `<div class="kx-pager"><span class="muted">${fmtInt(from + 1)}–${fmtInt(shown)} of ${fmtInt(matched)} · ${p.pageSize} a page</span>${from > 0 ? `<a href="${esc(explorerHref(p.place.path, { ...p.query, offset: prev }))}">‹ Previous</a>` : ""}${next !== null ? `<a href="${esc(explorerHref(p.place.path, { ...p.query, offset: next }))}">Next ›</a>` : ""}</div>`;
}

import { KB_READ_PAGE } from "../../../core/link/kb.ts";
import type { KbReadAnswer } from "../../kb/index.ts";
import { ago, esc, fmtInt, icon, infoLabel } from "../components/index.ts";
import { sizeWords } from "../exports.ts";
import { knowledgeHref } from "../urls.ts";
import { outcomeChip, TYPE_ICON } from "./explorer.ts";

/**
 * An item's reader in the knowledge explorer (goal 176): in the preview pane beside the table, or
 * full width on the item's own page, from the owner's read of it (kb_read). Its title, kind,
 * outcome, the mark of withdrawn evidence, its slot and writer, when it was written, its address
 * to copy, its versions to pick from, its file's facts with Download, its text, its links both ways
 * and which running runs' agents can read it. Everything an agent wrote is escaped, a file is only
 * ever downloaded, and a link goes only to another item's reader.
 */

export type ReaderItem = KbReadAnswer["item"];

/** Where the reader's links go: in the pane they keep the folder's view, on a page they don't. */
export interface ReaderLinks {
  /** "pane": beside the table, with Open full page and ×; "page": the item's own page. */
  mode: "pane" | "page";
  /** This item at a version (none: its newest). */
  version: (v: number | undefined) => string;
  /** Another item, by its address. */
  item: (address: string) => string;
  /** Where × goes: the folder without the pane. */
  close?: string | undefined;
}

/** How another item links to this one, said from this one's side. */
const BACK: Record<string, string> = {
  supports: "supported by",
  contradicts: "contradicted by",
  follows: "followed by",
};
const TONE: Record<string, string> = {
  supports: "ok",
  "supported by": "ok",
  contradicts: "bad",
  "contradicted by": "bad",
};
const VERSIONS_TIP =
  "Each version is kept. The writer adds a new version; no one changes or removes an old one.";
const READERS_TIP =
  "Each run at work now, and whether its agents find this item with kb_search and kb_read: from the run's scope, set when it started, and its campaign's grants.";

/** A file's type in words, where people know it by another name. */
const TYPE_WORDS: Record<string, string> = {
  "application/pdf": "PDF",
  "text/markdown": "Markdown",
  "text/plain": "Plain text",
  "text/html": "Web page",
  "text/csv": "CSV",
  "image/svg+xml": "SVG image",
};

/** The download of one version's file: its bytes, as an attachment. */
export const fileHref = (address: string, version: number) =>
  `/ui/kb/file?${new URLSearchParams({ address, version: String(version) })}`;

function fileCard(x: ReaderItem, f: NonNullable<ReaderItem["file"]>): string {
  const meta = [
    TYPE_WORDS[f.type] ?? f.type,
    sizeWords(f.bytes),
    f.searched ? "text searched" : "kept whole, its text not searched",
  ].join(" · ");
  const download = f.held
    ? `<a class="btn sm" href="${esc(fileHref(x.address, x.version))}" download>${icon.download}<span>Download</span></a>`
    : `<span class="muted small">Control does not hold the file yet: it comes when the rig sends it.</span>`;
  const text = x.text
    ? `<details class="kx-filetext"><summary class="btn sm">${icon.file}<span>Show text</span></summary><div class="kx-text mono">${esc(x.text)}</div></details>`
    : "";
  return `<div class="kx-file"><div class="kx-fhead"><span class="iconbox">${icon.doc}</span><div class="kx-fname"><b>${esc(f.name)}</b><span class="muted small">${esc(meta)}</span></div></div><dl class="kx-fmeta"><dt>SHA-256</dt><dd><code>${esc(f.sha256)}</code></dd><dt>From</dt><dd>${esc(f.from)}</dd></dl><div class="kx-fbtns">${download}${text}</div></div>`;
}

/** The version picker: Version n of m, the latest first; an older one says so. */
function versionsHtml(x: ReaderItem, links: ReaderLinks, now: number): string {
  const latest = x.history[0]?.version ?? x.version;
  const rows = x.history
    .map(
      (v) =>
        `<a class="kx-vopt${v.version === x.version ? " on" : ""}" href="${esc(links.version(v.version === latest ? undefined : v.version))}"${links.mode === "pane" ? " data-item" : ""}${v.version === x.version ? ` aria-current="true"` : ""}><span class="kx-vmark">${v.version === x.version ? icon.check : ""}</span><span><span>Version ${v.version}</span><span class="muted xs">${v.version === latest ? "latest, " : ""}${esc(ago(v.at, now))} ago</span></span></a>`,
    )
    .join("");
  const older =
    x.version !== latest
      ? `<span class="chip warn">older version</span><a class="kx-latest" href="${esc(links.version(undefined))}"${links.mode === "pane" ? " data-item" : ""}>Show the latest</a>`
      : "";
  return `<div class="kx-vers"><details class="kx-dd kx-ver"><summary class="kx-ddb">Version ${x.version} of ${x.versions}${icon.down}</summary><div class="menu-pop kx-pop" role="group" aria-label="Versions"><div class="kx-pophead">${infoLabel("Versions", VERSIONS_TIP)}</div>${rows}</div></details>${older}</div>`;
}

/** Links both ways: this item's own, then the items that link to it, each opening that item. */
function linksHtml(x: ReaderItem, links: ReaderLinks): string {
  const row = (rel: string, address: string, title: string | null) => {
    const body = `<span class="chip ${TONE[rel] ?? ""}">${esc(rel)}</span><span class="kx-ltext"><span class="kx-ltitle">${esc(title ?? "Not in the knowledge base")}</span><span class="kx-addr">${esc(address)}</span></span>`;
    return title === null
      ? `<span class="kx-link dim">${body}</span>`
      : `<a class="kx-link" href="${esc(links.item(address))}"${links.mode === "pane" ? " data-item" : ""}>${body}</a>`;
  };
  const all = [
    ...x.links.map((l) => row(l.rel, l.to, l.title)),
    ...x.linked_from.map((l) => row(BACK[l.rel] ?? l.rel, l.address, l.title)),
  ];
  return `<details class="kx-sec"><summary>${icon.chevron}<span>Links</span><span class="n">${all.length}</span></summary><div class="kx-links">${all.join("") || `<div class="muted small">No links</div>`}</div></details>`;
}

/** Which running runs' agents can read it, and why. */
function readersHtml(x: ReaderItem): string {
  const can = x.readers.filter((r) => r.can).length;
  const rows = x.readers
    .map(
      (r) =>
        `<div class="kx-reader" role="listitem"><span class="${r.can ? "ok" : "bad"}" role="img" aria-label="${r.can ? "can read" : "cannot read"}">${r.can ? icon.check : icon.x}</span><span class="mono">${esc(r.run)}</span><span class="muted">${esc(r.why)}</span></div>`,
    )
    .join("");
  return `<details class="kx-sec"><summary>${icon.chevron}<span>Who can read it</span><span class="n">${x.readers.length ? `${can} of ${x.readers.length} running ${x.readers.length === 1 ? "run" : "runs"}` : "no run running"}</span></summary><div class="kx-pophead">${infoLabel("Running runs", READERS_TIP)}</div>${rows ? `<div class="kx-readers" role="list">${rows}</div>` : `<div class="muted small">No run is running now.</div>`}</details>`;
}

/** The text a page at a time: on the item's page with its parts; in the pane, its first. */
function textHtml(x: ReaderItem, links: ReaderLinks): string {
  if (x.file || !x.text) return "";
  const here = links.version(x.history[0]?.version === x.version ? undefined : x.version);
  const sep = here.includes("?") ? "&" : "?";
  const parts =
    links.mode === "pane"
      ? x.next_offset !== null
        ? `<a href="${esc(knowledgeHref(x.address))}">Read the rest on its page ›</a>`
        : ""
      : [
          x.offset > 0
            ? `<a href="${esc(here)}${sep}offset=${Math.max(0, x.offset - KB_READ_PAGE)}">‹ Earlier text</a>`
            : "",
          x.next_offset !== null
            ? `<a href="${esc(here)}${sep}offset=${x.next_offset}">Read on ›</a>`
            : "",
          x.chars > KB_READ_PAGE
            ? `<span class="muted">${fmtInt(x.offset + 1)} to ${fmtInt(x.offset + x.text.length)} of ${fmtInt(x.chars)} characters</span>`
            : "",
        ].join("");
  return `<div class="kx-text">${esc(x.text)}</div>${parts ? `<div class="kx-pager">${parts}</div>` : ""}`;
}

/** The reader: in the pane, with its head; on the page, as its main part. */
export function readerHtml(x: ReaderItem, links: ReaderLinks, now: number): string {
  const withdrawn = x.withdrawn
    ? `<span class="chip warn tipped" tabindex="0" role="note" data-tip="${esc(x.withdrawn)}">${icon.warn}<span>Withdrawn</span><span class="kx-sr">: ${esc(x.withdrawn)}</span></span>`
    : "";
  const meta = `<div class="kx-meta"><span class="chip">${esc(x.kind)}</span>${x.outcome ? outcomeChip(x.outcome) : ""}${withdrawn}<span class="mono">${esc(x.slot)}</span><span aria-hidden="true">·</span><span>${esc(x.writer.words)}</span><span aria-hidden="true">·</span><span title="${esc(x.at)}">written ${esc(ago(x.at, now))} ago</span></div>`;
  const body = `<h2>${esc(x.title || x.address)}</h2>${meta}${x.result ? `<div class="small"><span class="muted">Result:</span> ${esc(x.result)}</div>` : ""}
<div class="kx-addrline"><code>${esc(x.address)}</code><button type="button" class="ghost sm" data-copy="${esc(x.address)}" aria-label="Copy the address">${icon.copy}<span>Copy</span></button></div>
${versionsHtml(x, links, now)}${x.file ? fileCard(x, x.file) : ""}${textHtml(x, links)}${linksHtml(x, links)}${readersHtml(x)}`;
  if (links.mode === "page")
    return `<div class="kx-scroll"><article class="kx-item">${body}</article></div>`;
  const id = x.address.split("/").slice(3).join("/");
  return `<aside class="kx-prev" id="kx-prev" aria-label="Preview" tabindex="-1"><div class="kx-phead">${TYPE_ICON[x.type]}<span class="mono kx-pid">${esc(id)}</span><a class="kx-full" href="${esc(knowledgeHref(x.address))}${x.history[0]?.version === x.version ? "" : `?version=${x.version}`}">${icon.file}<span>Open full page</span></a><a class="kx-x" href="${esc(links.close ?? knowledgeHref())}" data-pclose aria-label="Close the preview">${icon.x}</a></div><article class="kx-pbody">${body}</article></aside>`;
}

/** The pane when the item asked for is not there: why, and ×. */
export const readerMissing = (words: string, close: string) =>
  `<aside class="kx-prev" id="kx-prev" aria-label="Preview" tabindex="-1"><div class="kx-phead"><span class="kx-pid">Not found</span><a class="kx-x" href="${esc(close)}" data-pclose aria-label="Close the preview">${icon.x}</a></div><div class="kx-pbody"><div class="kx-none"><b>Not found.</b> ${esc(words)}</div></div></aside>`;

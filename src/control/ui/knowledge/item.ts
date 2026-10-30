import { KB_RECORDS, kbItemType } from "../../../core/kb.ts";
import { KB_READ_PAGE } from "../../../core/link/kb.ts";
import { ago, esc, fmtInt, icon } from "../components/index.ts";
import { sizeWords } from "../exports.ts";
import { knowledgeHref } from "../urls.ts";
import { outcomeChip } from "./explorer.ts";

/**
 * An item's own page in the knowledge explorer (goal 176), at its address, from the owner's read
 * of it (kb_read): its title, kind, outcome, slot, who wrote it and when, its address to copy, its
 * version, its file's facts, its text and its links. The text is the agent's, escaped; a link goes
 * only to another item's own page. Its versions, its file, the items that link to it and who can
 * read it come with the preview pane.
 */

/** One item as the owner's read gives it. */
export interface ExplorerItem {
  address: string;
  slot: string;
  kind: string;
  title: string;
  outcome: string | null;
  at: string;
  version: number;
  versions: number;
  file: { name: string; type: string; bytes: number; sha256: string } | null;
  text: string;
  offset: number;
  chars: number;
  next_offset: number | null;
  links: { rel: string; to: string }[];
  result: string | null;
}

/** Where an item is and who wrote it: its slot, and Thermite's code for the records slot. */
const slotWords = (slot: string) =>
  slot === KB_RECORDS
    ? `<span>${esc(slot)}</span><span aria-hidden="true">·</span><span>Thermite's code</span>`
    : `<span>${esc(slot)}</span>`;

/** An item's page: its facts, its text from `offset`, and its links. */
export function itemHtml(x: ExplorerItem, now: number): string {
  const type = kbItemType(x);
  const typeIcon = type === "file" ? icon.doc : type === "record" ? icon.record : icon.blurb;
  const here = knowledgeHref(x.address);
  const parts = [
    x.offset > 0
      ? `<a href="${esc(here)}?offset=${Math.max(0, x.offset - KB_READ_PAGE)}">‹ Earlier text</a>`
      : "",
    x.next_offset !== null ? `<a href="${esc(here)}?offset=${x.next_offset}">Read on ›</a>` : "",
  ].join("");
  const facts = [
    `<dt>Version</dt><dd>${x.version} of ${x.versions}</dd>`,
    x.result ? `<dt>Result</dt><dd>${esc(x.result)}</dd>` : "",
    x.file
      ? `<dt>File</dt><dd>${esc(x.file.name)} · ${esc(x.file.type)} · ${esc(sizeWords(x.file.bytes))}</dd><dt>SHA-256</dt><dd><code>${esc(x.file.sha256)}</code></dd>`
      : "",
    x.chars > KB_READ_PAGE
      ? `<dt>Text</dt><dd>${fmtInt(x.offset + 1)} to ${fmtInt(x.offset + x.text.length)} of ${fmtInt(x.chars)} characters</dd>`
      : "",
  ].join("");
  const links = x.links.length
    ? `<h3 class="kx-h3">Links</h3><ul class="kx-links">${x.links.map((l) => `<li><span class="chip">${esc(l.rel)}</span><a href="${esc(knowledgeHref(l.to))}"><code>${esc(l.to)}</code></a></li>`).join("")}</ul>`
    : "";
  return `<div class="kx-scroll"><article class="kx-item"><div class="kx-ihead">${typeIcon}<h2>${esc(x.title || x.address)}</h2></div>
<div class="kx-meta"><span class="chip">${esc(x.kind)}</span>${x.outcome ? outcomeChip(x.outcome) : ""}${slotWords(x.slot)}<span aria-hidden="true">·</span><span title="${esc(x.at)}">${esc(ago(x.at, now))} ago</span></div>
<div class="kx-addrline"><code>${esc(x.address)}</code><button type="button" class="ghost sm" data-copy="${esc(x.address)}" aria-label="Copy the address">${icon.copy}<span>Copy</span></button></div>
<dl class="facts kx-facts">${facts}</dl>
${x.text ? `<div class="kx-text">${esc(x.text)}</div>` : ""}${parts ? `<div class="kx-pager">${parts}</div>` : ""}
${links}</article></div>`;
}

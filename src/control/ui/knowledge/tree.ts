import type { KbFolder } from "../../kb/index.ts";
import { esc, fmtInt, icon } from "../components/index.ts";
import { knowledgeHref } from "../urls.ts";

/**
 * The knowledge explorer's tree of folders (goal 176): the collections, those of archived
 * campaigns greyed and tagged, then a collection's runs, a running one with a green dot and one
 * that started fresh tagged, then a run's slots. Each folder is a link to its address, with its
 * count of items; a collection or a run has a chevron that opens it in place. The folders of the
 * open folder's ancestors are drawn with the page; the page's script asks control for the others
 * when one is opened (GET /ui/kb/tree), and they come drawn by treeList.
 */

/** A folder's own line: its chevron, then its link with its tags and its count. */
function nodeRow(f: KbFolder, o: { open: boolean; current: boolean }): string {
  const tags = [
    f.archived ? `<span class="kx-tag">archived</span>` : "",
    f.running ? `<span class="dot ok" role="img" aria-label="running"></span>` : "",
    f.fresh ? `<span class="kx-tag">fresh</span>` : "",
  ].join("");
  const opens = f.level !== "slot";
  const chev = opens
    ? `<button type="button" class="kx-chev" data-tree="${esc(f.path)}" aria-expanded="${o.open}" aria-label="${o.open ? "Collapse" : "Expand"} ${esc(f.name)}">${icon.chevron}</button>`
    : `<span class="kx-chev" aria-hidden="true"></span>`;
  return `<div class="kx-row${o.current ? " on" : ""}">${chev}<a class="kx-node${f.archived ? " dim" : ""}" href="${esc(knowledgeHref(f.path))}"${o.current ? ` aria-current="page"` : ""}>${icon.folder}<span class="nm">${esc(f.name)}</span>${tags}<span class="n">${fmtInt(f.items)}</span></a></div>`;
}

/**
 * A list of folders, each with its own folders under it when `kids` has them (by path): those of
 * the open folder and its ancestors. `current` is the open folder's path. Empty: says so.
 */
export function treeList(
  folders: readonly KbFolder[],
  kids: ReadonlyMap<string, readonly KbFolder[]>,
  current: string,
): string {
  if (!folders.length) return `<ul class="kx-ul"><li class="kx-empty">Empty</li></ul>`;
  const depth = folders[0] ? folders[0].path.split("/").length - 1 : 0;
  return `<ul class="kx-ul" style="--d:${depth}">${folders
    .map((f) => {
      const under = kids.get(f.path);
      return `<li>${nodeRow(f, { open: under !== undefined, current: f.path === current })}${under ? treeList(under, kids, current) : ""}</li>`;
    })
    .join("")}</ul>`;
}

/** The tree: every collection, and the folders of the open folder's ancestors. */
export function treeHtml(
  collections: readonly KbFolder[],
  kids: ReadonlyMap<string, readonly KbFolder[]>,
  current: string,
): string {
  return `<nav class="kx-tree" id="kx-tree" aria-label="Folders"><div class="kx-treehead">Collections</div>${
    collections.length
      ? treeList(collections, kids, current)
      : `<div class="kx-empty">No collection yet: a campaign's is made with the campaign.</div>`
  }</nav>`;
}

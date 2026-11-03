import { esc, fmtInt, infoLabel } from "./index.ts";

/**
 * A list page's filters and pages (goal 181, from the owner's mockup): a drop-down of several
 * choices for each filter, a search box, the choices in force as chips that each take one away,
 * and the pages, newest first. The filters are a GET form, so the page's address holds them and a
 * link keeps them; the page's script sends the form as a choice changes (commands/client.ts), and
 * without it, Apply does.
 */

interface FilterChoice {
  value: string;
  label: string;
  /** How many rows have it; none: not counted. */
  n?: number | undefined;
}

export interface Filter {
  /** The query's name, once for each choice picked. */
  name: string;
  label: string;
  tip: string;
  choices: readonly FilterChoice[];
  picked: readonly string[];
}

/** One drop-down: its button with how many are picked, and a check box for each choice. */
function dropdown(f: Filter): string {
  const rows = f.choices
    .map(
      (c) =>
        `<label class="flt-opt${c.n === 0 ? " zero" : ""}"><input type="checkbox" name="${esc(f.name)}" value="${esc(c.value)}"${f.picked.includes(c.value) ? " checked" : ""}><span>${esc(c.label)}</span><span class="n">${c.n === undefined ? "" : fmtInt(c.n)}</span></label>`,
    )
    .join("");
  return `<details class="menu flt-dd" data-dd="${esc(f.name)}"><summary class="btn sm${f.picked.length ? " on" : ""}">${esc(f.label)}${f.picked.length ? `<span class="flt-n">${f.picked.length}</span>` : ""} ▾</summary><div class="menu-pop flt-pop" role="group" aria-label="Filter by ${esc(f.label.toLowerCase())}"><div class="flt-head">${infoLabel(f.label, f.tip)}</div>${rows || `<div class="muted small">None</div>`}</div></details>`;
}

/**
 * The filter row: each drop-down, the search box, Apply for a browser without the page's script,
 * then the choices in force as chips, each a link to the page without it, and Clear.
 */
export function filterForm(o: {
  action: string;
  filters: readonly Filter[];
  search?: { name: string; value: string; placeholder: string } | undefined;
  /** Other query values the form keeps, such as the page size. */
  keep?: Readonly<Record<string, string>> | undefined;
  /** The page's address with these choices: for the chips and Clear. */
  href: (picked: Readonly<Record<string, readonly string[]>>, search: string) => string;
}): string {
  const search = o.search?.value ?? "";
  const picked = Object.fromEntries(o.filters.map((f) => [f.name, f.picked]));
  const keep = Object.entries(o.keep ?? {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const chips = o.filters
    .flatMap((f) =>
      f.picked.map((v) => {
        const label = `${f.label}: ${f.choices.find((c) => c.value === v)?.label ?? v}`;
        const href = o.href({ ...picked, [f.name]: f.picked.filter((x) => x !== v) }, search);
        return `<a class="flt-chip" href="${esc(href)}" aria-label="Remove the filter ${esc(label)}">${esc(label)} ×</a>`;
      }),
    )
    .join("");
  const any = chips || search;
  const none = Object.fromEntries(o.filters.map((f) => [f.name, []]));
  return `<form class="flt" method="get" action="${esc(o.action)}" data-filters>${keep}${o.filters.map(dropdown).join("")}${o.search ? `<input class="flt-q" type="search" name="${esc(o.search.name)}" value="${esc(search)}" placeholder="${esc(o.search.placeholder)}" aria-label="${esc(o.search.placeholder)}">` : ""}<noscript><button class="btn sm">Apply</button></noscript>${chips}${any ? `<a class="flt-clear" href="${esc(o.href(none, ""))}">Clear</a>` : ""}</form>`;
}

/** The pages: where these rows are in all, and Newest, Newer and Older where there are more. */
export function pagerHtml(o: {
  from: number;
  to: number;
  total: number | null;
  newest: string | null;
  newer: string | null;
  older: string | null;
}): string {
  const where =
    o.total === null
      ? o.to
        ? `${fmtInt(o.from)}–${fmtInt(o.to)}`
        : ""
      : o.total
        ? `${fmtInt(o.from)}–${fmtInt(o.to)} of ${fmtInt(o.total)}`
        : "none";
  const link = (href: string | null, word: string) =>
    href
      ? `<a class="btn sm" href="${esc(href)}">${word}</a>`
      : `<span class="btn sm" aria-disabled="true">${word}</span>`;
  return `<div class="flt-pager"><span class="muted small">${where}</span><span class="flt-pages">${link(o.newest, "Newest")}${link(o.newer, "‹ Newer")}${link(o.older, "Older ›")}</span></div>`;
}

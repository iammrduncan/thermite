import { KB_REFUSED_PAGE, type KbStored } from "../../kb/index.ts";
import { ago, esc, fmtInt, infoLabel, kpi } from "../components/index.ts";
import { sizeWords } from "../exports.ts";
import { knowledgeHref } from "../urls.ts";

/**
 * The Knowledge page's What's stored (goal 176), a page of its own at KB_STORED_PAGE: four tiles,
 * then collapsible sections: the collections, the indexes, the largest files and the file types,
 * what waits on the bus, and the writes control refused. The same read as REST's
 * `GET /v1/kb/stored` (control/kb/stored.ts). Every name is escaped: campaigns, files and reasons
 * may hold agents' words.
 */

/** The page's address: under /ui/kb/, where no campaign's name can be. */
export const KB_STORED_PAGE = "/ui/kb/stored";

const n = (v: number) => fmtInt(v);
const bytes = (v: number) => sizeWords(v);
const when = (iso: string | null, now: number) =>
  iso
    ? `<span title="${esc(iso)}">${esc(ago(iso, now))} ago</span>`
    : `<span class="muted">never</span>`;

/** A collapsible section, open at first: its heading with its ⓘ and its count. */
function section(id: string, title: string, tip: string, count: string, body: string): string {
  return `<details class="kx-sec" id="${id}" open><summary><span class="kx-sech">${infoLabel(title, tip)}</span><span class="kx-secn">${esc(count)}</span></summary><div class="kx-secb">${body}</div></details>`;
}

/** A table: its headers, a "#" before a figure's header right-aligns that column. */
function table(head: string[], rows: string[][], foot?: string[]): string {
  const num = head.map((h) => h.startsWith("#"));
  const tr = (xs: string[], tag: "td" | "th") =>
    `<tr>${xs.map((x, i) => `<${tag}${num[i] ? ` class="num"` : ""}>${x}</${tag}>`).join("")}</tr>`;
  const body = rows.map((r) => tr(r, "td")).join("");
  return `<div class="kx-scroll"><table class="kx-table kx-stab"><thead>${tr(
    head.map((h) => esc(h.replace(/^#/, ""))),
    "th",
  )}</thead><tbody>${body || `<tr><td colspan="${head.length}" class="empty">None.</td></tr>`}</tbody>${foot ? `<tfoot>${tr(foot, "td")}</tfoot>` : ""}</table></div>`;
}

/** The page's main part. `page(offset)` is the address of a page of refused writes. */
export function storedHtml(s: KbStored, now: number, page: (offset: number) => string): string {
  const t = s.totals;
  const tiles = `<div class="kpis kx-tiles">${[
    kpi("Stored in all", esc(bytes(t.stored_bytes)), "files and text, every version"),
    kpi(
      "Items",
      esc(n(t.items)),
      `in ${esc(n(t.collections))} ${t.collections === 1 ? "collection" : "collections"}`,
    ),
    kpi("Files", esc(n(t.files)), esc(bytes(t.file_bytes))),
    kpi("Older versions", esc(n(t.older_versions)), "kept, never removed"),
  ].join("")}</div>`;
  const collections = section(
    "collections",
    "Collections",
    "Each campaign's collection: its runs, its items by type, its files' bytes, its older versions, all it stores (every version's text and its files), its last write, and the campaigns granted to read it.",
    n(s.collections.length),
    table(
      [
        "Collection",
        "#Runs",
        "#Records",
        "#Blurbs",
        "#Files",
        "#File bytes",
        "#Older versions",
        "#Stored",
        "Last write",
        "Read by",
      ],
      s.collections.map((c) => [
        `<a href="${esc(knowledgeHref(c.campaign))}">${esc(c.campaign)}</a>${c.archived ? ` <span class="kx-tag">archived</span>` : ""}`,
        n(c.runs),
        n(c.records),
        n(c.blurbs),
        n(c.files),
        esc(bytes(c.file_bytes)),
        n(c.older_versions),
        esc(bytes(c.stored_bytes)),
        when(c.updated_at, now),
        c.read_by.length ? c.read_by.map(esc).join(", ") : `<span class="muted">none</span>`,
      ]),
      [
        "<b>All</b>",
        n(t.runs),
        n(t.records),
        n(t.blurbs),
        n(t.files),
        esc(bytes(t.file_bytes)),
        n(t.older_versions),
        esc(bytes(t.stored_bytes)),
        when(t.updated_at, now),
        "",
      ],
    ),
  );
  const indexes = section(
    "indexes",
    "Indexes",
    "Words: the search by words, kept current as each item is stored. Meaning: search by meaning, which Thermite does not have yet.",
    "2",
    table(
      ["Index", "State", "#Items"],
      [
        ["Words", `<span class="chip ok">Current</span>`, n(s.indexes.words.items)],
        ["Meaning", `<span class="chip">Not installed</span>`, ""],
      ],
    ),
  );
  const files = section(
    "files",
    "Largest files",
    "The largest file items, by their newest version's file. Searched: its text is in the words index. Kept whole: only its bytes are kept.",
    n(s.largest_files.length),
    `${table(
      ["File", "Type", "#Size", "Item", "Text"],
      s.largest_files.map((f) => [
        esc(f.name),
        esc(f.type),
        esc(bytes(f.bytes)),
        `<a class="mono" href="${esc(knowledgeHref(f.address))}">${esc(f.address)}</a>`,
        f.searched ? "searched" : "kept whole",
      ]),
    )}${table(
      ["File type", "#Files", "#Size", "#Searched", "#Kept whole"],
      s.file_types.map((x) => [
        esc(x.type),
        n(x.files),
        esc(bytes(x.bytes)),
        n(x.searched),
        n(x.files - x.searched),
      ]),
    )}`,
  );
  const w = s.waiting;
  const bus =
    w.bus === "on"
      ? ""
      : `<span class="chip warn">${w.bus === "off" ? "Bus off" : "Bus away"}</span>${w.error ? ` <span class="muted small">${esc(w.error)}</span>` : ""}`;
  const waiting = section(
    "waiting",
    "Waiting on the bus",
    "What the message bus holds for control to store: the events after the place control applied through (writers' kb_item events among them) and the file chunks control has not taken yet; then the last of each stored.",
    w.events === null ? "" : n(w.events + (w.file_chunks ?? 0)),
    `${bus}${table(
      ["What", "Now"],
      [
        ["Events not applied yet", w.events === null ? "" : n(w.events)],
        ["File chunks not taken yet", w.file_chunks === null ? "" : n(w.file_chunks)],
        [
          "Last item stored",
          w.last_item
            ? `<a class="mono" href="${esc(knowledgeHref(w.last_item.address))}">${esc(w.last_item.address)}</a> v${w.last_item.version}, ${when(w.last_item.at, now)}`
            : `<span class="muted">none</span>`,
        ],
        [
          "Last file stored",
          w.last_file
            ? `<code>${esc(w.last_file.sha256.slice(0, 12))}</code> ${esc(bytes(w.last_file.bytes))}, ${when(w.last_file.at, now)}`
            : `<span class="muted">none</span>`,
        ],
      ],
    )}`,
  );
  const r = s.refused;
  const pager =
    r.total > r.rows.length
      ? `<div class="kx-pager"><span class="muted">${n(r.offset + 1)}–$n(r.offset + r.rows.length)of $n(r.total)</span>${r.offset > 0 ? `<a href="${esc(page(Math.max(0, r.offset - KB_REFUSED_PAGE)))}">‹ Newer</a>` : ""}${r.next_offset !== null ? `<a href="${esc(page(r.next_offset))}">Older ›</a>` : ""}</div>`
      : "";
  const refused = section(
    "refused",
    "Refused writes",
    "The items control did not store, newest first: when, the rig, the run, the writer's slot and why. A write that came again is counted on its row.",
    n(r.total),
    `${table(
      ["When", "Rig", "Run", "Slot", "Reason"],
      r.rows.map((x) => [
        when(x.at, now),
        esc(x.rig),
        esc(x.run),
        esc(x.slot),
        `${esc(x.why)}${x.count > 1 ? ` <span class="muted">×${n(x.count)}</span>` : ""}`,
      ]),
    )}${pager}`,
  );
  return `<div class="kx-stored"><div class="kx-bar"><nav class="kx-crumbs" aria-label="Folder path"><a href="${esc(knowledgeHref(""))}">Knowledge</a><span class="kx-sep" aria-hidden="true">›</span><a href="${KB_STORED_PAGE}" aria-current="page">What's stored</a></nav></div>${tiles}${collections}${indexes}${files}${waiting}${refused}</div>`;
}

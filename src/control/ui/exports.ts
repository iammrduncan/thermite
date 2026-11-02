import { sizeWords } from "../../core/words.ts";
import { EXPORT_WHERE, exportWords } from "../command-progress.ts";
import type { RigExport } from "../store/index.ts";
import { ago, esc, infoLabel } from "./components/index.ts";

/**
 * Export on a rig's or a run's page, and the Exports page (goal 103). Export asks the rig for an
 * export (export_now), of the run or full; the Exports page lists every export control keeps, for
 * every rig, newest first, and downloads a complete one as one .tar.gz.
 */

/** What the choice of export means, on the info icon of its label. */
export const EXPORT_CHOICE_TIP =
  "This run (on a run's page): the run alone, from its start: its events, attempts and notes, its research folder as it stands, with its paper when it has one, and the pages it fetched; no other run, and no ledger snapshot. Full: a snapshot of the ledger, which holds every event, claim, source, finding, report and note, with every run's research folder, finished or not, and each run's archive of the pages it fetched. A full export is larger and takes longer. A run's export at its end comes by itself.";

// An export's words are the domain's (command-progress.ts): the pages and the follow routes share
// them. Bytes in words are core's: the domain's answers say sizes the same way.
export { EXPORT_WHERE, exportWords, sizeWords };

/** Export's form: its export_now payload, this run's or the rig's full one, and its words. */
export function exportForm(f: Record<string, unknown>) {
  const run = f.full === "run" && typeof f.run === "string" && f.run ? f.run : undefined;
  const payload = run ? { run } : { full: true };
  return { payload, asked: exportWords(payload).asked };
}

/** A path under /ui for the Exports page, for one rig or for all. */
export const exportsHref = (rig?: string) =>
  `/ui/exports${rig ? `?rig=${encodeURIComponent(rig)}` : ""}`;

/** Where the dashboard downloads an export from. */
export const exportDownloadHref = (e: Pick<RigExport, "rig" | "name">) =>
  `/ui/exports/${encodeURIComponent(e.rig)}/${encodeURIComponent(e.name)}/archive`;

/**
 * Export, in a page's header: a menu with the choice, each with its line, and the button that
 * sends export_now. On a run's page the first choice, and the one chosen, is the run alone; the
 * others are the rig's that holds it.
 */
export function exportMenu(o: {
  csrf: string;
  rig: string;
  back: string;
  /** A run's page: the run the rig holds. */
  run?: string | undefined;
}): string {
  const first = o.run ? "run" : "true";
  const choice = (value: string, title: string, line: string) =>
    `<label class="ch"><input type="radio" name="full" value="${value}"${value === first ? " checked" : ""} style="margin:2px 8px 0 0"><span><b>${esc(title)}</b><span class="muted small">${esc(line)}</span></span></label>`;
  const what = o.run ? `Export ${o.run}, or ${o.rig}, the rig that holds it.` : `Export ${o.rig}.`;
  const rig = o.run ? ` (all of ${o.rig})` : "";
  return `<details class="menu"><summary class="btn">Export</summary><div class="menu-pop export-pop"><form method="post" action="/ui/commands" class="stack export-now"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(o.rig)}"><input type="hidden" name="kind" value="export_now"><input type="hidden" name="back" value="${esc(o.back)}">${o.run ? `<input type="hidden" name="run" value="${esc(o.run)}">` : ""}
<div class="small"><b>${esc(what)}</b> <span class="muted">The rig writes the export and sends it on. A rig without a results repository sends it to control: it shows on the <a href="${exportsHref(o.rig)}">Exports page</a>.</span></div>
<div>${infoLabel("What to export", EXPORT_CHOICE_TIP)}</div>
${o.run ? choice("run", "This run", "This run alone, from its start: its events, attempts and notes, its research folder as it stands, with its paper, and the pages it fetched. No other run.") : ""}
${choice("true", `Full export${rig}`, "Also a ledger snapshot (every event, claim, source, finding, report and note), every run's research folder, finished or not, and the pages each run fetched.")}
<button class="primary">Export</button></form></div></details>`;
}

/** The run a run's export holds (goal 103); null for the rig's exports. */
export const exportRun = (e: RigExport) =>
  typeof e.manifest.run === "string" ? e.manifest.run : null;

/** The events an export holds, as a range: those after `from` through `through`. */
const eventRange = (e: RigExport) =>
  exportRun(e)
    ? `the run's, through ${e.through_event}`
    : e.through_event > e.from_event
      ? `${e.from_event + 1}–${e.through_event}`
      : `none new (through ${e.through_event})`;

const when = (iso: string, now: number) =>
  `<span title="${esc(iso)}">${esc(iso.slice(0, 16).replace("T", " "))} UTC</span> <span class="muted small">${esc(ago(iso, now))} ago</span>`;

/** An export's value in the page's forms: its rig and its name, which neither holds a "/" in. */
const exportPick = (e: Pick<RigExport, "rig" | "name">) => `${e.rig}/${e.name}`;

/** The rig and the name of an export the page's forms name, or undefined for anything else. */
export function pickedExport(v: unknown): { rig: string; name: string } | undefined {
  if (typeof v !== "string") return undefined;
  const at = v.indexOf("/");
  return at > 0 && at < v.length - 1 ? { rig: v.slice(0, at), name: v.slice(at + 1) } : undefined;
}

/**
 * An export's kind, as the page shows it: a run's (at its end or asked for), full, or, made before
 * goal 180 took that kind away, what changed.
 */
function kindCell(e: RigExport): string {
  const run = exportRun(e);
  if (run)
    return `<span class="chip">run ${esc(run)}</span>${e.manifest.end === true ? ` <span class="muted small">at its end</span>` : ""}`;
  return e.full ? `<span class="chip ok">full</span>` : `<span class="muted">what changed</span>`;
}

/**
 * The confirmation of a delete, at the top of the Exports page (no browser dialog): each export
 * that goes, with its rig, name, kind and size, and that it can't be undone; or why the delete is
 * refused. Delete posts the list; Cancel goes back to the page as it was.
 */
function deleteCard(o: {
  csrf: string;
  back: string;
  found: RigExport[];
  gone: { rig: string; name: string }[];
  refused: string | undefined;
}): string {
  const cancel = `<a class="btn" href="${esc(o.back)}">Cancel</a>`;
  const notThere = o.gone.length
    ? `<div class="muted small">Not on control, so nothing to delete: ${esc(o.gone.map((g) => `${g.rig} · ${g.name}`).join(", "))}.</div>`
    : "";
  if (o.refused)
    return `<div class="card warn" id="xdelete" style="margin-bottom:12px"><div><b class="bad">These exports can't be deleted now.</b> ${esc(o.refused)}</div>${notThere}<div class="act" style="margin-top:8px">${cancel}</div></div>`;
  if (!o.found.length)
    return `<div class="card warn" id="xdelete" style="margin-bottom:12px"><div><b>Nothing to delete.</b> Tick one or more exports in the table, then press Delete.</div>${notThere}<div class="act" style="margin-top:8px">${cancel}</div></div>`;
  const n = o.found.length;
  const total = o.found.reduce((sum, e) => sum + e.bytes, 0);
  const rows = o.found
    .map(
      (e) =>
        `<tr data-delete="${esc(e.name)}" data-rig="${esc(e.rig)}"><td><b>${esc(e.rig)}</b></td><td><code>${esc(e.name)}</code></td><td>${kindCell(e)}${e.complete_at === null ? ` <span class="warn small">never finished arriving</span>` : ""}</td><td class="num nowrap">${esc(sizeWords(e.bytes))}</td></tr>`,
    )
    .join("");
  const hidden = o.found
    .map((e) => `<input type="hidden" name="export" value="${esc(exportPick(e))}">`)
    .join("");
  return `<div class="card warn" id="xdelete" style="margin-bottom:12px"><div><b>Delete ${n === 1 ? "this export" : `these ${n} exports`} from control?</b> <span class="muted">This can't be undone: control deletes ${n === 1 ? "its files and its record" : "their files and their records"}. A rig lets an export go once control holds it, so control's copy is the only one off the rig.</span></div>
<div style="overflow-x:auto"><table class="ktable" style="margin:8px 0"><thead><tr><th>Rig</th><th>Export</th><th>Kind</th><th class="num">Size</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="3"><b>In all</b></td><td class="num nowrap"><b>${esc(sizeWords(total))}</b></td></tr></tfoot></table></div>${notThere}
<form method="post" action="/ui/exports/delete" class="act" style="margin-top:8px"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="back" value="${esc(o.back)}">${hidden}<button class="danger">Delete ${n === 1 ? "1 export" : `${n} exports`}</button>${cancel}</form></div>`;
}

/**
 * The Exports page's body: a filter by rig (links, so it works without the script), then one row
 * for each export, newest first, with Download for a complete one, and a box to tick it for
 * Delete. Delete shows the confirmation at the top (`confirm`), with no browser dialog; an export
 * control is still receiving has no box.
 */
export function exportsBody(o: {
  exports: RigExport[];
  /** Every rig with an export, or known to control: the filter's links. */
  rigs: string[];
  rig: string | undefined;
  /** Control keeps exports (it has a folder for them). */
  kept: boolean;
  now: number;
  csrf: string;
  /** Whether control is still receiving an export: it can't be deleted yet. */
  receiving: (e: RigExport) => boolean;
  /** Delete was pressed: the exports ticked, those control has not, or why it refuses them. */
  confirm?:
    | { found: RigExport[]; gone: { rig: string; name: string }[]; refused: string | undefined }
    | undefined;
}): string {
  const intro = `<div class="muted small" style="margin-bottom:12px">A rig without a results repository sends each export to control: each run's export when the run ends, and each export you ask for with Export on a rig's or a run's page. A full export also holds a snapshot of the ledger, every run's research folder and the pages each run fetched; a run's export holds that run alone. Download gives one .tar.gz of an export: its manifest and every file at its path. Control never deletes an export by itself: tick the ones to delete, then press Delete.</div>`;
  const noFolder = o.kept
    ? ""
    : `<div class="card warn" style="margin-bottom:12px">Control keeps no exports: it has no folder for them, so rigs send none here.</div>`;
  const count = (rig?: string) => o.exports.filter((e) => !rig || e.rig === rig).length;
  const chip = (rig?: string) =>
    `<a class="fchip${(o.rig ?? "") === (rig ?? "") ? " on" : ""}" href="${exportsHref(rig)}">${esc(rig ?? "All rigs")} <span class="n">${count(rig)}</span></a>`;
  const chips = `<div class="ktools" id="xf">${[undefined, ...o.rigs].map(chip).join("")}</div>`;
  const shown = o.exports.filter((e) => !o.rig || e.rig === o.rig);
  const ticked = new Set((o.confirm?.found ?? []).map(exportPick));
  const box = (e: RigExport) =>
    o.receiving(e)
      ? `<input type="checkbox" disabled title="Still arriving: it can be deleted once complete" aria-label="${esc(`${e.rig} · ${e.name}: still arriving`)}">`
      : `<input type="checkbox" name="pick" value="${esc(exportPick(e))}"${ticked.has(exportPick(e)) ? " checked" : ""} aria-label="${esc(`Select ${e.rig} · ${e.name}`)}">`;
  const row = (e: RigExport) => {
    const complete = e.complete_at !== null;
    const files = Object.keys(e.files).length;
    return `<tr data-export="${esc(e.name)}" data-rig="${esc(e.rig)}"><td>${box(e)}</td><td><a href="/ui/rigs/${encodeURIComponent(e.rig)}"><b>${esc(e.rig)}</b></a></td><td><code>${esc(e.name)}</code></td><td>${kindCell(e)}</td><td class="nowrap">${when(e.created_at, o.now)}</td><td class="nowrap">${complete ? when(String(e.complete_at), o.now) : `<span class="warn">still arriving</span>`}</td><td class="num nowrap">${esc(eventRange(e))}</td><td class="num">${e.done.length === files ? files : `${e.done.length} of ${files}`}</td><td class="num nowrap">${esc(sizeWords(e.bytes))}</td><td>${complete && o.kept ? `<a class="btn sm" href="${exportDownloadHref(e)}" download>Download</a>` : `<span class="muted small">${complete ? "not kept" : "still arriving"}</span>`}</td></tr>`;
  };
  // Delete asks first: the same page, with the ticked exports to confirm at the top.
  const tools = `<div class="act" style="margin-bottom:8px"><button class="sm danger" name="delete" value="1">Delete</button><span class="muted small">Tick the exports to delete. Control asks you to confirm, and says what goes.</span></div>`;
  const table = shown.length
    ? `<form method="get" action="/ui/exports" id="xpick">${o.rig ? `<input type="hidden" name="rig" value="${esc(o.rig)}">` : ""}${tools}<div class="card flat" style="overflow-x:auto"><table class="ktable"><thead><tr><th><input type="checkbox" id="xall" aria-label="Select every export shown"></th><th>Rig</th><th>Export</th><th>${infoLabel("Kind", EXPORT_CHOICE_TIP)}</th><th>Made</th><th>${infoLabel("Complete", "When the last of its files reached control, each checked against the SHA-256 in its manifest. Still arriving: control has not all of its files yet, so it can't be downloaded or deleted.")}</th><th class="num">${infoLabel("Events", "The rig's ledger events the export holds: those after the last export, through this one.")}</th><th class="num">Files</th><th class="num">Size</th><th></th></tr></thead><tbody id="xrows">${shown.map(row).join("")}</tbody></table></div></form>`
    : `<div class="card"><div class="empty">${o.rig ? `No export from ${esc(o.rig)} on control.` : "No export on control yet."}</div></div>`;
  const confirm = o.confirm
    ? deleteCard({ csrf: o.csrf, back: exportsHref(o.rig), ...o.confirm })
    : "";
  return `${noFolder}${confirm}${intro}${o.rigs.length || o.rig ? chips : ""}${table}`;
}

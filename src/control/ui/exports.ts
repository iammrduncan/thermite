import { EXPORT_WHERE, exportWords } from "../command-progress.ts";
import type { RigExport } from "../store/index.ts";
import { ago, esc, infoLabel } from "./components/index.ts";

/**
 * Export on a rig's or a run's page, and the Exports page (goal 103). Export asks the rig for an
 * export (export_now), normal or full; the Exports page lists every export control keeps, for
 * every rig, newest first, and downloads a complete one as one .tar.gz.
 */

/** What the choice of export means, on the info icon of its label. */
export const EXPORT_CHOICE_TIP =
  "This run (on a run's page): the run alone, from its start: its events, attempts and notes, its research folder as it stands, with its paper when it has one, and the pages it fetched; no other run, and no ledger snapshot. What changed: what the rig recorded since its last export, with the research folders of the runs that finished since. Full: also a snapshot of the ledger, which holds every event, claim, source, finding, report and note, every run's research folder, finished or not, and each run's archive of the pages it fetched. A full export is larger and takes longer.";

// An export's words are the domain's (command-progress.ts): the pages and the follow routes share them.
export { EXPORT_WHERE, exportWords };

/** Export's form: its export_now payload, this run's or the rig's, full or not, and its words. */
export function exportForm(f: Record<string, unknown>) {
  const run = f.full === "run" && typeof f.run === "string" && f.run ? f.run : undefined;
  const payload = run ? { run } : { full: f.full === "true" };
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
  const first = o.run ? "run" : "false";
  const choice = (value: string, title: string, line: string) =>
    `<label class="ch"><input type="radio" name="full" value="${value}"${value === first ? " checked" : ""} style="margin:2px 8px 0 0"><span><b>${esc(title)}</b><span class="muted small">${esc(line)}</span></span></label>`;
  const what = o.run ? `Export ${o.run}, or ${o.rig}, the rig that holds it.` : `Export ${o.rig}.`;
  const rig = o.run ? ` (all of ${o.rig})` : "";
  return `<details class="menu"><summary class="btn">Export</summary><div class="menu-pop export-pop"><form method="post" action="/ui/commands" class="stack export-now"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(o.rig)}"><input type="hidden" name="kind" value="export_now"><input type="hidden" name="back" value="${esc(o.back)}">${o.run ? `<input type="hidden" name="run" value="${esc(o.run)}">` : ""}
<div class="small"><b>${esc(what)}</b> <span class="muted">The rig writes the export and sends it on. A rig without a results repository sends it to control: it shows on the <a href="${exportsHref(o.rig)}">Exports page</a>.</span></div>
<div>${infoLabel("What to export", EXPORT_CHOICE_TIP)}</div>
${o.run ? choice("run", "This run", "This run alone, from its start: its events, attempts and notes, its research folder as it stands, with its paper, and the pages it fetched. No other run.") : ""}
${choice("false", `What changed${rig}`, "Since the last export: new events, attempts, notes, and the research folders of runs that finished.")}
${choice("true", `Full export${rig}`, "Also a ledger snapshot (every event, claim, source, finding, report and note), every run's research folder, finished or not, and the pages each run fetched.")}
<button class="primary">Export</button></form></div></details>`;
}

/** Bytes as people read them: "812 B", "4.2 KiB", "38.0 MiB", "1.20 GiB". */
export function sizeWords(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  return `${(b / 1024 ** 3).toFixed(2)} GiB`;
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

/**
 * The Exports page's body: a filter by rig (links, so it works without the script), then one row
 * for each export, newest first, with Download for a complete one.
 */
export function exportsBody(o: {
  exports: RigExport[];
  /** Every rig with an export, or known to control: the filter's links. */
  rigs: string[];
  rig: string | undefined;
  /** Control keeps exports (it has a folder for them). */
  kept: boolean;
  now: number;
}): string {
  const intro = `<div class="muted small" style="margin-bottom:12px">A rig without a results repository sends each export to control. A full export also holds a snapshot of the ledger, every run's research folder and the pages each run fetched; a run's export holds that run alone. Download gives one .tar.gz of an export: its manifest and every file at its path. Ask for an export with Export on a rig's or a run's page.</div>`;
  const noFolder = o.kept
    ? ""
    : `<div class="card warn" style="margin-bottom:12px">Control keeps no exports: it has no folder for them, so rigs send none here.</div>`;
  const count = (rig?: string) => o.exports.filter((e) => !rig || e.rig === rig).length;
  const chip = (rig?: string) =>
    `<a class="fchip${(o.rig ?? "") === (rig ?? "") ? " on" : ""}" href="${exportsHref(rig)}">${esc(rig ?? "All rigs")} <span class="n">${count(rig)}</span></a>`;
  const chips = `<div class="ktools" id="xf">${[undefined, ...o.rigs].map(chip).join("")}</div>`;
  const shown = o.exports.filter((e) => !o.rig || e.rig === o.rig);
  const row = (e: RigExport) => {
    const complete = e.complete_at !== null;
    const files = Object.keys(e.files).length;
    return `<tr data-export="${esc(e.name)}" data-rig="${esc(e.rig)}"><td><a href="/ui/rigs/${encodeURIComponent(e.rig)}"><b>${esc(e.rig)}</b></a></td><td><code>${esc(e.name)}</code></td><td>${exportRun(e) ? `<span class="chip">run ${esc(String(exportRun(e)))}</span>` : e.full ? `<span class="chip ok">full</span>` : `<span class="muted">what changed</span>`}</td><td class="nowrap">${when(e.created_at, o.now)}</td><td class="nowrap">${complete ? when(String(e.complete_at), o.now) : `<span class="warn">still arriving</span>`}</td><td class="num nowrap">${esc(eventRange(e))}</td><td class="num">${e.done.length === files ? files : `${e.done.length} of ${files}`}</td><td class="num nowrap">${esc(sizeWords(e.bytes))}</td><td>${complete && o.kept ? `<a class="btn sm" href="${exportDownloadHref(e)}" download>Download</a>` : `<span class="muted small">${complete ? "not kept" : "still arriving"}</span>`}</td></tr>`;
  };
  const table = shown.length
    ? `<div class="card flat" style="overflow-x:auto"><table class="ktable"><thead><tr><th>Rig</th><th>Export</th><th>${infoLabel("Kind", EXPORT_CHOICE_TIP)}</th><th>Made</th><th>${infoLabel("Complete", "When the last of its files reached control, each checked against the SHA-256 in its manifest. Still arriving: control has not all of its files yet, so it can't be downloaded.")}</th><th class="num">${infoLabel("Events", "The rig's ledger events the export holds: those after the last export, through this one.")}</th><th class="num">Files</th><th class="num">Size</th><th></th></tr></thead><tbody id="xrows">${shown.map(row).join("")}</tbody></table></div>`
    : `<div class="card"><div class="empty">${o.rig ? `No export from ${esc(o.rig)} on control.` : "No export on control yet."}</div></div>`;
  return `${noFolder}${intro}${o.rigs.length || o.rig ? chips : ""}${table}`;
}

// The size check (goal 125). CONVENTIONS.md: a file over 500 lines gets a cohesion review, and a
// file over 800 lines is normally split. The check keeps that from getting worse while the
// clean-up goes on: a file over 800 lines may not grow, and no file may newly pass 800 lines,
// unless the baseline records a reason for that file. The baseline holds the sizes the check
// started from; each split lowers them, and the check fails until the baseline is lowered too,
// so a file can't shrink and then grow back unseen.
//
// And it warns at 700 lines (goal 256): a file that passes 700 fails the check until the baseline
// lists it as one whose split is due. The limit stays 800, and a listed file may grow up to it:
// the list is what tells that a split is to be planned, before a feature has to squeeze the file
// under the limit. A listed file that is back at 700 lines or fewer comes off the list.

/** Lines from which a file gets a cohesion review. */
export const REVIEW_LINES = 500;
/** Lines from which a file's split is due: the check asks that the baseline lists it. */
export const WARN_LINES = 700;
/** Lines from which a file is normally split. */
export const SPLIT_LINES = 800;
/** The baseline, from the repository's root. */
export const BASELINE_PATH = "scripts/size-baseline.json";
/** The command that lowers the baseline after a split. */
export const LOWER_COMMAND = "npm run check:sizes -- --lower";
/** The command that lists the files newly over 700 lines as due a split. */
export const DUE_COMMAND = "npm run check:sizes -- --due";

/** The folders in scope: every handwritten file Thermite builds or runs. */
const SCOPE = ["src/", "tests/", "scripts/", "containers/", "kits/", "web/", "packages/"];
/** The files in scope: code and scripts. A kit's target code (C, CUDA) is the target's, not ours. */
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|py)$/;

export interface BaselineEntry {
  lines: number;
  /** Why this file may stay over 800 lines, and grow. */
  reason?: string;
}
export interface Baseline {
  files: Record<string, BaselineEntry>;
  /** The files over 700 lines and not over 800, whose split is due. */
  split_due?: string[];
}

export interface Finding {
  file: string;
  lines: number;
  /**
   * Over 800 lines: `grew`, `new`, or `stale` for a baseline entry above the file. Over 700:
   * `due` for a file the list of splits due does not name, and `not-due` for one it names that
   * is at 700 lines or fewer, gone, or over 800.
   */
  problem: "grew" | "new" | "stale" | "due" | "not-due";
  /** The baseline's size, where the file has one. */
  was?: number;
}

/** Whether a file of this size is one whose split is due: over 700 lines, and not over 800. */
const isDue = (lines: number): boolean => lines > WARN_LINES && lines <= SPLIT_LINES;

/**
 * Whether a path is in the size check's scope. A script without an extension (the containers'
 * wrappers and stand-ins) is in scope when it starts with a shebang.
 */
export function inScope(path: string, firstLine: () => string): boolean {
  if (!SCOPE.some((dir) => path.startsWith(dir))) return false;
  if (CODE.test(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !name.includes(".") && firstLine().startsWith("#!");
}

/** Lines in a text, as `wc -l` counts them when the text ends with a newline. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n").length;
  return text.endsWith("\n") ? parts - 1 : parts;
}

/** What breaks the rule, and baseline entries that are higher than the file now is. */
export function compare(sizes: ReadonlyMap<string, number>, baseline: Baseline): Finding[] {
  const out: Finding[] = [];
  for (const [file, lines] of sizes) {
    if (lines <= SPLIT_LINES) continue;
    const entry = baseline.files[file];
    if (!entry) out.push({ file, lines, problem: "new" });
    else if (!entry.reason && lines > entry.lines)
      out.push({ file, lines, problem: "grew", was: entry.lines });
  }
  for (const [file, entry] of Object.entries(baseline.files)) {
    const lines = sizes.get(file) ?? 0;
    const gone = lines <= SPLIT_LINES;
    if (gone || (!entry.reason && lines < entry.lines))
      out.push({ file, lines, problem: "stale", was: entry.lines });
  }
  const due = new Set(baseline.split_due ?? []);
  for (const [file, lines] of sizes)
    if (isDue(lines) && !due.has(file)) out.push({ file, lines, problem: "due" });
  for (const file of due) {
    const lines = sizes.get(file) ?? 0;
    if (!isDue(lines)) out.push({ file, lines, problem: "not-due" });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The files over 700 lines and not over 800 now, sorted: what the list of splits due holds. */
function dueNow(sizes: ReadonlyMap<string, number>): string[] {
  return [...sizes]
    .filter(([, lines]) => isDue(lines))
    .map(([file]) => file)
    .sort();
}

/**
 * The baseline with every file now over 700 lines listed as due a split: the files newly over
 * 700 are added, and none is taken off. Listing a file is the record that its split is planned.
 */
export function listDue(sizes: ReadonlyMap<string, number>, baseline: Baseline): Baseline {
  const due = new Set([...(baseline.split_due ?? []), ...dueNow(sizes)]);
  return { files: baseline.files, split_due: [...due].sort() };
}

/**
 * The baseline lowered to the sizes now: entries come down or go, never up, and no file is
 * added. A file with a reason keeps it and takes its size now while it stays over 800 lines.
 */
export function lower(sizes: ReadonlyMap<string, number>, baseline: Baseline): Baseline {
  const files: Record<string, BaselineEntry> = {};
  for (const [file, entry] of Object.entries(baseline.files)) {
    const lines = sizes.get(file) ?? 0;
    if (lines <= SPLIT_LINES) continue;
    files[file] = entry.reason
      ? { lines, reason: entry.reason }
      : { lines: Math.min(lines, entry.lines) };
  }
  const split_due = (baseline.split_due ?? []).filter((file) => isDue(sizes.get(file) ?? 0));
  return { files, split_due };
}

/** The first baseline: every file now over 800 lines, at its size now, and the splits due. */
export function start(sizes: ReadonlyMap<string, number>): Baseline {
  const files: Record<string, BaselineEntry> = {};
  for (const [file, lines] of [...sizes].sort(([a], [b]) => a.localeCompare(b)))
    if (lines > SPLIT_LINES) files[file] = { lines };
  return { files, split_due: dueNow(sizes) };
}

/** One finding in words, with what to do. */
export function findingText(f: Finding): string {
  if (f.problem === "new")
    return `${f.file}: ${f.lines} lines, a file newly over ${SPLIT_LINES}. Split it into a folder named for it (CONVENTIONS.md, "Files and their size"), or record a reason for it in ${BASELINE_PATH}.`;
  if (f.problem === "due")
    return `${f.file}: ${f.lines} lines, newly over ${WARN_LINES}. Its split is due before it reaches ${SPLIT_LINES}: split it now into a folder named for it (CONVENTIONS.md, "Files and their size"), or list it as due a split, ${DUE_COMMAND}, and plan the split. Don't trim it to stay under.`;
  if (f.problem === "not-due")
    return f.lines > SPLIT_LINES
      ? `${f.file}: ${f.lines} lines now, over ${SPLIT_LINES}; the list of splits due names it. Take it off the list: ${LOWER_COMMAND}`
      : `${f.file}: ${f.lines} lines now, no longer over ${WARN_LINES}; the list of splits due names it. Take it off the list: ${LOWER_COMMAND}`;
  if (f.problem === "grew")
    return `${f.file}: ${f.lines} lines, up from ${f.was}. A file over ${SPLIT_LINES} lines doesn't grow: add the new code as a module in the file's folder, or split the file first.`;
  return f.lines <= SPLIT_LINES
    ? `${f.file}: ${f.lines} lines now, no longer over ${SPLIT_LINES}; its baseline says ${f.was}. Lower the baseline: ${LOWER_COMMAND}`
    : `${f.file}: ${f.lines} lines now, below its baseline of ${f.was}. Lower the baseline: ${LOWER_COMMAND}`;
}

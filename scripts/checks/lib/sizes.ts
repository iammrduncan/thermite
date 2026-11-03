// The size check (goal 125). CONVENTIONS.md: a file over 500 lines gets a cohesion review, and a
// file over 800 lines is normally split. The check keeps that from getting worse while the
// clean-up goes on: a file over 800 lines may not grow, and no file may newly pass 800 lines,
// unless the baseline records a reason for that file. The baseline holds the sizes the check
// started from; each split lowers them, and the check fails until the baseline is lowered too,
// so a file can't shrink and then grow back unseen.

/** Lines from which a file gets a cohesion review. */
export const REVIEW_LINES = 500;
/** Lines from which a file is normally split. */
export const SPLIT_LINES = 800;
/** The baseline, from the repository's root. */
export const BASELINE_PATH = "scripts/size-baseline.json";
/** The command that lowers the baseline after a split. */
export const LOWER_COMMAND = "npm run check:sizes -- --lower";

/** The folders in scope: every handwritten file Thermite builds or runs. */
const SCOPE = ["src/", "tests/", "scripts/", "containers/", "kits/"];
/** The files in scope: code and scripts. A kit's target code (C, CUDA) is the target's, not ours. */
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs|sh|py)$/;

export interface BaselineEntry {
  lines: number;
  /** Why this file may stay over 800 lines, and grow. */
  reason?: string;
}
export interface Baseline {
  files: Record<string, BaselineEntry>;
}

export interface Finding {
  file: string;
  lines: number;
  problem: "grew" | "new" | "stale";
  /** The baseline's size, where the file has one. */
  was?: number;
}

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
  return out.sort((a, b) => a.file.localeCompare(b.file));
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
  return { files };
}

/** The first baseline: every file now over 800 lines, at its size now. */
export function start(sizes: ReadonlyMap<string, number>): Baseline {
  const files: Record<string, BaselineEntry> = {};
  for (const [file, lines] of [...sizes].sort(([a], [b]) => a.localeCompare(b)))
    if (lines > SPLIT_LINES) files[file] = { lines };
  return { files };
}

/** One finding in words, with what to do. */
export function findingText(f: Finding): string {
  if (f.problem === "new")
    return `${f.file}: ${f.lines} lines, a file newly over ${SPLIT_LINES}. Split it into a folder named for it (CONVENTIONS.md, "Files and their size"), or record a reason for it in ${BASELINE_PATH}.`;
  if (f.problem === "grew")
    return `${f.file}: ${f.lines} lines, up from ${f.was}. A file over ${SPLIT_LINES} lines doesn't grow: add the new code as a module in the file's folder, or split the file first.`;
  return f.lines <= SPLIT_LINES
    ? `${f.file}: ${f.lines} lines now, no longer over ${SPLIT_LINES}; its baseline says ${f.was}. Lower the baseline: ${LOWER_COMMAND}`
    : `${f.file}: ${f.lines} lines now, below its baseline of ${f.was}. Lower the baseline: ${LOWER_COMMAND}`;
}

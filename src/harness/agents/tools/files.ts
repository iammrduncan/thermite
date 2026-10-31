import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { moreText, READ_MAX, type ResearchFolderPaths } from "../../../agents/tools/index.ts";

/**
 * A Pi research worker's file tools over its research folder (OpenCode's agent uses its own shell
 * and file tools there). Paths are relative to the folder; nothing outside it is reachable, and
 * only the lane's working area takes writes. The folder's owners and modes say the same thing to
 * the operating system: these checks are the tools' own, not the boundary.
 */

/** A path inside the folder, symlinks resolved; an error in words when it is not. */
function inside(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const full = resolve(realRoot, path.replace(/^\/+/, ""));
  const real = existsSync(full) ? realpathSync(full) : full;
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new Error(`${path} is outside the research folder`);
  return real;
}

/** A path the lane may write: inside its working area, not a symlink, parents resolved. */
function writable(f: ResearchFolderPaths, path: string, allowLink = false): string {
  const realRoot = realpathSync(f.root);
  const realWork = realpathSync(f.work);
  const full = resolve(realRoot, path.replace(/^\/+/, ""));
  if (!full.startsWith(realWork + sep))
    throw new Error(
      `${path}: you can write only in your working area, ${relative(realRoot, realWork)}/`,
    );
  // No parent may lead out through a symlink.
  let parent = dirname(full);
  while (!existsSync(parent)) parent = dirname(parent);
  const realParent = realpathSync(parent);
  if (realParent !== realWork && !realParent.startsWith(realWork + sep))
    throw new Error(`${path} leads outside your working area`);
  if (!allowLink && existsSync(full) && lstatSync(full).isSymbolicLink())
    throw new Error(`${path} is a symlink: not written`);
  return full;
}

/**
 * The characters a page of a listing or a search holds, so that it fits a tool's answer
 * (OUTPUT_MAX) whole: a page that stops says so, with the skip that gives the next one (goal 117).
 */
const PAGE_CHARS = 11_000;

/**
 * One directory's entries, directories marked with a slash, files with their size: up to `limit`
 * from `skip`, and fewer when they would not fit a tool's answer; `next_skip` gives the rest.
 */
export function listFiles(f: ResearchFolderPaths, path = ".", skip = 0, limit = 500) {
  const dir = inside(f.root, path);
  const names = readdirSync(dir).sort();
  const from = Math.max(0, Math.trunc(skip) || 0);
  const entries: string[] = [];
  let size = 0;
  for (const name of names.slice(from, from + limit)) {
    const st = lstatSync(join(dir, name));
    const entry = st.isDirectory() ? `${name}/` : `${name} (${st.size} bytes)`;
    if (entries.length > 0 && size + entry.length + 3 > PAGE_CHARS) break;
    entries.push(entry);
    size += entry.length + 3;
  }
  const next = from + entries.length;
  const shown = relative(realpathSync(f.root), dir) || ".";
  return {
    path: shown,
    entries,
    ...(from ? { skip: from } : {}),
    ...(next < names.length
      ? {
          next_skip: next,
          more: `${names.length - next} more entries: list_files ${shown} with skip ${next}`,
        }
      : {}),
  };
}

/**
 * Part of a file's text, from an offset in characters: at most READ_MAX, so that the answer fits
 * a tool's answer whole, with `next_offset` and where to read on when more is left.
 */
export function readFile(f: ResearchFolderPaths, path: string, offset = 0, length = READ_MAX) {
  const file = inside(f.root, path);
  const text = readFileSync(file, "utf8");
  const from = Math.max(0, Math.min(text.length, Math.trunc(offset) || 0));
  const asked = Math.trunc(length) || READ_MAX;
  const part = text.slice(from, from + Math.max(1, Math.min(asked, READ_MAX)));
  return {
    path,
    chars: text.length,
    offset: from,
    text: part,
    ...moreText({ path }, from + part.length, text.length),
    ...(asked > READ_MAX ? { note: `a read gives at most ${READ_MAX} characters` } : {}),
  };
}

/**
 * Lines that contain the text (case-insensitive), or match it as a regular expression, in every
 * file under a path: file, line number and the line. Up to `limit` lines from `skip`, and fewer
 * when they would not fit a tool's answer; `next_skip` gives the next page.
 */
export function searchFiles(
  f: ResearchFolderPaths,
  text: string,
  opts: {
    path?: string | undefined;
    regex?: boolean | undefined;
    skip?: number | undefined;
    limit?: number;
  } = {},
) {
  const start = inside(f.root, opts.path ?? ".");
  const realRoot = realpathSync(f.root);
  const limit = opts.limit ?? 200;
  const from = Math.max(0, Math.trunc(opts.skip ?? 0) || 0);
  const match = opts.regex
    ? (() => {
        const re = new RegExp(text, "i");
        return (line: string) => re.test(line);
      })()
    : (() => {
        const needle = text.toLowerCase();
        return (line: string) => line.toLowerCase().includes(needle);
      })();
  const matches: string[] = [];
  let files = 0;
  let seen = 0;
  let size = 0;
  let full = false;
  const visit = (p: string): void => {
    if (full) return;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(p).sort();
      } catch {
        return; // another lane's working area, say
      }
      for (const n of names) visit(join(p, n));
      return;
    }
    if (!st.isFile()) return;
    let body: string;
    try {
      body = readFileSync(p, "utf8");
    } catch {
      return;
    }
    files++;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!match(line)) continue;
      if (seen++ < from) continue;
      const hit = `${relative(realRoot, p)}:${i + 1}: ${line.slice(0, 400)}${line.length > 400 ? ` … (the line goes on: ${line.length} characters; read_file shows it whole)` : ""}`;
      if (matches.length >= limit || (matches.length > 0 && size + hit.length + 3 > PAGE_CHARS)) {
        full = true;
        return;
      }
      matches.push(hit);
      size += hit.length + 3;
    }
  };
  visit(start);
  const next = from + matches.length;
  return {
    matches,
    files_searched: files,
    ...(from ? { skip: from } : {}),
    ...(full
      ? {
          next_skip: next,
          more: `more lines match: search_files again with skip ${next} for the next page`,
        }
      : {}),
  };
}

/** Writes (or appends to) a file in the lane's working area. */
export function writeFile(f: ResearchFolderPaths, path: string, content: string, append = false) {
  const file = writable(f, path);
  mkdirSync(dirname(file), { recursive: true });
  const before = append && existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, before + content);
  return { path: relative(realpathSync(f.root), file), bytes: Buffer.byteLength(before + content) };
}

/** Removes a file or directory in the lane's working area. */
export function removeFile(f: ResearchFolderPaths, path: string) {
  if (
    resolve(realpathSync(f.root), path.replace(/^\/+/, "")).replace(/\/+$/, "") ===
    realpathSync(f.work)
  )
    throw new Error("the working area itself stays");
  // A symlink itself may go: removing it never touches what it points to.
  const file = writable(f, path, true);
  rmSync(file, { recursive: true, force: true });
  return { removed: relative(realpathSync(f.root), file) };
}

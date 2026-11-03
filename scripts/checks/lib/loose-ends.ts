// Loose ends (CONVENTIONS.md, "Dead code and loose ends"): an export of production code that no
// other file names, and a path in a comment or a page that names no file. Today's are listed in
// scripts/loose-ends.json; the check fails on a new one, and on a listed one that is gone, until
// the list is lowered, so the list only shrinks.
//
// Both are read from the text, not from the compiler: an export is in use when another file names
// it (an index.ts that only passes it on does not count), and a path names a file when the file
// or folder is there, or the module with `.ts` added.

/** The exceptions, from the repository's root. */
export const EXCEPTIONS_PATH = "scripts/loose-ends.json";
/** The command that drops exceptions that are gone. */
export const LOWER_COMMAND = "npm run check:loose-ends -- --lower";

/** For each file, the exports and the paths it may keep for now. */
export interface Exceptions {
  exports: Record<string, string[]>;
  paths: Record<string, string[]>;
}

export interface Finding {
  kind: "export" | "path";
  file: string;
  /** The export's name, or the path as the file writes it. */
  name: string;
  /** For a path: its line. */
  line?: number;
  /** For an export: whether its own file uses it. */
  local?: boolean;
}

const PARTS = "core|common|agents|harness|supervisor|control|cli|release";
/** A path from the repository's root to Thermite's own files. */
const ROOTED = new RegExp(
  `(?<![\\w./@-])((?:src/(?:${PARTS})|tests|scripts|containers|docs|\\.github)(?:/[\\w.@-]+)+)`,
  "g",
);
/** A path in a link to Thermite's repository on GitHub. */
const LINKED = /github\.com\/iammrduncan\/thermite\/(?:blob|tree)\/[\w.-]+\/([\w.@/-]+)/g;
/** A path to a module from some folder above the file, in a comment: a folder, a slash, a file. */
const RELATIVE = /(?<![\w./@-])((?:[\w@-]+\/)+[\w@-]+\.(?:ts|mjs))(?![\w/])/g;
/** A path that goes on into a pattern or a placeholder names no one file. */
const PATTERN_NEXT = /^[*<{$]/;

/** The files whose comments are read for paths. */
export function codeFile(f: string): boolean {
  return (
    /^(?:src|tests|scripts|containers|kits|\.github)\/.*\.(?:ts|mts|mjs|js|cjs|sh|ya?ml|py)$/.test(
      f,
    ) || /(?:^|\/)Containerfile$/.test(f)
  );
}

/** The pages whose whole text is read for paths. History (the changelog, the plans) is not. */
export function pageFile(f: string): boolean {
  if (f === "CHANGELOG.md" || f === "docs/_site/src/content/docs/project/changelog.md")
    return false;
  return (
    /^[A-Z]+\.md$/.test(f) ||
    /^docs\/[^/]+\.md$/.test(f) ||
    /^docs\/_site\/src\/content\/docs\/.*\.mdx?$/.test(f)
  );
}

/** The files whose exports must be named elsewhere: production TypeScript. */
export function productionFile(f: string): boolean {
  return /^src\/.*\.ts$/.test(f);
}

/** `export { a } from "./a.ts"` and `export * from …`: they pass names on, and use none. */
const PASSED_ON =
  /(^|\n)\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s*["'][^"']+["'];?/g;

/** The names a file exports itself: its declarations, and `export { a, b as c }`. */
export function exportsOf(text: string): string[] {
  const names = new Set<string>();
  const declared =
    /(?:^|\n)export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(declared)) names.add(m[1] as string);
  for (const m of text
    .replace(PASSED_ON, "\n")
    .matchAll(/(?:^|\n)export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of (m[1] as string).split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  return [...names];
}

/** Every word a file names, apart from the names it only passes on. */
export function namesOf(text: string): Set<string> {
  return new Set(text.replace(PASSED_ON, "\n").match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/** The exports of production files that no other file names. */
export function unusedExports(files: readonly string[], read: (f: string) => string): Finding[] {
  const code = files.filter((f) => /\.(?:ts|mts|mjs|js|cjs)$/.test(f));
  const where = new Map<string, string[]>();
  for (const f of code)
    for (const n of namesOf(read(f))) {
      const list = where.get(n);
      if (list) list.push(f);
      else where.set(n, [f]);
    }
  const out: Finding[] = [];
  for (const file of code.filter(productionFile)) {
    const text = read(file).replace(PASSED_ON, "\n");
    for (const name of exportsOf(text)) {
      if ((where.get(name) ?? []).some((g) => g !== file)) continue;
      const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      out.push({ kind: "export", file, name, local: (text.match(word) ?? []).length > 1 });
    }
  }
  return out;
}

/** The text of a code file's comments, line by line (the rest blanked). */
export function commentsOf(file: string, text: string): string[] {
  const hash = /\.(?:sh|ya?ml|py)$|Containerfile$/.test(file);
  let inBlock = false;
  return text.split("\n").map((line) => {
    if (hash) {
      const at = line.indexOf("#");
      return at >= 0 ? line.slice(at) : "";
    }
    let out = "";
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf("*/");
      if (end < 0) return rest;
      out = rest.slice(0, end);
      rest = rest.slice(end + 2);
      inBlock = false;
    }
    const block = rest.indexOf("/*");
    const slashes = rest.search(/(?:^|\s)\/\//);
    if (slashes >= 0 && (block < 0 || slashes < block)) return out + rest.slice(slashes);
    if (block < 0) return out;
    const end = rest.indexOf("*/", block + 2);
    if (end >= 0) return out + rest.slice(block, end);
    inBlock = true;
    return out + rest.slice(block);
  });
}

/** Whether a path from the root names a file or a folder, or a module with `.ts` added. */
function names(path: string, exists: (p: string) => boolean): boolean {
  const p = path.replace(/\.+$/, "").replace(/\/$/, "");
  return exists(p) || exists(`${p}.ts`);
}

/** The folders a relative path may start from: the root, src/, each part and each folder above the file. */
function startsOf(file: string): string[] {
  const out = ["", "src/", ...PARTS.split("|").map((p) => `src/${p}/`)];
  const parts = file.split("/").slice(0, -1);
  for (let i = parts.length; i > 0; i--) out.push(`${parts.slice(0, i).join("/")}/`);
  return out;
}

/** The paths in one file that name no file: in a page, anywhere; in code, in its comments. */
export function missingPathsIn(
  file: string,
  text: string,
  exists: (p: string) => boolean,
): Finding[] {
  const page = pageFile(file);
  const lines = page ? text.split("\n") : commentsOf(file, text);
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    const seen = new Set<string>();
    const add = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      out.push({ kind: "path", file, name, line: i + 1 });
    };
    for (const re of [ROOTED, LINKED]) {
      for (const m of line.matchAll(re)) {
        const path = m[1] as string;
        const next = line.slice((m.index ?? 0) + m[0].length);
        if (PATTERN_NEXT.test(next) || names(path, exists)) continue;
        add(path);
      }
    }
    if (page) return;
    for (const m of line.matchAll(RELATIVE)) {
      const path = m[1] as string;
      if (/^(?:src|tests|scripts|containers|docs|\.github|node_modules)\//.test(path)) continue;
      if (startsOf(file).some((s) => exists(s + path))) continue;
      add(path);
    }
  });
  return out;
}

/** Every path that names no file, in the files that are read for paths. */
export function missingPaths(
  files: readonly string[],
  read: (f: string) => string,
  exists: (p: string) => boolean,
): Finding[] {
  return files
    .filter((f) => codeFile(f) || pageFile(f))
    .flatMap((f) => missingPathsIn(f, read(f), exists));
}

const keyOf = (f: Finding) => `${f.kind} ${f.file} ${f.name}`;
const listed = (e: Exceptions) =>
  new Set([
    ...Object.entries(e.exports).flatMap(([file, ns]) => ns.map((n) => `export ${file} ${n}`)),
    ...Object.entries(e.paths).flatMap(([file, ps]) => ps.map((p) => `path ${file} ${p}`)),
  ]);

/** New findings, and listed exceptions that are gone. */
export function compare(
  found: readonly Finding[],
  exceptions: Exceptions,
): { added: Finding[]; gone: Finding[] } {
  const known = listed(exceptions);
  const now = new Set(found.map(keyOf));
  const added = found.filter((f) => !known.has(keyOf(f)));
  const gone = [...known]
    .filter((k) => !now.has(k))
    .map((k) => {
      const [kind, file = "", ...rest] = k.split(" ");
      return { kind: kind as Finding["kind"], file, name: rest.join(" ") };
    });
  return { added, gone };
}

/** The exceptions now: every finding, by kind and file, each name once. */
export function listOf(found: readonly Finding[]): Exceptions {
  const out: Exceptions = { exports: {}, paths: {} };
  for (const f of found) {
    const byFile = f.kind === "export" ? out.exports : out.paths;
    const names = byFile[f.file] ?? [];
    if (!names.includes(f.name)) names.push(f.name);
    byFile[f.file] = names;
  }
  return out;
}

/** The exceptions lowered: those that are gone are dropped, and none is added. */
export function lower(found: readonly Finding[], exceptions: Exceptions): Exceptions {
  const now = new Set(found.map(keyOf));
  const keep = (kind: Finding["kind"], byFile: Record<string, string[]>) => {
    const out: Record<string, string[]> = {};
    for (const [file, ns] of Object.entries(byFile)) {
      const kept = ns.filter((n) => now.has(`${kind} ${file} ${n}`));
      if (kept.length) out[file] = kept;
    }
    return out;
  };
  return { exports: keep("export", exceptions.exports), paths: keep("path", exceptions.paths) };
}

/** One kind's list, laid out as the formatter (Biome, 100 columns) lays it out at `pad`. */
function byFileText(byFile: Record<string, string[]>, pad: string): string {
  const rows = Object.entries(byFile);
  if (!rows.length) return "{}";
  const lines = rows.map(([file, names], i) => {
    const comma = i < rows.length - 1 ? "," : "";
    const one = `${pad}  ${JSON.stringify(file)}: [${names.map((n) => JSON.stringify(n)).join(", ")}]`;
    if (one.length + comma.length <= 100) return one + comma;
    const each = names.map((n) => `${pad}    ${JSON.stringify(n)}`).join(",\n");
    return `${pad}  ${JSON.stringify(file)}: [\n${each}\n${pad}  ]${comma}`;
  });
  return `{\n${lines.join("\n")}\n${pad}}`;
}

/** The list as JSON, laid out as the formatter lays it out, so --lower leaves the lint clean. */
export function exceptionsText(e: Exceptions): string {
  return `{\n  "exports": ${byFileText(e.exports, "  ")},\n  "paths": ${byFileText(e.paths, "  ")}\n}\n`;
}

/** One finding in words, with what to do. */
export function findingText(f: Finding): string {
  if (f.kind === "path")
    return `${f.file}:${f.line}: ${f.name} names no file. Write the path it has now, or drop it (CONVENTIONS.md, "Dead code and loose ends").`;
  return f.local
    ? `${f.file}: ${f.name} is exported, and only its own file uses it. Drop the export (CONVENTIONS.md, "Dead code and loose ends").`
    : `${f.file}: ${f.name} is exported, and nothing uses it. Remove it (CONVENTIONS.md, "Dead code and loose ends").`;
}

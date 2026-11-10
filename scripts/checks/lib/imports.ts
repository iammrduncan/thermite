// The import rule (CONVENTIONS.md, "The parts and how they import"). `core` holds contracts and
// does no I/O apart from node:crypto; `common` holds runtime tools; `agents` holds the agent
// runtimes the harness and the supervisor share. The parts (harness, supervisor, control, cli,
// release) import those three, never each other. Domain modules never import page code (a part's
// main.ts, which makes the part, may), and production code never imports tests or scripts.
// Today's exceptions are listed by file in scripts/import-exceptions.json; the check fails on a
// new one, and on a listed one that is gone, until the list is lowered, so the list only shrinks.
//
// And a folder that is a module is imported through its index.ts (CONVENTIONS.md, "Folders and
// names"): production code outside the folder imports its index.ts, never a file inside it. A
// module is every folder under a part but the namespaces below, and every folder with an
// index.ts. Nested modules are reached through the outermost one that does not hold the importer;
// inside a module, files import each other directly. The exceptions never excuse this rule.
//
// And the dashboard's app (`web/`) is a client of control's API alone (CONVENTIONS.md, "The
// dashboard"): of this repository it imports only contracts in `src/core/`, each contract it
// loads runs in a browser (no Node module, no package but zod), and production code never imports
// the app. The exceptions never excuse these rules either.

/** The exceptions, from the repository's root. */
export const EXCEPTIONS_PATH = "scripts/import-exceptions.json";
/** The command that drops exceptions whose import is gone. */
export const LOWER_COMMAND = "npm run check:imports -- --lower";

/** What every part may import, apart from itself. */
const SHARED: Record<string, readonly string[]> = {
  core: [],
  common: ["core"],
  agents: ["core", "common"],
};
const FOR_PARTS = ["core", "common", "agents"];

/** For each file, the imports it may keep for now, each removed when its code moves. */
export type Exceptions = Record<string, string[]>;

/**
 * Namespaces: folders whose files are each an entry or a contract of their own, imported one by
 * one, so they have no index.ts and the folder rule does not hold them. An entry that ends in
 * `/**` takes the folders below it too; one of those with an index.ts is a module all the same.
 */
export const NAMESPACES: readonly string[] = [
  // The command line's commands, which its main.ts starts.
  "src/cli/thermite",
  // One client for each API.
  "src/common/api",
  // Route sections, each registered by the dashboard's index.ts.
  "src/control/dashboard/**",
  // Pages, each used where it is shown.
  "src/control/ui/**",
  // One module for each API's routes.
  "src/core/api/**",
  // The events' kinds and bodies, and the message bus's contracts.
  "src/core/events",
  "src/core/link",
];

export type Rule =
  | "part"
  | "core-io"
  | "page"
  | "tests"
  | "folder"
  | "app-out"
  | "app-browser"
  | "app-in";
/** The rules no exception excuses. */
const NEVER_EXCUSED: readonly Rule[] = ["folder", "app-out", "app-browser", "app-in"];
export interface Broken {
  file: string;
  /** The file imported, from the repository's root, or a module name such as node:fs. */
  target: string;
  rule: Rule;
  /** For the folder rule: the index.ts to import instead. */
  index?: string;
  /** For a contract the app loads: the file of the app that reaches it. */
  via?: string;
}

/** The dashboard's app, from the repository's root. */
const APP = "web/";
/** Where the app's own code is, which its `@/` imports name. */
const APP_SOURCE = "web/src/";
/** The contracts, which the app's `@core/` imports name. */
const CONTRACTS = "src/core/";
/** The packages a contract the app loads may import: they run in a browser. */
const BROWSER_PACKAGES: readonly string[] = ["zod"];

/**
 * The file of the repository one of the app's imports names, from the repository's root: its
 * aliases (web/vite.config.ts) and relative paths. None for a package.
 */
export function appTarget(file: string, spec: string): string | null {
  if (spec.startsWith("@core/")) return CONTRACTS + spec.slice("@core/".length);
  if (spec.startsWith("@/")) return APP_SOURCE + spec.slice("@/".length);
  return spec.startsWith(".") ? resolve(file, spec) : null;
}

/**
 * The modules a TypeScript file imports: static imports and exports (types too, since they tie
 * the parts together as well), side-effect imports, and `import()` of a string.
 */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[\n;])\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

/** A path from the repository's root, for a relative import in `file`. */
export function resolve(file: string, spec: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The part a file is in (`src/<part>/…`), or none. */
export function partOf(path: string): string | null {
  const m = /^src\/([^/]+)\//.exec(path);
  return m?.[1] ?? null;
}

/** Page code: the dashboard's pages and the routes that serve them. */
export function isPage(path: string): boolean {
  return path.startsWith("src/control/ui/") || path.startsWith("src/control/dashboard/");
}

/** A part's main.ts: what makes the part (its composition root), the pages among the rest. */
export function isMain(path: string): boolean {
  return /^src\/[^/]+\/main\.ts$/.test(path);
}

/** Whether a folder (`src/…`, no slash at the end) is a namespace. */
export function isNamespace(folder: string): boolean {
  return NAMESPACES.some((n) =>
    n.endsWith("/**")
      ? folder === n.slice(0, -3) || folder.startsWith(n.slice(0, -2))
      : folder === n,
  );
}

/**
 * The outermost module that holds `target` but not `file`, or none: the folder whose index.ts
 * `file` must import. `indexed` is the folders that have an index.ts.
 */
export function moduleOf(
  file: string,
  target: string,
  indexed: ReadonlySet<string>,
): string | null {
  const part = /^src\/[^/]+/.exec(target)?.[0];
  if (!part) return null;
  let outer: string | null = null;
  for (let d = target.slice(0, target.lastIndexOf("/")); d.length > part.length; ) {
    if (file.startsWith(`${d}/`)) break;
    if (indexed.has(d) || !isNamespace(d)) outer = d;
    d = d.slice(0, d.lastIndexOf("/"));
  }
  return outer;
}

/**
 * The rule one import breaks, if it breaks one. Only production code (`src/`) is held to it.
 * `indexed` is the folders that have an index.ts. An import that breaks the part or page rule is
 * reported as that, so a listed exception keeps its rule.
 */
export function broken(
  file: string,
  spec: string,
  indexed: ReadonlySet<string> = new Set(),
): Broken | null {
  if (file.startsWith(APP)) {
    // The app: its own files, its packages, and of the repository the contracts alone.
    const target = appTarget(file, spec);
    return !target || target.startsWith(APP) || target.startsWith(CONTRACTS)
      ? null
      : { file, target, rule: "app-out" };
  }
  const from = partOf(file);
  if (!from) return null;
  if (!spec.startsWith(".")) {
    // A built-in module or a package. core does no I/O: of Node's modules, only node:crypto.
    const io = spec.startsWith("node:") && spec !== "node:crypto";
    return from === "core" && io ? { file, target: spec, rule: "core-io" } : null;
  }
  const target = resolve(file, spec);
  if (target.startsWith("tests/") || target.startsWith("scripts/"))
    return { file, target, rule: "tests" };
  if (target.startsWith(APP)) return { file, target, rule: "app-in" };
  const to = partOf(target);
  if (to && to !== from && !(SHARED[from] ?? FOR_PARTS).includes(to))
    return { file, target, rule: "part" };
  if (to === "control" && to === from && isPage(target) && !isPage(file) && !isMain(file))
    return { file, target, rule: "page" };
  const folder = to ? moduleOf(file, target, indexed) : null;
  if (!folder || target === `${folder}/index.ts`) return null;
  return { file, target, rule: "folder", index: `${folder}/index.ts` };
}

/** Every broken import in a set of files, read through `read`. */
export function scan(files: readonly string[], read: (file: string) => string): Broken[] {
  const indexed = new Set(
    files.filter((f) => f.endsWith("/index.ts")).map((f) => f.slice(0, -"/index.ts".length)),
  );
  const out: Broken[] = [];
  const have = new Set(files);
  /** The contracts the app loads, each with the file of the app that reaches it first. */
  const loaded = new Map<string, string>();
  for (const file of files) {
    if (!/\.(?:ts|mts|cts|tsx)$/.test(file)) continue;
    const seen = new Set<string>();
    for (const spec of importsOf(read(file))) {
      const b = broken(file, spec, indexed);
      if (b && !seen.has(b.target)) {
        seen.add(b.target);
        out.push(b);
      }
      const target = file.startsWith(APP) ? appTarget(file, spec) : null;
      if (target?.startsWith(CONTRACTS) && !loaded.has(target)) loaded.set(target, file);
    }
  }
  // Each contract the app loads, and each one those import in turn, must run in a browser.
  for (const [file, via] of loaded) {
    if (!have.has(file)) continue;
    for (const spec of new Set(importsOf(read(file)))) {
      if (spec.startsWith(".")) {
        const target = resolve(file, spec);
        if (target.startsWith(CONTRACTS) && !loaded.has(target)) loaded.set(target, via);
      } else if (!BROWSER_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`)))
        out.push({ file, target: spec, rule: "app-browser", via });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.target.localeCompare(b.target));
}

/** New broken imports, and listed exceptions that are gone. No list excuses the folder rule. */
export function compare(
  found: readonly Broken[],
  exceptions: Exceptions,
): { added: Broken[]; gone: { file: string; target: string }[] } {
  const listed = new Set(
    Object.entries(exceptions).flatMap(([file, ts]) => ts.map((t) => `${file} ${t}`)),
  );
  const now = new Set(found.map((b) => `${b.file} ${b.target}`));
  const added = found.filter(
    (b) => NEVER_EXCUSED.includes(b.rule) || !listed.has(`${b.file} ${b.target}`),
  );
  const gone = [...listed]
    .filter((k) => !now.has(k))
    .map((k) => {
      const [file = "", target = ""] = k.split(" ");
      return { file, target };
    });
  return { added, gone };
}

/** The exceptions now: what is broken, by file, sorted; never a rule's that nothing excuses. */
export function listOf(found: readonly Broken[]): Exceptions {
  const out: Exceptions = {};
  for (const b of found) {
    if (NEVER_EXCUSED.includes(b.rule)) continue;
    const targets = out[b.file] ?? [];
    targets.push(b.target);
    out[b.file] = targets;
  }
  return out;
}

/**
 * The list as JSON, laid out as the repository's formatter (Biome, 100 columns) lays it out, so
 * --start and --lower leave the lint clean: a file's list on one line when it fits.
 */
export function exceptionsJson(e: Exceptions): string {
  const rows = Object.entries(e).map(([file, targets]) => {
    const one = `  ${JSON.stringify(file)}: [${targets.map((t) => JSON.stringify(t)).join(", ")}]`;
    if (one.length + 1 <= 100) return one;
    return `  ${JSON.stringify(file)}: [\n${targets.map((t) => `    ${JSON.stringify(t)}`).join(",\n")}\n  ]`;
  });
  return rows.length ? `{\n${rows.join(",\n")}\n}\n` : "{}\n";
}

/** The exceptions lowered: those whose import is gone are dropped, and none is added. */
export function lower(found: readonly Broken[], exceptions: Exceptions): Exceptions {
  const now = new Set(found.map((b) => `${b.file} ${b.target}`));
  const out: Exceptions = {};
  for (const [file, ts] of Object.entries(exceptions)) {
    const kept = ts.filter((t) => now.has(`${file} ${t}`));
    if (kept.length) out[file] = kept;
  }
  return out;
}

const RULE_WORDS: Record<Rule, string> = {
  part: "a part imports another part. Move the shared code to core, common or agents, or to a shared folder named for what it is",
  "core-io":
    "core does no I/O apart from node:crypto. Do the I/O in common, and keep the contract in core",
  page: "a domain module imports page code. Move the shared word or rule out of control/ui/, or move the page code into it",
  tests: "production code imports tests or scripts",
  folder: "code outside a folder that is a module imports a file inside it",
  "app-out":
    "the dashboard's app imports code of this repository that is not a contract. The app is a client of control's API alone: of the repository it imports only src/core/ (as @core/…). Give the app what it needs through a route, with its contract in src/core/api/",
  "app-browser":
    "a contract the dashboard's app loads must run in a browser: it imports no Node module and no package but zod. Keep what needs it in a file the app does not load",
  "app-in":
    "production code imports the dashboard's app. Control serves the app's built files; it never imports its source",
};

/** One broken import in words, with what to do. */
export function brokenText(b: Broken): string {
  if (b.rule === "folder") {
    const folder = (b.index ?? "").slice(0, -"/index.ts".length);
    return `${b.file} imports ${b.target}: ${RULE_WORDS.folder}. Import the folder's interface, ${b.index}, instead, and export what this file needs there. If ${folder}/ has no index.ts, give it one. A folder whose files are each an entry or a contract of their own is a namespace instead: name it in NAMESPACES in scripts/checks/lib/imports.ts (CONVENTIONS.md, "Folders and names").`;
  }
  if (b.rule === "app-out" || b.rule === "app-browser" || b.rule === "app-in")
    return `${b.file} imports ${b.target}${b.via ? ` (the app loads it through ${b.via})` : ""}: ${RULE_WORDS[b.rule]} (CONVENTIONS.md, "The dashboard").`;
  return `${b.file} imports ${b.target}: ${RULE_WORDS[b.rule]} (CONVENTIONS.md, "The parts and how they import").`;
}

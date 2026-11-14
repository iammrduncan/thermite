#!/usr/bin/env node
// Runs the unit tests with a temporary directory of their own, removed when they finish, so test
// runs leave nothing behind. The directory is short (sockets in it must stay under the 104-byte
// path limit on macOS). A file ends when its tests end, even if a failed test left a server or a
// timer open, so it fails at once instead of hanging until CI's timeout.
//
// Test files run side by side, one for each CPU, except the judge's and the broker's: those time
// real processes (the judge's medians and throttling checks, the broker's deadlines), so they run
// after the others, one at a time, with the machine to themselves. CI runs the two parts as
// separate jobs, on separate machines, at the same time.
//
// Usage: node scripts/test.mjs [--part parallel|alone] [--store-waits turn] [--store postgres]
// [files or globs]; with
// no files, every tests/**/*.test.ts. THERMITE_TEST_JOBS sets how many files run side by side.
//
// --store-waits turn: every call of control's store takes a turn of the event loop, as a store on
// a server does (tests/helpers/store-turns.ts). Without it a call's answer is there at once, as
// SQLite gives it.
//
// --store postgres: every store a test opens is on PostgreSQL (tests/helpers/store-postgres.ts):
// PGlite inside the test's process, or the server THERMITE_TEST_POSTGRES_URL names. A test that
// reaches the SQLite database itself is left out. With no files, it runs the test files that
// open control's store, straight or through what they import. Without it the stores are on
// SQLite.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The files that run alone, one at a time. */
const ALONE = /^tests\/harness\/(judge|broker)\//;

const args = process.argv.slice(2);
const at = args.indexOf("--part");
const part = at >= 0 ? args.splice(at, 2)[1] : "all";
if (!["all", "parallel", "alone"].includes(part)) {
  console.error(`test.mjs: --part is parallel or alone, not ${part}`);
  process.exit(2);
}
const waitsAt = args.indexOf("--store-waits");
const storeWaits = waitsAt >= 0 ? args.splice(waitsAt, 2)[1] : "none";
if (!["none", "turn"].includes(storeWaits)) {
  console.error(`test.mjs: --store-waits is turn, not ${storeWaits}`);
  process.exit(2);
}
const storeAt = args.indexOf("--store");
const storeKind = storeAt >= 0 ? args.splice(storeAt, 2)[1] : "sqlite";
if (!["sqlite", "postgres"].includes(storeKind)) {
  console.error(`test.mjs: --store is sqlite or postgres, not ${storeKind}`);
  process.exit(2);
}

// Tests live in tests/, in folders that mirror src/. A test file left in src/ would never run.
const stray = readdirSync("src", { recursive: true }).filter((p) => String(p).endsWith(".test.ts"));
if (stray.length) {
  console.error(`test.mjs: test files go in tests/, not src/: ${stray.join(", ")}`);
  process.exit(2);
}
// Every test file, as a path from the repository's root.
const every = readdirSync("tests", { recursive: true })
  .map((p) => `tests/${String(p).split("\\").join("/")}`)
  .filter((p) => p.endsWith(".test.ts"))
  .sort();
// A glob as a regular expression: ** any folders, * any name within one.
const globRe = (g) =>
  new RegExp(
    `^${g
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\0/g, "(?:.*/)?")}$`,
  );
/**
 * The test files that open control's store, straight or through what they import: the files a
 * run on PostgreSQL is for. The others would run as they do on SQLite.
 */
function onControlStore(tests) {
  const STORE = "src/control/store/index.ts";
  /** Each file's own imports of this repository's files, read once. */
  const imports = new Map();
  const importsOf = (file) => {
    if (!imports.has(file)) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // A path that names no file imports nothing.
      }
      const found = [];
      for (const m of text.matchAll(/(?:from|import)\s+"(\.[^"]+)"/g))
        found.push(join(dirname(file), m[1]).split("\\").join("/"));
      imports.set(file, found);
    }
    return imports.get(file);
  };
  /** Whether a file reaches the store: undefined while it is being asked, for a circle. */
  const reaches = new Map();
  const reachesStore = (file) => {
    if (file === STORE) return true;
    if (reaches.has(file)) return reaches.get(file) === true;
    reaches.set(file, undefined);
    const yes = importsOf(file).some(reachesStore);
    reaches.set(file, yes);
    return yes;
  };
  return tests.filter(reachesStore);
}

const files = args.length
  ? args.flatMap((a) =>
      a.includes("*") ? every.filter((f) => globRe(a.replace(/^\.\//, "")).test(f)) : [a],
    )
  : storeKind === "postgres"
    ? onControlStore(every)
    : every;
for (const f of files)
  if (!existsSync(f)) {
    console.error(`test.mjs: no file ${f}`);
    process.exit(2);
  }

const jobs = Number(process.env.THERMITE_TEST_JOBS) || availableParallelism();
const groups = [
  {
    name: "side by side",
    files: part === "alone" ? [] : files.filter((f) => !ALONE.test(f)),
    jobs,
  },
  { name: "alone", files: part === "parallel" ? [] : files.filter((f) => ALONE.test(f)), jobs: 1 },
].filter((g) => g.files.length);
if (!groups.length) console.log(`test.mjs: no test files to run in part ${part}`);

const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tt-"));
let status = 0;
for (const g of groups) {
  if (groups.length > 1)
    console.log(
      `\n# ${g.files.length} test files ${g.name}${g.jobs > 1 ? `, ${g.jobs} at a time` : ""}\n`,
    );
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      ...(storeWaits === "turn" ? ["--import", "./tests/helpers/store-turns.ts"] : []),
      ...(storeKind === "postgres" ? ["--import", "./tests/helpers/store-postgres.ts"] : []),
      "--test",
      `--test-concurrency=${g.jobs}`,
      "--test-force-exit",
      ...g.files,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        ...(storeKind === "postgres" ? { THERMITE_TEST_STORE: "postgres" } : {}),
      },
    },
  );
  // Every group runs, so one run shows every failure.
  if (r.status !== 0) status = r.status ?? 1;
}
// Some tests leave read-only folders on purpose (the judge's builds): open them, then remove all.
const open = (p) => {
  try {
    chmodSync(p, 0o700);
    for (const n of readdirSync(p)) {
      const q = join(p, n);
      if (lstatSync(q).isDirectory()) open(q);
    }
  } catch {}
};
open(root);
rmSync(root, { recursive: true, force: true });
process.exit(status);

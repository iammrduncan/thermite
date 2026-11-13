import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * No file of control outside `src/control/store/` reaches SQLite for control's store (goal 267):
 * the rest of control calls the store through its interface. The import check holds that nothing
 * outside the folder imports a file inside it but `index.ts`; this holds what that check does not:
 * SQLite itself, and the way to the store behind the interface, which is the tests' alone.
 *
 * The backup program (`src/common/backup/`) is another process: it opens the store's file itself,
 * read only, to copy it. It is not control, and is not held here.
 */

const CONTROL = join(import.meta.dirname, "..", "..", "..", "src", "control");

/** What a file of control outside the store's folder may not name, each with why. */
const REFUSED: [RegExp, string][] = [
  [/["']node:sqlite["']/, "SQLite itself"],
  [/common\/sqlite\.ts["']/, "the helper that opens a SQLite database"],
  [/\bDatabaseSync\b/, "a SQLite database"],
  [/\bsqliteBehind\b/, "the SQLite store behind the interface"],
  [/\bSqliteStore\b/, "the SQLite store's class"],
];

/** Where a file names what it may not, in words. */
function reaches(file: string, text: string): string[] {
  return REFUSED.flatMap(([re, what]) => (re.test(text) ? [`${file} names ${what}`] : []));
}

test("no file of control outside the store's folder reaches SQLite", () => {
  const files = (readdirSync(CONTROL, { recursive: true }) as string[]).filter(
    (f) => f.endsWith(".ts") && !f.split("\\").join("/").startsWith("store/"),
  );
  assert.ok(files.length > 200, "control's files were found");
  assert.deepEqual(
    files.flatMap((f) => reaches(`src/control/${f}`, readFileSync(join(CONTROL, f), "utf8"))),
    [],
    "Call the store through its interface (src/control/store/index.ts), and put SQL in the store's folder.",
  );
});

test("a file that reaches SQLite is found", () => {
  assert.deepEqual(reaches("a.ts", 'import type { ControlStore } from "./store/index.ts";'), []);
  assert.deepEqual(reaches("a.ts", 'import { DatabaseSync } from "node:sqlite";'), [
    "a.ts names SQLite itself",
    "a.ts names a SQLite database",
  ]);
  assert.deepEqual(reaches("a.ts", 'import { openDatabase } from "../common/sqlite.ts";'), [
    "a.ts names the helper that opens a SQLite database",
  ]);
  assert.deepEqual(reaches("a.ts", "const db = sqliteBehind(store).db;"), [
    "a.ts names the SQLite store behind the interface",
  ]);
});

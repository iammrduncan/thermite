import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

/**
 * Control's store hides its schema (goal 125, T6): each table has one owner, a sub-store under
 * `src/control/store/`, and no other production code in control reads the store's database,
 * prepares or runs a statement on it, or opens a database of its own.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONTROL = join(ROOT, "src", "control");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * A use of a database: the store's handle, a statement prepared or run on any handle, the SQLite
 * module, or the transaction helper. A regular expression's `.exec(` is not one.
 */
const QUERY =
  /\bstore\.db\b|\bdb\.(?:prepare|exec)\(|\.prepare\(|from "node:sqlite"|\/common\/sqlite\.ts"/;

describe("control's store's owners (goal 125, T6)", () => {
  test("no production code in control outside the store's modules uses its database", () => {
    const found = files(CONTROL)
      .map((path) => relative(ROOT, path))
      .filter((path) => !path.startsWith("src/control/store/"))
      .flatMap((path) =>
        readFileSync(join(ROOT, path), "utf8")
          .split("\n")
          .flatMap((line, i) => (QUERY.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
      );
    assert.deepEqual(
      found,
      [],
      "move the SQL into the sub-store in src/control/store/ that owns its table",
    );
  });

  test("the check finds a statement run outside the store", () => {
    for (const line of [
      'store.db.prepare("select 1").get();',
      "const r = this.o.store.db",
      '    .prepare("update command set signed = ? where id = ?")',
      'import type { DatabaseSync } from "node:sqlite";',
      'import { transaction } from "../common/sqlite.ts";',
      "  db.exec(SCHEMA);",
    ])
      assert.ok(QUERY.test(line), line);
    for (const line of [
      "const m = /^(\\d+)\\.patch$/.exec(name);",
      "await prepareResize(parts, rig, want);",
      'const store = new ControlStore(join(dir, "control.db"));',
      "store.rigEvents.after(rig, 0, 100);",
    ])
      assert.ok(!QUERY.test(line), line);
  });
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sqliteBehind } from "../../../src/control/store/behind.ts";
import { openControlStore, STORE_VERSION } from "../../../src/control/store/index.ts";

/**
 * The store's version is written once (goal 254, item 1): STORE_VERSION, which is how many
 * migrations the store has. A test that holds a store to this code's version reads the constant,
 * so a new migration changes its own test and no other. Before, the number was written at 20
 * places in 5 test files, and each new migration changed all five.
 */

const TESTS = join(import.meta.dirname, "..", "..");

/**
 * The numbers a line compares the store's version with, or puts in its place: `version(db) ===
 * N`, `assert.equal(version(store.db), N)`, `assert.equal(v.v, N)`, a version put into
 * schema_migrations, and the words of the refusal of a newer store. A line of SQL that names
 * migrations by number ("where version >= 31", to make a store as an older version left it) is
 * not one: it names a migration, not this code's version.
 */
function versionsWritten(line: string): number[] {
  const found = [
    /\bversion\([^()]*\)\s*(?:,|[!=]==?)\s*(\d+)\b/g,
    /\bv\??\.v\s*(?:,|[!=]==?)\s*(\d+)\b/g,
    /schema_migrations\s*\(version\)\s*values\s*\((\d+)\)/g,
    /schema version (\d+)\b/g,
    /this code's (\d+)\b/g,
  ].flatMap((re) => [...line.matchAll(re)].map((m) => Number(m[1])));
  return found;
}

/** The lines of a test file that write this code's store version, or a later one, as a number. */
function breaches(text: string, version: number): { line: number; text: string }[] {
  return text
    .split("\n")
    .map((t, i) => ({ line: i + 1, text: t.trim() }))
    .filter((l) => versionsWritten(l.text).some((n) => n >= version));
}

describe("the store's version is written once", () => {
  test("a new store is at STORE_VERSION", async () => {
    const store = openControlStore(":memory:");
    const row = sqliteBehind(store)
      .db.prepare("select max(version) as v from schema_migrations")
      .get() as {
      v: number;
    };
    assert.equal(row.v, STORE_VERSION);
    await store.close();
  });

  test("the rule finds a version written as a number, and leaves a migration's own number", () => {
    const n = STORE_VERSION;
    const written = [
      `assert.equal(version(store.db), ${n});`,
      `!db.prepare("select 1").get() && version(db) === ${n};`,
      `assert.equal(v?.v, ${n});`,
      `assert.equal(v.v, ${n + 1});`,
      `store.db.prepare("insert into schema_migrations (version) values (${n + 1})").run();`,
      `/control store is at schema version ${n + 1}, newer than this code's ${n}: /,`,
    ];
    for (const line of written)
      assert.equal(breaches(line, n).length, 1, `a version as a number: ${line}`);
    const allowed = [
      "assert.equal(version(store.db), STORE_VERSION);",
      // An older version, which a store is put back to: a migration's own number.
      `assert.equal(version(old.db), ${n - 1});`,
      `old.db.exec("delete from schema_migrations where version >= ${n}");`,
      `assert.ok(use, "migration ${n} made the table");`,
      `const kept = rows.slice(0, ${n});`,
    ];
    for (const line of allowed)
      assert.deepEqual(breaches(line, n), [], `not the store's version: ${line}`);
  });

  test("no test file writes the store's version as a number", () => {
    const files = (readdirSync(TESTS, { recursive: true }) as string[]).filter((f) =>
      /\.(?:ts|mjs)$/.test(f),
    );
    assert.ok(files.length > 100, "the test files were found");
    const found = files.flatMap((f) =>
      breaches(readFileSync(join(TESTS, f), "utf8"), STORE_VERSION).map(
        (b) => `tests/${f}:${b.line}: ${b.text}`,
      ),
    );
    assert.deepEqual(
      found,
      [],
      "Read STORE_VERSION (src/control/store/index.ts) where a test holds a store to this code's version, so the next migration changes no test but its own.",
    );
  });
});

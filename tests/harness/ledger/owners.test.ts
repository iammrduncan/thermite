import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

/**
 * The ledger hides its schema (goal 125, T6): each table has one owner module under
 * `src/harness/ledger/`, and no other production code queries the database. The schema and its
 * migrations make the tables; the selftest and the snapshot open the ledger's file themselves,
 * read only, from processes of their own.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HARNESS = join(ROOT, "src", "harness");
const OWN_FILE = new Set([
  "src/harness/schema/since-rename.ts",
  "src/harness/selftest/busy.ts",
  "src/harness/broker/snapshot/take.ts",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** A use of a database handle: the ledger's, or a query on any handle. */
const QUERY = /\bledger\.db\b(?=[.,)\s;])|\.db\.(?:prepare|exec)\(|\bdb\.prepare\(|\bdb\.exec\(/;

describe("the ledger's owners (goal 125, T6)", () => {
  test("no production code outside the ledger's modules queries its database", () => {
    const found = files(HARNESS)
      .map((path) => relative(ROOT, path))
      .filter((path) => !path.startsWith("src/harness/ledger/"))
      .filter((path) => !OWN_FILE.has(path))
      .flatMap((path) =>
        readFileSync(join(ROOT, path), "utf8")
          .split("\n")
          .flatMap((line, i) => (QUERY.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
      );
    assert.deepEqual(found, [], "query the table through its module in src/harness/ledger/");
  });
});

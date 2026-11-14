import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openSqliteStore } from "../../../src/control/store/index.ts";

/**
 * `thermite store copy` (goal 268): the command line starts control's own program for the copy,
 * which stops in words, before it reaches a database, on what it can't copy from or to. The copy
 * itself is tested where it is (tests/control/store/copy.test.ts).
 */

const CLI = join(import.meta.dirname, "..", "..", "..", "src", "cli", "thermite", "main.ts");

function thermite(args: string[], env: Record<string, string> = {}) {
  const { THERMITE_CONTROL_POSTGRES_URL: _url, THERMITE_CONTROL_DIR: _dir, ...clean } = process.env;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args],
    { encoding: "utf8", env: { ...clean, ...env } },
  );
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("thermite store copy", () => {
  test("stops in words on a folder with no store, and on a database's address that is not set or holds a password", async () => {
    const empty = mkdtempSync(join(tmpdir(), "thermite-store-"));
    const none = thermite(["store", "copy", "--state", empty]);
    assert.equal(none.status, 2);
    assert.equal(
      none.err,
      `${empty} holds no control.db: give control's state folder with --state\n`,
    );
    const store = openSqliteStore(join(empty, "control.db"));
    await store.close();
    const unset = thermite(["store", "copy"], { THERMITE_CONTROL_DIR: empty });
    assert.equal(unset.status, 2);
    assert.match(
      unset.err,
      /^THERMITE_CONTROL_POSTGRES_URL is not set: it takes the address of the store's PostgreSQL database, such as postgres:/,
    );
    const secret = thermite(["store", "copy", "--state", empty], {
      THERMITE_CONTROL_POSTGRES_URL: "postgres://thermite:hunter2@127.0.0.1:1/thermite",
    });
    assert.equal(secret.status, 2);
    assert.match(secret.err, /^THERMITE_CONTROL_POSTGRES_URL holds a password: take it out/);
    assert.ok(!secret.out.includes("hunter2"), "the password is never printed");
  });

  test("a database that does not answer fails the copy, with the SQLite store as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-store-"));
    const store = openSqliteStore(join(dir, "control.db"));
    await store.close();
    const password = join(dir, "password");
    writeFileSync(password, "not-used\n");
    const away = thermite(["store", "copy", "--state", dir], {
      // Nothing listens on port 1 of this computer.
      THERMITE_CONTROL_POSTGRES_URL: "postgres://thermite@127.0.0.1:1/thermite",
      THERMITE_CONTROL_POSTGRES_PASSWORD_FILE: password,
    });
    assert.equal(away.status, 1);
    assert.match(
      away.out,
      /^copying .*control\.db into postgres:\/\/thermite@127\.0\.0\.1:1\/thermite\n/,
    );
    assert.match(
      away.err,
      /^copy failed: .*ECONNREFUSED.*Nothing was kept: the database is as it was, and so is the SQLite store\n$/,
    );
  });

  test("any other word after store prints the usage", () => {
    const r = thermite(["store", "move"]);
    assert.equal(r.status, 2);
    assert.match(r.err, /store copy \[--state DIR\]/);
  });
});

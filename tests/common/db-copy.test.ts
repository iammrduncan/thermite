import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
  COPIES_KEPT,
  copiesOf,
  copyBeforeMigration,
  copyToRestore,
  newerSchemaWords,
} from "../../src/common/db-copy.ts";

function database(): { db: DatabaseSync; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-db-copy-")), "store.db");
  const db = new DatabaseSync(path);
  db.exec("create table t (v text); insert into t values ('kept')");
  return { db, path };
}
const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 5, minute));

describe("a copy before a migration", () => {
  test("is a whole copy beside the database, named for its version and time", () => {
    const { db, path } = database();
    const copy = copyBeforeMigration(db, path, 3, 4, at(1));
    assert.equal(copy, `${path}.v3.2026-10-27T05-01-00-000Z.copy`);
    const read = new DatabaseSync(copy, { readOnly: true });
    assert.deepEqual({ ...read.prepare("select v from t").get() }, { v: "kept" });
    read.close();
    db.close();
  });

  test(`keeps the ${COPIES_KEPT} newest copies of each database`, () => {
    const { db, path } = database();
    for (const minute of [1, 2, 3]) copyBeforeMigration(db, path, minute, minute + 1, at(minute));
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [3, 2],
    );
    db.close();
  });

  test("the copy to restore is the newest one the older code can read", () => {
    const { db, path } = database();
    copyBeforeMigration(db, path, 4, 5, at(1));
    copyBeforeMigration(db, path, 5, 6, at(2));
    assert.match(copyToRestore(path, 4) ?? "", /\.v4\..*\.copy$/);
    assert.match(copyToRestore(path, 5) ?? "", /\.v5\..*\.copy$/);
    assert.equal(copyToRestore(path, 3), undefined);
    assert.match(
      newerSchemaWords("ledger", path, 6, 5),
      /restore the ledger from before the upgrade \(the copy made then: .*\.v5\..*\.copy\)/,
    );
    db.close();
  });

  test("a database with no copies is refused in plain words", () => {
    const { db, path } = database();
    assert.equal(
      newerSchemaWords("control store", path, 2, 1),
      "this control store is at schema version 2, newer than this code's 1: run a newer Thermite, or restore the control store from before the upgrade",
    );
    db.close();
  });
});

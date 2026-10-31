import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDatabase, transaction } from "../../src/common/sqlite.ts";

const count = (db: ReturnType<typeof openDatabase>, table: string) =>
  Number(db.prepare(`select count(*) as n from ${table}`).get()?.n);

describe("Thermite's SQLite databases (goal 125, T6)", () => {
  test("a database opens in a new folder, in WAL, with a busy timeout and foreign keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-sqlite-")), "a", "b", "x.db");
    const db = openDatabase(path);
    assert.equal(db.prepare("pragma journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("pragma foreign_keys").get()?.foreign_keys, 1);
    assert.equal(db.prepare("pragma busy_timeout").get()?.timeout, 5000);
    db.close();
  });

  test("a transaction keeps all of its work or none; a nested one rolls back only its own", () => {
    const db = openDatabase(":memory:");
    db.exec("create table t (v text)");
    assert.throws(() =>
      transaction(db, () => {
        db.exec("insert into t values ('lost')");
        throw new Error("fails");
      }),
    );
    assert.equal(count(db, "t"), 0);
    transaction(db, () => {
      db.exec("insert into t values ('outer')");
      assert.throws(() =>
        transaction(db, () => {
          db.exec("insert into t values ('inner')");
          throw new Error("inner fails");
        }),
      );
      assert.equal(
        transaction(db, () => "nested"),
        "nested",
      );
    });
    assert.deepEqual(
      db
        .prepare("select v from t")
        .all()
        .map((r) => r.v),
      ["outer"],
    );
    db.close();
  });

  test("a commit that fails rolls back, and the next transaction is not nested in it", () => {
    const db = openDatabase(":memory:");
    db.exec(`create table p (id integer primary key);
      create table c (p integer references p(id) deferrable initially deferred)`);
    assert.throws(
      () => transaction(db, () => db.exec("insert into c values (7)")),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(db.isTransaction, false);
    transaction(db, () => db.exec("insert into p values (1)"));
    assert.equal(count(db, "p"), 1);
    assert.equal(count(db, "c"), 0);
    db.close();
  });
});

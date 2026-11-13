import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyControlLogLevel } from "../../../src/control/log-level.ts";
import { sqliteBehind } from "../../../src/control/store/behind.ts";
import { openControlStore } from "../../../src/control/store/index.ts";
import { keepOldRows } from "../../helpers/old-store.ts";

/**
 * A control that v0.1.0 ran, whose events table still holds its rows, opened by this version: the
 * drop of the events table waits for the move to the bus (store migration 12), and every other
 * migration runs at once, since control's start reads their tables before the move. On
 * 2026-11-02 a v0.1.1 control stopped at its first start on such a store: its log level read a
 * table the waiting migrations had not made yet.
 */

const V010 = readFileSync(
  join(import.meta.dirname, "..", "..", "helpers", "data", "control-v0.1.0.sql"),
  "utf8",
);

const tables = (db: DatabaseSync) =>
  new Set(
    (
      db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
    ).map((t) => t.name),
  );

test("a store v0.1.0 ran opens with every table control's start reads, its events table waiting for the move", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-upgrade-")), "control.db");
  const old = new DatabaseSync(path);
  old.exec(V010);
  keepOldRows(old, [{ rig: "rig-a", ledger: "l-1", id: 1, kind: "journal_note" }]);
  old.close();

  const store = openControlStore(path);
  // What control's start reads before the move, with no error.
  await assert.doesNotReject(async () => applyControlLogLevel(store));
  await store.auditLog.add("owner:test", "upgrade_checked", {});
  const have = tables(sqliteBehind(store).db);
  for (const t of [
    "control_setting",
    "event_floor",
    "retention_policy",
    "kb_item",
    "reachable_address",
  ])
    assert.ok(have.has(t), `the table ${t}`);
  // The events table and its migration wait for the move.
  assert.ok(have.has("rig_event"), "the events table stays until the move");
  assert.equal(
    sqliteBehind(store).db.prepare("select 1 from schema_migrations where version = 12").get(),
    undefined,
    "the drop waits",
  );
  await store.close();

  // A second start finds the same and migrates nothing more.
  const again = openControlStore(path);
  await assert.doesNotReject(async () => applyControlLogLevel(again));
  assert.ok(tables(sqliteBehind(again).db).has("rig_event"));
  await again.close();
});

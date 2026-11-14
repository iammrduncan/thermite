import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { PgConnection } from "../../../src/common/postgres.ts";
import { rowsBehind, tablesBehind, writeBehind } from "../../../src/control/store/behind.ts";
import {
  type ControlStore,
  CopyRefused,
  copyStore,
  LoadDiffers,
  openPostgresStore,
  openSqliteStore,
  STORE_VERSION,
} from "../../../src/control/store/index.ts";
import { EVENT_STREAM } from "../../../src/core/link/events.ts";
import { postgresConnection } from "../../helpers/postgres.ts";

/**
 * The copy of control's store from SQLite to PostgreSQL (goal 268, `thermite store copy`): every
 * table's rows on both sides, control's place in the stream carried as it is, the SQLite file as
 * it was, and nothing kept of a copy whose two sides differ.
 */

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A SQLite store at a path, with rows in every table a call can write, then closed. */
async function sqliteStore(): Promise<{ path: string; tables: string[] }> {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-copy-")), "control.db");
  const s = openSqliteStore(path);
  const now = "2026-11-14T10:00:00.000Z";
  await s.auditLog.add("owner:ui", "test", { a: 1 });
  await s.auditLog.refusal("rig:rig-a", "refused", { why: "no" });
  await s.ownSettings.set("log_level", "debug", "owner:ui");
  await s.enrollments.enroll("rig-a", "a".repeat(64), "owner:ui");
  await s.reportedRigs.addUnreported("rig-a", now);
  await s.busPositions.set(EVENT_STREAM, 4321);
  await s.folders.add("Speed", "owner:ui");
  await s.folders.place("gemv", 1);
  await s.archive.add("old-campaign", "owner:ui");
  await s.kb().makeCollection("gemv", now);
  await s.kb().grant("gemv", "sorting", "owner:ui");
  const RIG = { rig: "rig-a", ledger: "ledger-a" };
  const event = (kind: string, body: Record<string, unknown>, at: string) =>
    s.kb().index(RIG, { at, actor: "harness", kind, subject: "gs-1", body });
  await writeBehind(
    s,
    "insert into command (id, rig, kind, signed, issued_by, issued_at, status, run, campaign) values (?, ?, 'assign_campaign', ?, 'owner:ui', ?, 'delivered', ?, ?)",
    "cmd-1",
    "rig-a",
    JSON.stringify({ envelope: { payload: { run: "gs-1", contract: { campaign: "gemv" } } } }),
    now,
    "gs-1",
    "gemv",
  );
  await event("run_created", { campaign: "gemv", mode: "hill_climb" }, now);
  await event(
    "experiment_added",
    { id: "x-1", title: "Tile by 32", details: "Tiles.", by: "planner" },
    now,
  );
  await event(
    "journal_note",
    { id: 1, by: "lane-1", kind: "lesson", text: "Tiles help a lot." },
    now,
  );
  await s.kb().files.kept("f".repeat(64), 12, now);
  await s.championPatches.put(
    "rig-a",
    "ledger-a",
    "gs-1",
    1,
    { sha256: "c".repeat(64), base_commit: "abc" },
    Buffer.from([0, 1, 2, 255]),
  );
  await s.liveLines.add(
    "rig-a",
    "log-1",
    [{ seq: 1, at: now, source: "harness", kind: "log", text: "started" }],
    true,
  );
  await s.mcpServers.names();
  const tables = (await tablesBehind(s)).filter(
    (t) => !t.startsWith("kb_words") && t !== "schema_migrations",
  );
  await s.close();
  return { path, tables };
}

/** Every row of a table, in an order of its own, as text: the same on both stores for the same rows. */
async function rowsOf(store: ControlStore, table: string): Promise<string[]> {
  return (await rowsBehind(store, `select * from "${table}"`))
    .map((r) => {
      const { rowid: _order, ...row } = r;
      return JSON.stringify(
        Object.fromEntries(
          Object.entries(row)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v]),
        ),
      );
    })
    .sort();
}

describe("the copy of control's store from SQLite to PostgreSQL", () => {
  test("every table's rows are copied and counted on both sides; the SQLite file is as it was", async () => {
    const { path, tables } = await sqliteStore();
    const before = sha256(path);
    const conn = postgresConnection();
    const said: string[] = [];
    const report = await copyStore({ sqlite: path, conn, say: (l) => said.push(l) });
    assert.equal(sha256(path), before, "the SQLite file is unchanged");
    assert.deepEqual(report.tables.map((t) => t.table).sort(), [...tables].sort());
    for (const t of report.tables) assert.equal(t.postgres, t.sqlite, t.table);
    const held = report.tables.filter((t) => t.sqlite > 0).map((t) => t.table);
    for (const table of ["audit", "command", "kb_item", "kb_version", "rig_live", "rig_token"])
      assert.ok(held.includes(table), `${table} holds rows: ${held}`);
    assert.equal(said.filter((l) => /^copied \w+: \d+ rows$/.test(l)).length, tables.length);

    // The same rows, read from both stores.
    const sqlite = openSqliteStore(path);
    const postgres = openPostgresStore(conn, ":memory:");
    for (const table of tables) {
      const want = await rowsOf(sqlite, table);
      const got = await rowsOf(postgres, table);
      assert.deepEqual(got, want, table);
    }
    // The store works from there: a new row's key comes after the copied ones.
    const copied = await postgres.auditLog.newestId();
    await postgres.auditLog.add("owner:ui", "after the copy", {});
    assert.equal(await postgres.auditLog.newestId(), copied + 1);
    assert.equal(await postgres.folders.add("Size", "owner:ui"), 2);
    await sqlite.close();
    await postgres.close();
  });

  test("control goes on from the same event of the stream", async () => {
    const { path } = await sqliteStore();
    const conn = postgresConnection();
    const report = await copyStore({ sqlite: path, conn });
    assert.deepEqual(report.places, { [EVENT_STREAM]: 4321 });
    const postgres = openPostgresStore(conn, ":memory:");
    assert.equal(await postgres.busPositions.of(EVENT_STREAM), 4321);
    // The knowledge base's own place among its items is carried too: the next item is the next.
    const sqlite = openSqliteStore(path);
    const place = async (s: ControlStore) =>
      (await rowsBehind(s, "select seq, item_seq from kb_cursor"))[0];
    assert.deepEqual(await place(postgres), await place(sqlite));
    await sqlite.close();
    await postgres.close();
  });

  test("a difference between the two sides is reported and fails, and nothing of the copy is kept", async () => {
    const { path } = await sqliteStore();
    const real = postgresConnection();
    // A database that loses a row of the audit log as it is written.
    const lossy: PgConnection = {
      ...real,
      query: async (text, values) => {
        const r = await real.query(text, values);
        if (/^insert into "audit"/.test(text)) await real.query('delete from "audit" where id = 1');
        return r;
      },
    };
    await assert.rejects(copyStore({ sqlite: path, conn: lossy }), (err: unknown) => {
      assert.ok(err instanceof LoadDiffers);
      assert.match(err.message, /audit was given \d+ and holds \d+\. Nothing was kept/);
      const audit = err.tables.find((t) => t.table === "audit");
      assert.equal(audit?.loaded, (audit?.given ?? 0) - 1, "the row that was lost");
      assert.deepEqual(
        err.tables.filter((t) => t.given !== t.loaded).map((t) => t.table),
        ["audit"],
      );
      return true;
    });
    const { rows } = await real.query(
      "select count(*) as n from information_schema.tables where table_schema = current_schema()",
    );
    assert.equal(rows[0]?.n, 0, "the database is as it was: empty");
    // The same copy, on a database that keeps its rows, is whole.
    const report = await copyStore({ sqlite: path, conn: real });
    assert.ok(report.tables.every((t) => t.sqlite === t.postgres));
  });

  test("a database that holds a store, and a SQLite store of another version, are refused in words", async () => {
    const { path } = await sqliteStore();
    const conn = postgresConnection();
    await copyStore({ sqlite: path, conn });
    await assert.rejects(copyStore({ sqlite: path, conn }), (err: unknown) => {
      assert.ok(err instanceof CopyRefused);
      assert.match(
        err.message,
        /^the database holds \d+ tables already \(.*\): a store is loaded into an empty database, and never over one/,
      );
      return true;
    });
    const older = openSqliteStore(path);
    await writeBehind(older, "delete from schema_migrations where version = ?", STORE_VERSION);
    await older.close();
    const before = sha256(path);
    await assert.rejects(
      copyStore({ sqlite: path, conn: postgresConnection() }),
      (err: unknown) => {
        assert.ok(err instanceof CopyRefused);
        assert.match(
          err.message,
          new RegExp(
            `^the store is at schema version ${STORE_VERSION - 1}, and this Thermite copies a store at ${STORE_VERSION}: start this version's control on it once`,
          ),
        );
        return true;
      },
    );
    assert.equal(sha256(path), before);
    await assert.rejects(
      copyStore({ sqlite: join(tmpdir(), "no-such-folder", "control.db"), conn }),
      CopyRefused,
    );
  });
});

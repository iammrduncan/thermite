import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PgConnection } from "../../../../src/common/postgres.ts";
import { rowsBehind, tablesBehind, writeBehind } from "../../../../src/control/store/behind.ts";
import { openPostgresStore, openSqliteStore } from "../../../../src/control/store/index.ts";
import { POSTGRES_STORE_VERSION } from "../../../../src/control/store/postgres/schema/index.ts";
import { postgresConnection, postgresStore } from "../../../helpers/postgres.ts";

/**
 * Control's store on PostgreSQL (goal 268): its schema, its start, and what it says of itself.
 * What the store does behind its interface is tested by the tests of the interface, which run on
 * both stores (`node scripts/test.mjs --store postgres`).
 */

describe("the schema of the store on PostgreSQL", () => {
  test("has every table of the SQLite store but its words index, each with the same columns", async () => {
    const sqlite = openSqliteStore(":memory:");
    const postgres = postgresStore();
    // The MCP servers' tables are made at the first call on SQLite.
    await sqlite.mcpServers.names();
    await sqlite.kb().collections();
    await postgres.reportedRigs.list();
    const columns = async (store: typeof sqlite, sql: (table: string) => string) => {
      const out: Record<string, string[]> = {};
      for (const table of await tablesBehind(store))
        out[table] = (await rowsBehind(store, sql(table))).map((r) => String(r.name)).sort();
      return out;
    };
    const lite = await columns(sqlite, (t) => `select name from pragma_table_info('${t}')`);
    const pg = await columns(
      postgres,
      (t) =>
        `select column_name as name from information_schema.columns where table_schema = current_schema() and table_name = '${t}'`,
    );
    // The words index is goal 269's; its shadow tables are SQLite's own.
    const ordinary = Object.keys(lite).filter((t) => !t.startsWith("kb_words"));
    assert.deepEqual(Object.keys(pg).sort(), ordinary.sort());
    for (const table of ordinary) {
      // The order rows came in is a column on PostgreSQL where SQLite numbers its rows itself.
      const own = (pg[table] ?? []).filter((c) => c !== "rowid");
      assert.deepEqual(own, lite[table], table);
    }
    await sqlite.close();
    await postgres.close();
  });

  test("every text column compares and sorts by its bytes, whatever the server's order is", async () => {
    const store = postgresStore();
    await store.reportedRigs.list();
    const others = await rowsBehind(
      store,
      `select table_name, column_name from information_schema.columns
         where table_schema = current_schema() and data_type = 'text'
           and collation_name is distinct from 'C'`,
    );
    assert.deepEqual(others, []);
    // Capitals before small letters, as SQLite sorts: not as a language's order does.
    for (const name of ["b", "B", "a", "_", "Z"]) await store.ownSettings.set(name, "1", "test");
    const sorted = await rowsBehind(store, "select key from control_setting order by key");
    assert.deepEqual(
      sorted.map((r) => r.key),
      ["B", "Z", "_", "a", "b"],
    );
    await store.close();
  });

  test("is made once: a store opened again keeps its rows, at the same version", async () => {
    const path = "/a/store/of/this/test/control.db";
    const first = postgresStore(path);
    await first.ownSettings.set("kept", "1", "test");
    await first.close();
    const again = postgresStore(path);
    assert.equal((await again.ownSettings.get("kept"))?.value, "1");
    assert.deepEqual(
      (await rowsBehind(again, "select version from schema_migrations")).map((r) => r.version),
      Array.from({ length: POSTGRES_STORE_VERSION }, (_, i) => i + 1),
      "each migration ran once",
    );
    assert.equal(again.path, path, "its path is where its file would be: control's state folder");
    await again.close();
  });

  test("a store newer than this code is refused in words, at every call", async () => {
    const path = "/a/newer/store/control.db";
    const first = postgresStore(path);
    const newerVersion = POSTGRES_STORE_VERSION + 1;
    await writeBehind(first, "insert into schema_migrations (version) values (?)", newerVersion);
    await first.close();
    const newer = postgresStore(path);
    const words = new RegExp(
      `control's store on PostgreSQL is at schema version ${newerVersion}, newer than this code's ${POSTGRES_STORE_VERSION}: run a newer Thermite, or restore the store from a backup made before the upgrade`,
    );
    await assert.rejects(newer.reportedRigs.list(), words);
    await assert.rejects(newer.ownSettings.set("a", "1", "test"), words);
    await assert.rejects(
      newer.tx(async () => {}),
      words,
    );
  });
});

describe("the start of the store on PostgreSQL", () => {
  /** A connection whose server says it is PostgreSQL `major`, and fails every other statement. */
  const server = (major: number, statements: string[] = []): PgConnection => ({
    query: async (text) => {
      statements.push(text);
      if (/server_version_num/.test(text))
        return { rows: [{ n: String(major * 10_000 + 4) }], changed: 0 };
      throw new Error("no statement is expected");
    },
    exec: async (text) => {
      statements.push(text);
      throw new Error("no statement is expected");
    },
    hold: async () => {},
    release: () => {},
    close: async () => {},
  });

  test("a server older than PostgreSQL 16 is refused in words, and nothing is made on it", async () => {
    const statements: string[] = [];
    const store = openPostgresStore(server(15, statements), ":memory:");
    await assert.rejects(
      store.reportedRigs.list(),
      /control's store needs PostgreSQL 16 or newer, and this server is PostgreSQL 15/,
    );
    assert.equal(statements.length, 1, "only its version was asked");
  });

  test("a server that can't be reached is said in words", async () => {
    const away: PgConnection = {
      ...server(17),
      query: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const store = openPostgresStore(away, ":memory:");
    await assert.rejects(
      store.reportedRigs.list(),
      /control could not reach its store on PostgreSQL: connect ECONNREFUSED/,
    );
  });

  test("opening answers at once, and the first call brings the schema", async () => {
    const conn = postgresConnection();
    const store = openPostgresStore(conn, ":memory:");
    assert.deepEqual(await store.reportedRigs.list(), []);
    const { rows } = await conn.query("select count(*) as n from schema_migrations");
    assert.equal(rows[0]?.n, POSTGRES_STORE_VERSION);
    await store.close();
  });
});

describe("the size of the store on PostgreSQL", () => {
  test("its bytes and pages, the schema's version, each table's bytes and rows, each index's table", async () => {
    const store = postgresStore();
    await store.auditLog.add("owner", "test", { a: 1 });
    await store.auditLog.add("owner", "test", { a: 2 });
    const f = await store.size.measure();
    assert.ok(f.file_bytes > 0);
    assert.ok(f.page_size >= 4096);
    assert.equal(f.pages, Math.ceil(f.file_bytes / f.page_size));
    assert.equal(f.wal_bytes, 0, "the server's log is the server's, not this database's");
    assert.equal(f.schema_version, POSTGRES_STORE_VERSION);
    assert.ok(f.cache_bytes > 0);
    const audit = f.tables.find((t) => t.name === "audit");
    assert.equal(audit?.kind, "table");
    assert.equal(audit?.rows, 2);
    const index = f.tables.find((t) => t.name === "audit_repeat");
    assert.deepEqual([index?.kind, index?.of, index?.rows], ["index", "audit", null]);
    await store.close();
  });
});

import { existsSync, rmSync } from "node:fs";
import type { PgConnection, Sql } from "../../../common/postgres.ts";
import {
  columnsOf,
  type DumpTable,
  insertRows,
  keysPastRows,
  quoted,
  readDump,
  tablesOf,
} from "../../../common/postgres-dump.ts";
import { migratePostgres, POSTGRES_STORE_VERSION } from "./schema/index.ts";

/**
 * Rows loaded into an empty PostgreSQL database as control's store (goal 268): what a restore of
 * a backup does with the backup's dump, and what the copy from SQLite does with the SQLite
 * store's rows. The tables are made here, by the store's own migrations, at the schema version
 * the rows are of; then the rows go in, the keys that count up are brought past them, and the
 * rows of each table are counted against what was given. All of it is one transaction: a load
 * that fails, or whose counts differ, leaves the database as it was, empty.
 */

/** The table that counts the store's migrations: made by them, never loaded. */
const MIGRATIONS_TABLE = "schema_migrations";

/** One table of a load: how many rows were given, and how many the database holds after it. */
export interface LoadedTable {
  table: string;
  given: number;
  loaded: number;
}

/** A load whose counts differ: nothing of it was kept. */
export class LoadDiffers extends Error {
  readonly tables: LoadedTable[];
  constructor(tables: LoadedTable[]) {
    const differ = tables.filter((t) => t.given !== t.loaded);
    super(
      `the rows loaded are not the rows given: ${differ.map((t) => `${t.table} was given ${t.given} and holds ${t.loaded}`).join("; ")}. Nothing was kept: the database is as it was`,
    );
    this.tables = tables;
  }
}

/** What a database that is no place for a load holds, in words; undefined for an empty one. */
async function holdsAlready(conn: PgConnection): Promise<string | undefined> {
  const tables = await tablesOf(conn);
  if (!tables.length) return undefined;
  const shown = tables.slice(0, 5).join(", ");
  return `the database holds ${tables.length} tables already (${shown}${tables.length > 5 ? ", …" : ""})`;
}

/**
 * Loads a store's rows into the empty database `q` runs on. `schema` is the schema version the
 * rows are of; `each` gives every table to `take`, which reads its rows to their end. Each
 * table's counts. Throws, in words, on a database that holds tables already, on rows of a schema
 * newer than this code's, on a table or a column the schema has none of, and on counts that
 * differ (LoadDiffers).
 */
export async function loadStore(
  conn: PgConnection,
  q: Sql,
  schema: number,
  each: (take: (table: DumpTable) => Promise<void>) => Promise<void>,
): Promise<LoadedTable[]> {
  const holds = await holdsAlready(conn);
  if (holds)
    throw new Error(
      `${holds}: a store is loaded into an empty database, and never over one. Give an empty database; the one that is there is kept as it is`,
    );
  if (schema < 1 || schema > POSTGRES_STORE_VERSION)
    throw new Error(
      `the rows are of schema version ${schema}, and this code's store on PostgreSQL is at ${POSTGRES_STORE_VERSION}: load them with a Thermite of that version or newer`,
    );
  return q.tx(async () => {
    await migratePostgres(q, schema);
    const given = new Map<string, number>();
    await each(async (t) => {
      if (t.table === MIGRATIONS_TABLE) return;
      const has = await columnsOf(conn, t.table);
      if (!has.length)
        throw new Error(`the rows name a table, ${t.table}, that the store's schema has none of`);
      const unknown = t.columns.filter((c) => !has.includes(c));
      if (unknown.length)
        throw new Error(
          `the rows of ${t.table} name columns its table has none of: ${unknown.join(", ")}`,
        );
      // A row the migrations put there themselves, as the knowledge base's counters: the rows
      // given take its place.
      if (!given.has(t.table)) await q.run(`delete from ${quoted(t.table)}`);
      given.set(
        t.table,
        (given.get(t.table) ?? 0) + (await insertRows(q, t.table, t.columns, t.rows)),
      );
    });
    await keysPastRows(q);
    const out: LoadedTable[] = [];
    for (const table of await tablesOf(conn)) {
      if (table === MIGRATIONS_TABLE) continue;
      const n = await q.get(`select count(*) as n from ${quoted(table)}`);
      out.push({ table, given: given.get(table) ?? 0, loaded: Number(n?.n ?? 0) });
    }
    if (out.some((t) => t.given !== t.loaded)) throw new LoadDiffers(out);
    return out;
  });
}

/**
 * Loads the dump a restore left at `file`, when one is there, into the empty database, and
 * removes the file once its rows are kept: the backup still holds it. Each table's counts;
 * undefined when no dump waits. A database that holds a store is refused in words, with the dump
 * and the database both kept: which of the two is the store is the owner's to say.
 */
export async function loadWaitingDump(
  conn: PgConnection,
  q: Sql,
  file: string,
): Promise<LoadedTable[] | undefined> {
  if (!existsSync(file)) return undefined;
  const holds = await holdsAlready(conn);
  if (holds)
    throw new Error(
      `a restore's dump of control's store waits at ${file}, and ${holds}. A restore goes into an empty database. To restore: give control an empty database, and start it again. To keep the store that is there: move the dump away, and start control again. Nothing was changed`,
    );
  let loaded: LoadedTable[] = [];
  // The dump's first line names its schema, which the tables are made at before its rows go in.
  const { head } = await readDump(file, async () => {});
  loaded = await loadStore(conn, q, head.schema, async (take) => {
    await readDump(file, (_, table) => take(table));
  });
  rmSync(file);
  return loaded;
}

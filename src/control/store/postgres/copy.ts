import { DatabaseSync } from "node:sqlite";
import { sidecarsToOwner } from "../../../common/backup/index.ts";
import { type PgConnection, Sql } from "../../../common/postgres.ts";
import type { DumpTable, DumpValue } from "../../../common/postgres-dump.ts";
import { STORE_VERSION } from "../schema.ts";
import { type LoadedTable, loadStore } from "./load.ts";
import { POSTGRES_STORE_VERSION } from "./schema/index.ts";

/**
 * The copy of a control's store from SQLite to PostgreSQL (goal 268): `thermite store copy`. It
 * reads the SQLite file and writes the PostgreSQL database, never the other way: the file is
 * opened to read alone. Every ordinary table is copied with its rows in the order they came in,
 * so control's place in each of the bus's streams is carried as it is, and control goes on from
 * the same event. The knowledge base's words index is not copied: it is built again.
 *
 * It says what it did: each table's rows on both sides. A difference is a failure, and nothing
 * is kept of a copy that fails: the load is one transaction (load.ts).
 */

/** SQLite's own tables, the words index's, and the migrations' count: none is the store's rows. */
const NOT_COPIED = /^(sqlite_|kb_words|schema_migrations$)/;

/** What a copy did. */
interface CopyReport {
  /** Each table: its rows in the SQLite store, and in the PostgreSQL database after the copy. */
  tables: { table: string; sqlite: number; postgres: number }[];
  /** Control's place in each of the bus's streams, the same on both sides. */
  places: Record<string, number>;
}

/** A copy that was not made, with why in words. Nothing was written. */
export class CopyRefused extends Error {}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Copies the SQLite store at `sqlite` into the empty PostgreSQL database `conn` reaches. Throws
 * CopyRefused, in words, on a store that is not at this code's version or a database that holds
 * tables already, and LoadDiffers when the rows on the two sides differ.
 */
export async function copyStore(o: {
  /** The SQLite store's file: control.db in control's state folder. */
  sqlite: string;
  conn: PgConnection;
  /** Each step, in words, as it is done. */
  say?: ((line: string) => void) | undefined;
}): Promise<CopyReport> {
  const say = o.say ?? (() => {});
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(o.sqlite, { readOnly: true });
  } catch (err) {
    throw new CopyRefused(`${o.sqlite} could not be opened: ${String((err as Error).message)}`);
  }
  try {
    const has = (table: string) =>
      db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table) !==
      undefined;
    if (!has("schema_migrations"))
      throw new CopyRefused(`${o.sqlite} is not a control's store: it has no schema_migrations`);
    const version = Number(
      (db.prepare("select max(version) as v from schema_migrations").get() as { v: number | null })
        .v ?? 0,
    );
    if (version !== STORE_VERSION)
      throw new CopyRefused(
        `the store is at schema version ${version}, and this Thermite copies a store at ${STORE_VERSION}: start this version's control on it once, on SQLite, so that it brings the store to its version, then stop it and copy`,
      );
    // One reading of the whole store: what control writes meanwhile is not in the copy.
    db.exec("begin");
    const names = (
      db.prepare("select name from sqlite_master where type = 'table' order by name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((name) => !NOT_COPIED.test(name));
    const sqliteRows = new Map<string, number>();
    const tableOf = (table: string): DumpTable => {
      const columns = (
        db.prepare("select name from pragma_table_info(?)").all(table) as {
          name: string;
        }[]
      ).map((c) => c.name);
      // In the order the rows came in: a key that counts up, and the order PostgreSQL keeps for
      // the tables SQLite orders by its own row number, are then the same on both sides.
      const rows = db
        .prepare(`select * from ${quoted(table)} order by rowid`)
        .iterate() as Iterable<Record<string, DumpValue | bigint>>;
      async function* each(): AsyncIterable<DumpValue[]> {
        let n = 0;
        for (const r of rows) {
          n++;
          yield columns.map((c) => {
            const v = r[c] ?? null;
            return typeof v === "bigint" ? Number(v) : v;
          });
        }
        sqliteRows.set(table, n);
      }
      return { table, columns, rows: each() };
    };
    const q = new Sql(o.conn);
    let loaded: LoadedTable[];
    try {
      loaded = await loadStore(o.conn, q, POSTGRES_STORE_VERSION, async (take) => {
        for (const table of names) {
          await take(tableOf(table));
          say(`copied ${table}: ${sqliteRows.get(table) ?? 0} rows`);
        }
      });
    } catch (err) {
      if (err instanceof Error && /^the database holds \d+ tables already/.test(err.message))
        throw new CopyRefused(err.message);
      throw err;
    }
    const places = Object.fromEntries(
      (await q.all("select stream, seq from bus_position order by stream")).map((r) => [
        String(r.stream),
        Number(r.seq),
      ]),
    );
    return {
      tables: loaded.map((t) => ({
        table: t.table,
        sqlite: sqliteRows.get(t.table) ?? 0,
        postgres: t.loaded,
      })),
      places,
    };
  } finally {
    db.close();
    // Opening the file may make its `-wal` and `-shm` files: they go to the file's owner, so a
    // control that goes back to SQLite can still open its store.
    sidecarsToOwner(o.sqlite);
  }
}

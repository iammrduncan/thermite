import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import type { PgConnection, Sql } from "./postgres.ts";

/**
 * A dump of a store's tables as a file of lines (goal 268): what a backup of a control on
 * PostgreSQL holds, and what a restore loads. It is rows alone: the tables are made by the code
 * that owns the schema, at the schema version the dump names. Each line is JSON:
 *
 * - the first says what the file is, and the schema's version;
 * - each table has a line with its name and its columns, then one line for each row, the row's
 *   values in the columns' order, then a line with how many rows it had;
 * - the last says that the dump is whole. A file without it stopped part way.
 *
 * A value is a string, a number or null; bytes are `{"$bytes": "<base64>"}`.
 */

/** What the first line names the file as. */
const DUMP_OF = "thermite-store-rows";
/** The format's version. */
const DUMP_VERSION = 1;

/** A value of a row as a store gives it: text, a number, bytes or null. */
export type DumpValue = string | number | Uint8Array | null;

/** One table of a dump, as it is read: its name, its columns, and its rows as they come. */
export interface DumpTable {
  table: string;
  columns: string[];
  rows: AsyncIterable<DumpValue[]>;
}

/** What a dump says of itself before its tables. */
interface DumpHead {
  /** The schema version of the store the rows are of. */
  schema: number;
  /** What else its writer noted of the store. */
  notes: Record<string, unknown>;
}

const asLine = (v: DumpValue): unknown =>
  v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v;

const fromLine = (v: unknown): DumpValue => {
  if (v !== null && typeof v === "object") {
    const bytes = (v as { $bytes?: unknown }).$bytes;
    if (typeof bytes === "string") return Buffer.from(bytes, "base64");
    throw new Error("a value that is no text, number, bytes or null");
  }
  return v as DumpValue;
};

/**
 * Writes a dump to `file`: `head`, then each table `tables` gives, in order. How many rows each
 * table had. The file is whole only once this answers.
 */
async function writeDump(
  file: string,
  head: DumpHead,
  tables: AsyncIterable<DumpTable>,
): Promise<Record<string, number>> {
  const out = createWriteStream(file, { mode: 0o600 });
  const write = async (line: unknown) => {
    // A full buffer is waited for: a large table is never held in memory.
    if (!out.write(`${JSON.stringify(line)}\n`))
      await new Promise<void>((drained) => out.once("drain", drained));
  };
  const counts: Record<string, number> = {};
  try {
    await write({ of: DUMP_OF, v: DUMP_VERSION, schema: head.schema, notes: head.notes });
    for await (const t of tables) {
      await write({ table: t.table, columns: t.columns });
      let rows = 0;
      for await (const row of t.rows) {
        await write(row.map(asLine));
        rows++;
      }
      await write({ end: t.table, rows });
      counts[t.table] = rows;
    }
    await write({ whole: true, tables: counts });
  } finally {
    out.end();
    await finished(out);
  }
  return counts;
}

/**
 * Reads a dump: its head, then each table to `take`, which reads the table's rows to their end
 * before the next table is given. How many rows each table had, as the dump itself says. Throws,
 * in words, on a file that is no dump, on one of a newer format, and on one that stopped part way
 * or whose rows are not as many as it says.
 */
export async function readDump(
  file: string,
  take: (head: DumpHead, table: DumpTable) => Promise<void>,
): Promise<{ head: DumpHead; tables: Record<string, number> }> {
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const next = lines[Symbol.asyncIterator]();
  const read = async (): Promise<unknown> => {
    const line = await next.next();
    if (line.done) throw new Error(`${file} stopped part way: it is not a whole dump`);
    try {
      return JSON.parse(line.value);
    } catch {
      throw new Error(`${file} holds a line that is no JSON: it is not a dump of a store`);
    }
  };
  try {
    const first = (await read()) as {
      of?: unknown;
      v?: unknown;
      schema?: unknown;
      notes?: unknown;
    };
    if (first?.of !== DUMP_OF) throw new Error(`${file} is not a dump of a store's rows`);
    if (first.v !== DUMP_VERSION)
      throw new Error(
        `${file} is a dump of format ${String(first.v)}, and this Thermite reads format ${DUMP_VERSION}: use the Thermite that made it, or a newer one`,
      );
    const head: DumpHead = {
      schema: Number(first.schema),
      notes: (first.notes as Record<string, unknown>) ?? {},
    };
    for (;;) {
      const line = (await read()) as {
        table?: unknown;
        columns?: unknown;
        whole?: unknown;
        tables?: Record<string, number>;
      };
      if (line?.whole === true) return { head, tables: line.tables ?? {} };
      if (typeof line?.table !== "string" || !Array.isArray(line.columns))
        throw new Error(`${file} names no table where one is due: it is not a whole dump`);
      const table = line.table;
      let rows = 0;
      let ended = false;
      const each: AsyncIterable<DumpValue[]> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (ended) return { done: true, value: undefined };
            const row = await read();
            if (Array.isArray(row)) {
              rows++;
              return { done: false, value: row.map(fromLine) };
            }
            const end = row as { end?: unknown; rows?: unknown };
            if (end?.end !== table || end.rows !== rows)
              throw new Error(
                `${file}: ${table} has ${rows} rows where it says ${String(end?.rows)}: it is not a whole dump`,
              );
            ended = true;
            return { done: true, value: undefined };
          },
        }),
      };
      await take(head, { table, columns: line.columns.map(String), rows: each });
      // A taker that left rows unread still leaves the file at the next table.
      if (!ended) for await (const _ of each);
    }
  } finally {
    lines.close();
  }
}

/** A name as PostgreSQL takes it whatever its letters: in double quotes. */
export const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The ordinary tables of the schema a connection is in, by name. */
export async function tablesOf(conn: PgConnection): Promise<string[]> {
  const { rows } = await conn.query(
    `select table_name as name from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`,
  );
  return rows.map((r) => String(r.name));
}

/** A table's columns in their order. */
export async function columnsOf(conn: PgConnection, table: string): Promise<string[]> {
  const { rows } = await conn.query(
    `select column_name as name from information_schema.columns
       where table_schema = current_schema() and table_name = $1 order by ordinal_position`,
    [table],
  );
  return rows.map((r) => String(r.name));
}

/** How many rows a page of a table's read or write holds. */
const PAGE_ROWS = 500;

/**
 * The rows of a table, read a page at a time in the order of its key (the page before it ends
 * where the next begins), so that a large table is never held in memory. `keys` are the columns
 * of its primary key; a table with none is read whole.
 */
async function* rowsOf(
  conn: PgConnection,
  table: string,
  columns: readonly string[],
  keys: readonly string[],
): AsyncIterable<DumpValue[]> {
  const list = columns.map(quoted).join(", ");
  if (!keys.length) {
    const { rows } = await conn.query(`select ${list} from ${quoted(table)}`);
    for (const r of rows) yield columns.map((c) => r[c] as DumpValue);
    return;
  }
  const order = keys.map(quoted).join(", ");
  let after: unknown[] | undefined;
  for (;;) {
    const where = after
      ? `where (${order}) > (${after.map((_, i) => `$${i + 1}`).join(", ")})`
      : "";
    const { rows } = await conn.query(
      `select ${list} from ${quoted(table)} ${where} order by ${order} limit ${PAGE_ROWS}`,
      after ?? [],
    );
    for (const r of rows) yield columns.map((c) => r[c] as DumpValue);
    const last = rows.at(-1);
    if (!last || rows.length < PAGE_ROWS) return;
    after = keys.map((k) => last[k]);
  }
}

/**
 * Dumps every table of the schema `conn` is in to `file`, as the store stands at one moment,
 * while its owner writes to it: the tables are read in one transaction that sees the database as
 * it was when it began. `schema` reads the schema's version, and `notes` what else the dump
 * names, both inside that transaction. How many rows each table had.
 */
export async function dumpPostgres(
  conn: PgConnection,
  file: string,
  o: {
    schema: (conn: PgConnection) => Promise<number>;
    notes?: ((conn: PgConnection) => Promise<Record<string, unknown>>) | undefined;
  },
): Promise<{ head: DumpHead; tables: Record<string, number> }> {
  await conn.hold();
  try {
    await conn.exec("begin isolation level repeatable read read only");
    const head: DumpHead = { schema: await o.schema(conn), notes: (await o.notes?.(conn)) ?? {} };
    const names = await tablesOf(conn);
    const keys = await conn.query(
      `select tc.table_name as t, kcu.column_name as c
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
         where tc.table_schema = current_schema() and tc.constraint_type = 'PRIMARY KEY'
         order by tc.table_name, kcu.ordinal_position`,
    );
    const keysOf = (table: string) =>
      keys.rows.filter((k) => k.t === table).map((k) => String(k.c));
    async function* each(): AsyncIterable<DumpTable> {
      for (const table of names) {
        const columns = await columnsOf(conn, table);
        yield { table, columns, rows: rowsOf(conn, table, columns, keysOf(table)) };
      }
    }
    const tables = await writeDump(file, head, each());
    await conn.exec("commit");
    return { head, tables };
  } catch (err) {
    await conn.exec("rollback").catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Writes rows into a table, a page at a time, each row's values in `columns`' order. A column
 * that counts up by itself takes the value it is given. How many rows it wrote.
 */
export async function insertRows(
  q: Sql,
  table: string,
  columns: readonly string[],
  rows: AsyncIterable<DumpValue[]>,
): Promise<number> {
  const into = `insert into ${quoted(table)} (${columns.map(quoted).join(", ")}) overriding system value values `;
  const marks = `(${columns.map(() => "?").join(", ")})`;
  let written = 0;
  let page: DumpValue[][] = [];
  const flush = async () => {
    if (!page.length) return;
    await q.run(into + page.map(() => marks).join(", "), ...page.flat());
    written += page.length;
    page = [];
  };
  // A statement takes 65,535 values at most.
  const most = Math.max(1, Math.min(PAGE_ROWS, Math.floor(60_000 / Math.max(1, columns.length))));
  for await (const row of rows) {
    page.push(row);
    if (page.length >= most) await flush();
  }
  await flush();
  return written;
}

/**
 * Brings every key that counts up by itself past the highest value its table holds, so that the
 * next row gets a key no row has: rows written with their keys leave the counters where they were.
 */
export async function keysPastRows(q: Sql): Promise<void> {
  const counted = await q.all(
    `select table_name as t, column_name as c from information_schema.columns
       where table_schema = current_schema() and is_identity = 'YES'`,
  );
  for (const { t, c } of counted) {
    const table = quoted(String(t));
    const column = quoted(String(c));
    await q.get(
      `select setval(pg_get_serial_sequence(?, ?), greatest((select max(${column}) from ${table}), 1),
         (select max(${column}) from ${table}) is not null)`,
      `${quoted(String(t))}`,
      String(c),
    );
  }
}

import type { SQLInputValue } from "node:sqlite";
import type { ControlStore } from "./index.ts";
import type { SqliteStore } from "./sqlite.ts";

/**
 * The SQLite store behind each store this process opened (goal 267). Production code outside
 * this folder can't import this file (the folder rule), so none of it reaches the database.
 */

const behind = new WeakMap<ControlStore, SqliteStore>();

/** A statement run behind a store: its rows, and how many rows it changed. */
type Statement = (
  sql: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[]; changed: number }>;

/** What runs a statement behind each store this process opened, on SQLite or on PostgreSQL. */
const statements = new WeakMap<ControlStore, Statement>();

/** Notes the SQLite store behind `store`, as the store's opener does. */
export function keepBehind(store: ControlStore, sqlite: SqliteStore): void {
  behind.set(store, sqlite);
  statements.set(store, async (sql, values) => {
    const statement = sqlite.db.prepare(sql);
    // A statement that gives rows is read; one that writes says how many rows it changed.
    if (statement.columns().length > 0)
      return {
        rows: statement.all(...(values as SQLInputValue[])).map((r) => ({ ...r })),
        changed: 0,
      };
    return { rows: [], changed: Number(statement.run(...(values as SQLInputValue[])).changes) };
  });
}

/** Notes what runs a statement behind `store`, as the opener of a store on PostgreSQL does. */
export function keepStatements(store: ControlStore, run: Statement): void {
  statements.set(store, run);
}

function statementOf(store: ControlStore): Statement {
  const run = statements.get(store);
  if (!run) throw new Error("not a store this process opened");
  return run;
}

/**
 * The rows a statement gives, read behind `store` on either store, with `?` for each value: for
 * a test that reads a table no call gives. It takes no turn among the store's callers, so it
 * reads inside a transaction that is open. The statement is one both stores read the same way.
 */
export async function rowsBehind(
  store: ControlStore,
  sql: string,
  ...values: unknown[]
): Promise<Record<string, unknown>[]> {
  return (await statementOf(store)(sql, values)).rows;
}

/**
 * Runs a statement that writes behind `store` on either store: for a test that puts the store
 * in a state no call leaves it in. How many rows it changed.
 */
export async function writeBehind(
  store: ControlStore,
  sql: string,
  ...values: unknown[]
): Promise<number> {
  return (await statementOf(store)(sql, values)).changed;
}

/**
 * The names of the store's own tables, read behind `store` on either store, in order. The tables
 * a database keeps for itself, as SQLite's of its counting keys, are not the store's.
 */
export async function tablesBehind(store: ControlStore): Promise<string[]> {
  const sql = behind.has(store)
    ? "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"
    : "select table_name as name from information_schema.tables where table_schema = current_schema() order by table_name";
  return (await rowsBehind(store, sql)).map((r) => String(r.name));
}

/**
 * What sqliteBehind says of a store that is not on SQLite. A test that reaches the SQLite
 * database itself is a test of the SQLite store: when the tests run on PostgreSQL it is left
 * out by this (tests/helpers/sqlite-only.ts).
 */
export class NotOnSqlite extends Error {
  constructor() {
    super("not a store this process opened on SQLite");
  }
}

/**
 * The SQLite store behind `store`, for a test that must reach the database itself: to make a
 * store as an older version left it, or to read a table that no call gives.
 */
export function sqliteBehind(store: ControlStore): SqliteStore {
  const sqlite = behind.get(store);
  if (!sqlite) throw new NotOnSqlite();
  return sqlite;
}

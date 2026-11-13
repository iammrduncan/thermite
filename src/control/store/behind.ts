import type { ControlStore } from "./index.ts";
import type { SqliteStore } from "./sqlite.ts";

/**
 * The SQLite store behind each store this process opened (goal 267). Production code outside
 * this folder can't import this file (the folder rule), so none of it reaches the database.
 */

const behind = new WeakMap<ControlStore, SqliteStore>();

/** Notes the SQLite store behind `store`, as the store's opener does. */
export function keepBehind(store: ControlStore, sqlite: SqliteStore): void {
  behind.set(store, sqlite);
}

/**
 * The SQLite store behind `store`, for a test that must reach the database itself: to make a
 * store as an older version left it, or to read a table that no call gives.
 */
export function sqliteBehind(store: ControlStore): SqliteStore {
  const sqlite = behind.get(store);
  if (!sqlite) throw new Error("not a store this process opened on SQLite");
  return sqlite;
}

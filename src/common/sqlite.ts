import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorText } from "./errors.ts";
import { log } from "./log.ts";

/**
 * Thermite's SQLite databases (goal 125, T6): the ledger and control's store open the same way
 * and run their transactions through one helper.
 */

/**
 * Opens the database at `path` (":memory:" for one in memory), making its folder: a busy timeout
 * first, since switching to WAL needs a lock another process may hold briefly, then WAL. Node's
 * SQLite holds foreign keys by default.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal;");
  return db;
}

/** How deep each database's transactions are nested now. */
const depths = new WeakMap<DatabaseSync, number>();

/**
 * Runs `fn` in one immediate transaction on `db`: all of it is kept, or none of it. A call inside
 * another becomes a savepoint of the outer one, so a function that needs a transaction may be
 * called inside a larger one.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  const savepoint = depth > 0 ? `sp${depth}` : undefined;
  db.exec(savepoint ? `savepoint ${savepoint}` : "begin immediate");
  depths.set(db, depth + 1);
  try {
    const out = fn();
    db.exec(savepoint ? `release ${savepoint}` : "commit");
    return out;
  } catch (err) {
    try {
      db.exec(savepoint ? `rollback to ${savepoint}; release ${savepoint}` : "rollback");
    } catch (rollback) {
      // A failed commit may have ended the transaction already: the first error is the one to
      // report, and the rollback's is logged beside it, never in its place (goal 163).
      log(
        "sqlite",
        "rollback failed",
        { error: errorText(rollback), after: errorText(err) },
        "error",
      );
    }
    throw err;
  } finally {
    // Once, whatever failed: a failed commit must not leave every later transaction nested.
    depths.set(db, depth);
  }
}

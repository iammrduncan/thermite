import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { transaction } from "../../common/sqlite.ts";
import type { ControlStore } from "./index.ts";

/**
 * What every sub-store of control's store shares (goal 125, T6): each owns its tables and their
 * SQL, over the store's one database, and reaches the others through the store, as the audit log
 * for its entries. A write to another sub-store's table goes through that sub-store.
 */

export type Row = Record<string, SQLInputValue>;

export abstract class StorePart {
  protected readonly store: ControlStore;
  protected readonly db: DatabaseSync;

  constructor(store: ControlStore, db: DatabaseSync) {
    this.store = store;
    this.db = db;
  }

  /** Runs fn in the store's transaction (a savepoint inside one already open). */
  protected tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }
}

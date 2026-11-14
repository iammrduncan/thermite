import type { Row, Sql } from "../../../common/postgres.ts";
import type { PostgresStore } from "./store.ts";

/**
 * What every sub-store of control's store on PostgreSQL shares (goal 268): each owns its tables
 * and their SQL, over the store's one connection, and reaches the others through the store. Each
 * is the PostgreSQL form of the SQLite sub-store of the same name (../), behind the same
 * interface.
 */

export { jsonPart, jsonText } from "../../../common/postgres.ts";
export type { Row };

export abstract class PgPart {
  protected readonly store: PostgresStore;
  protected readonly q: Sql;

  constructor(store: PostgresStore, q: Sql) {
    this.store = store;
    this.q = q;
  }

  /** Runs fn in the store's transaction (a savepoint inside one already open). */
  protected tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.q.tx(fn);
  }
}

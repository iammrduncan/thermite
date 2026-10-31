import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { transaction } from "../../common/sqlite.ts";
import type { AppendEvent } from "../../core/events/bodies.ts";
import type { Ledger } from "./index.ts";

/**
 * What every module of the ledger shares (goal 125, T6): each module owns its tables and their
 * SQL, reads the others through the ledger, and records its events through the ledger's one
 * writer.
 */

export type Row = Record<string, SQLInputValue>;

export class LedgerError extends Error {
  readonly code: "conflict" | "not_found" | "invalid" | "stale";

  constructor(code: LedgerError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export abstract class LedgerPart {
  protected readonly ledger: Ledger;
  protected readonly db: DatabaseSync;
  protected readonly clock: () => Date;

  constructor(ledger: Ledger, db: DatabaseSync, clock: () => Date) {
    this.ledger = ledger;
    this.db = db;
    this.clock = clock;
  }

  protected now(): string {
    return this.clock().toISOString();
  }

  /** Runs fn in the ledger's transaction (a savepoint inside one already open). */
  protected tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  protected row<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  protected rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  protected execute(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  protected appendEvent: AppendEvent = (actor, kind, subject, body) =>
    this.ledger.appendEvent(actor, kind, subject, body);
}

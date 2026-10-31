import type { DatabaseSync } from "node:sqlite";
import { copyBeforeMigration, newerSchemaWords } from "../../common/db-copy.ts";
import { LEDGER_MIGRATIONS as MIGRATIONS } from "./migrations.ts";

/**
 * Brings a ledger to this code's schema (`LEDGER_MIGRATIONS`, in `migrations.ts`), each
 * migration in a transaction of `tx`. A ledger written by newer code is refused through `refuse`,
 * never opened: its new tables and columns would be ignored or broken, and a rollback must not
 * damage the record. A ledger with a record is copied before a migration changes it (goal 173), so
 * an update can be undone; the refusal names that copy.
 */
export function migrateLedger(
  db: DatabaseSync,
  path: string,
  tx: (fn: () => void) => void,
  refuse: (message: string) => Error,
): void {
  db.exec("create table if not exists schema_migrations (version integer primary key)");
  const row = db.prepare("select max(version) as v from schema_migrations").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  if (current > MIGRATIONS.length)
    throw refuse(newerSchemaWords("ledger", path, current, MIGRATIONS.length));
  if (current > 0 && current < MIGRATIONS.length && path !== ":memory:")
    copyBeforeMigration(db, path, current, MIGRATIONS.length);
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (version <= current) return;
    tx(() => {
      if (typeof sql === "string") db.exec(sql);
      else sql(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(version);
    });
  });
}

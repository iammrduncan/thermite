import type { Sql } from "../../../../common/postgres.ts";
import { CONTROL_TABLES } from "./control.ts";
import { KNOWLEDGE_TABLES } from "./knowledge.ts";
import { RIG_TABLES } from "./rigs.ts";

/**
 * The schema of control's store on PostgreSQL and its migrations (goal 268). It is the SQLite
 * store's schema as its migrations leave it (../schema.ts), in PostgreSQL's words: the same
 * tables, columns and names, so the copy command copies table by table. Its list of migrations
 * is its own, and starts at one.
 *
 * What differs from SQLite's, and why:
 *
 * - a whole number is `bigint`, and comes back as a number (the store's are small);
 * - a key that counts up by itself is an identity column;
 * - a text column compares and sorts by its bytes (`collate "C"`), as SQLite's do, whatever the
 *   server's own order is: textColumns() writes it for every text column;
 * - `user`, `full` and `text` are PostgreSQL's own words, so the columns of those names are
 *   written in quotes, here and in every statement;
 * - the knowledge base's words index is not here: goal 269 builds it. Its passages are.
 */

/**
 * `ddl` with every text column comparing and sorting by its bytes. A column's type is the word
 * after its name: a column named `text` is written in quotes, so it is not taken for one.
 */
function textColumns(ddl: string): string {
  return ddl
    .split("\n")
    .map((line) =>
      line.trimStart().startsWith("--")
        ? line
        : line.replace(/ text(?=[ ,)]|$)/g, ' text collate "C"'),
    )
    .join("\n");
}

/** Migration 1: every table as the SQLite store's migrations leave it. */
async function schemaOne(q: Sql): Promise<void> {
  for (const tables of [CONTROL_TABLES, RIG_TABLES, KNOWLEDGE_TABLES])
    await q.exec(textColumns(tables));
}

/**
 * The store's migrations, in order. Each runs once, in a transaction with the note that it ran.
 * A migration is never changed once a release held it: a change to the schema is a new one.
 */
const MIGRATIONS: readonly ((q: Sql) => Promise<void>)[] = [schemaOne];

/** The schema version this code brings a store on PostgreSQL to: how many migrations there are. */
export const POSTGRES_STORE_VERSION = MIGRATIONS.length;

/**
 * Brings the store to this code's version: makes a new one, and runs the migrations a store of an
 * older version has not run. A store of a newer version is refused in words: this code must not
 * write to it. `upTo` stops at an older version, for rows of that version that are loaded next
 * (load.ts).
 */
export async function migratePostgres(q: Sql, upTo = POSTGRES_STORE_VERSION): Promise<void> {
  await q.exec("create table if not exists schema_migrations (version bigint primary key)");
  const held = Number((await q.get("select max(version) as v from schema_migrations"))?.v ?? 0);
  if (held > POSTGRES_STORE_VERSION)
    throw new Error(
      `control's store on PostgreSQL is at schema version ${held}, newer than this code's ${POSTGRES_STORE_VERSION}: run a newer Thermite, or restore the store from a backup made before the upgrade`,
    );
  for (let v = held + 1; v <= upTo; v++) {
    const migration = MIGRATIONS[v - 1];
    if (!migration) continue;
    await q.tx(async () => {
      await migration(q);
      await q.run("insert into schema_migrations (version) values (?)", v);
    });
  }
}

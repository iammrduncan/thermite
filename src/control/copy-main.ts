import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { optionalSecretFromFile } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import {
  connectPostgres,
  POSTGRES_PASSWORD_FILE_SETTING,
  postgresAddress,
  STORE_SETTING,
} from "../common/postgres.ts";
import { CONTROL_STATE } from "../core/backup.ts";
import { CopyRefused, copyStore, LoadDiffers } from "./store/index.ts";

/**
 * `thermite store copy` (goal 268): control's store from its SQLite file into a PostgreSQL
 * database, run where control's state folder is mounted and the database is reached as control
 * reaches it, with control stopped. It is control's own program, since it holds both stores'
 * tables; the command line starts it (cli/thermite/store.ts). It reads the database's address
 * and its password's file from control's own settings.
 */

/** Control's state folder, unless --state names one: THERMITE_CONTROL_DIR, as control reads it. */
const DEFAULT_STATE = "/var/lib/thermite-control";

const say = (line: string) => process.stdout.write(`${line}\n`);
const words = (n: number) => n.toLocaleString("en-US");

/** Each table's rows on both sides, in columns, with a mark on a table whose two counts differ. */
function table(rows: { table: string; sqlite: number; postgres: number }[]): string {
  const wide = Math.max(5, ...rows.map((r) => r.table.length));
  const line = (name: string, a: string, b: string, mark = "") =>
    `  ${name.padEnd(wide)}  ${a.padStart(10)}  ${b.padStart(10)}${mark}`;
  return [
    line("table", "SQLite", "PostgreSQL"),
    ...rows.map((r) =>
      line(r.table, words(r.sqlite), words(r.postgres), r.sqlite === r.postgres ? "" : "  differs"),
    ),
  ].join("\n");
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { state: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length) {
    process.stderr.write("usage: thermite store copy [--state DIR]\n");
    return 2;
  }
  const env = process.env;
  const stateDir = resolve(values.state ?? env.THERMITE_CONTROL_DIR ?? DEFAULT_STATE);
  const sqlite = join(stateDir, CONTROL_STATE.db);
  if (!existsSync(sqlite)) {
    process.stderr.write(
      `${stateDir} holds no ${CONTROL_STATE.db}: give control's state folder with --state\n`,
    );
    return 2;
  }
  let url: string;
  try {
    url = postgresAddress(env);
  } catch (err) {
    process.stderr.write(`${errorText(err)}\n`);
    return 2;
  }
  const conn = connectPostgres(url, {
    password: optionalSecretFromFile(POSTGRES_PASSWORD_FILE_SETTING, env),
  });
  say(`copying ${sqlite} into ${url}`);
  try {
    const report = await copyStore({ sqlite, conn, say });
    const rows = report.tables.reduce((n, t) => n + t.sqlite, 0);
    say(table(report.tables));
    for (const [stream, seq] of Object.entries(report.places))
      say(`control's place in ${stream}: ${words(seq)}, carried as it is`);
    say(
      `copied: ${report.tables.length} tables, ${words(rows)} rows, the same on both sides. The SQLite store is as it was`,
    );
    say(
      `next: set ${STORE_SETTING}=postgres, and start control: it goes on from its place in the bus's streams. The knowledge base's words index is not copied: a search there is a plain match until it is built on PostgreSQL`,
    );
    return 0;
  } catch (err) {
    if (err instanceof LoadDiffers) {
      say(table(err.tables.map((t) => ({ table: t.table, sqlite: t.given, postgres: t.loaded }))));
      process.stderr.write(`copy failed: ${err.message}\n`);
      return 1;
    }
    if (err instanceof CopyRefused) {
      process.stderr.write(`copy refused: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(
      `copy failed: ${errorText(err)}. Nothing was kept: the database is as it was, and so is the SQLite store\n`,
    );
    return 1;
  } finally {
    await conn.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${errorText(err)}\n`);
    process.exit(1);
  },
);

import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "./env.ts";

/**
 * A copy of a SQLite database before a migration changes it (goal 173): an update that migrates
 * can then be undone. The copy is a consistent snapshot (`vacuum into`), made beside the database
 * as `<file>.v<version>.<time>.copy`, where the version is the schema's before the migration. The
 * two newest copies of each database are kept: a copy is not the record, and each one costs the
 * disk of the database. A copy before a migration that removes what only the copy then keeps is
 * kept outside that rotation (keepCopyBefore).
 */

/** How many copies of each database are kept beside it. */
export const COPIES_KEPT = 2;

export interface DbCopy {
  path: string;
  /** The schema's version in the copy. */
  version: number;
  /** When it was made, as in its name. */
  stamp: string;
}

const NAME = /^\.v(\d+)\.(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.copy$/;

/** The copies of a database beside it, newest first. */
export function copiesOf(path: string): DbCopy[] {
  const dir = dirname(path);
  const base = basename(path);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: DbCopy[] = [];
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const m = NAME.exec(name.slice(base.length));
    if (m?.[1] && m[2]) out.push({ path: join(dir, name), version: Number(m[1]), stamp: m[2] });
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * Copies the database before a migration from `version` to `to`, then keeps only the newest
 * copies. Returns the copy's path.
 */
export function copyBeforeMigration(
  db: DatabaseSync,
  path: string,
  version: number,
  to: number,
  now: Date = new Date(),
): string {
  const copy = `${path}.v${version}.${now.toISOString().replace(/[:.]/g, "-")}.copy`;
  db.prepare("vacuum into ?").run(copy);
  for (const old of copiesOf(path).slice(COPIES_KEPT)) rmSync(old.path, { force: true });
  log("db", "copied the database before a migration", { path, copy, from: version, to });
  return copy;
}

/**
 * Copies the database before a migration that removes what only the copy then keeps, as the drop
 * of control's events table: the copy is `<file>.v<version>.<time>.kept`, outside the rotation
 * above, and stays until the owner removes it. Returns the copy's path.
 */
export function keepCopyBefore(
  db: DatabaseSync,
  path: string,
  version: number,
  to: number,
  why: string,
  now: Date = new Date(),
): string {
  const copy = `${path}.v${version}.${now.toISOString().replace(/[:.]/g, "-")}.kept`;
  db.prepare("vacuum into ?").run(copy);
  const what = { path, copy, from: version, to, why };
  log("db", "kept a copy of the database before a migration, until you remove it", what, "warn");
  return copy;
}

/**
 * The copy to restore when code that knows schema versions up to `version` meets a database a
 * newer Thermite migrated: the newest copy at that version or below.
 */
export function copyToRestore(path: string, version: number): string | undefined {
  return copiesOf(path).find((c) => c.version <= version)?.path;
}

/** The words of a refusal to open a database newer than the code, naming the copy to restore. */
export function newerSchemaWords(what: string, path: string, found: number, known: number): string {
  const copy = copyToRestore(path, known);
  return `this ${what} is at schema version ${found}, newer than this code's ${known}: run a newer Thermite, or restore the ${what} from before the upgrade${copy ? ` (the copy made then: ${copy})` : ""}`;
}

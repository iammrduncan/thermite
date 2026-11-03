import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../core/canonical.ts";
import { bodyKeys, currentRule } from "../../core/names.ts";

/** A JSON column's value with each object's old keys (core/names.ts) under the new names. */
function renameKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      bodyKeys("direction").includes(k) ? "direction" : k,
      renameKeys(v),
    ]),
  );
}

/** Rewrites one JSON column of every row through `change`, keeping rows that don't change. */
function rewriteJson(
  db: DatabaseSync,
  table: string,
  key: string,
  column: string,
  change: (v: unknown) => unknown,
): void {
  const rows = db
    .prepare(`select ${key} as k, ${column} as v from ${table} where ${column} is not null`)
    .all() as { k: string | number; v: string }[];
  const set = db.prepare(`update ${table} set ${column} = ? where ${key} = ?`);
  for (const r of rows) {
    const now = canonicalJson(change(JSON.parse(r.v)));
    if (now !== r.v) set.run(now, r.k);
  }
}

/**
 * Migration 29: the public names in every row a ledger may change (the guide's questions 11 and
 * 23, owner, 2026-10-26 and 2026-11-01). Append-only events and signed records keep their words;
 * core/names.ts reads them under these.
 *
 * - The owner's label for a run is its note: `run.direction` is `run.note`.
 * - An approach family is a direction: the `family` table (the direction registry) is
 *   `direction`, and the `family` column of trials, lanes, attempts and experiments is
 *   `direction`. A rule's direction, an epoch's assignments and a conclusion's refuted approaches
 *   take the key `direction`.
 * - A rule's kind `note`, free text for the planner, is `planner_note`.
 * - A field note's kind `note` is `other`. The table's check names the kinds, so it is copied
 *   whole into its new form, as migration 16 did: every note and its id is kept, append-only.
 * - A research note is a source note: the `note` table is `source_note`.
 */
export function publicNames(db: DatabaseSync): void {
  db.exec("alter table run rename column direction to note");

  db.exec("alter table family rename to direction");
  for (const table of ["trial", "lane", "attempt", "experiment"])
    db.exec(`alter table ${table} rename column family to direction`);
  rewriteJson(db, "directive", "id", "body", currentRule);
  rewriteJson(db, "epoch", "rowid", "assignments", renameKeys);
  rewriteJson(db, "conclusion", "id", "evidence", renameKeys);

  db.exec(`
  create table journal_note_v29 (
    id integer primary key autoincrement,
    run text not null,
    by text not null,
    kind text not null
      check (kind in ('observation', 'decision', 'surprise', 'question', 'lesson', 'other')),
    text text not null check (length(text) between 1 and 2000),
    about_type text not null
      check (about_type in ('run', 'experiment', 'attempt', 'source', 'claim', 'finding', 'round', 'trial', 'message')),
    about_id text not null,
    lane text,
    trial text,
    at text not null
  );
  insert into journal_note_v29 (id, run, by, kind, text, about_type, about_id, lane, trial, at)
    select id, run, by, case kind when 'note' then 'other' else kind end, text, about_type,
      about_id, lane, trial, at
    from journal_note order by id;
  drop table journal_note;
  alter table journal_note_v29 rename to journal_note;
  create index journal_note_run on journal_note (run, id);
  create index journal_note_lane on journal_note (run, lane, id);
  create trigger journal_note_no_update before update on journal_note begin select raise(abort, 'field notes are append-only'); end;
  create trigger journal_note_no_delete before delete on journal_note begin select raise(abort, 'field notes are append-only'); end;
  `);

  db.exec("alter table note rename to source_note");
}

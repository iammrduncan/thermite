import type { DatabaseSync } from "node:sqlite";
import type { KbKind } from "../../../core/kb.ts";
import { type KbIndexTarget, metaOf, str } from "../../../core/kb-index.ts";
import { JOURNAL_KINDS, type KbItem } from "../../kb/index.ts";
import { itemOf } from "./items.ts";

type Row = Record<string, unknown>;

/**
 * The kinds of event that name a lane or a trial, under their names now (core/kb-index.ts gives
 * each item it puts from one the lane and the trial, as fields). Reading 4 reads them once more
 * for that alone (goal 176): originTarget.
 */
export const ORIGIN_KINDS = [
  "trial_started",
  "trial_finished",
  "journal_note",
  "research_note",
  "research_doc",
  "context_compacted",
  "experiment_added",
  "experiment_finished",
  "attempt_recorded",
  "hypothesis_added",
  "hypothesis_revised",
  "hypothesis_merged",
];

/** The fields reading 4 gives the items kept before it: where each came from, and what a field note is about. */
const ORIGIN_FIELDS = ["lane", "trial", "about_type", "about_id"];

/**
 * Where an event read again puts nothing new but the lane and the trial it names (and what a field
 * note is about), into the fields of the records item it wrote, in place: its text, its time and
 * its seq stay, and so does every version (kb_version is never changed, and its fields are never
 * read back). An item the reading never made is passed over; nothing else is written.
 */
export function originTarget(
  db: DatabaseSync,
  src: { rig: string; ledger: string },
): KbIndexTarget {
  const find = (run: string, kind: string, ref: string) =>
    db
      .prepare(
        "select id, run, body, meta from kb_item where rig = ? and ledger = ? and run = ? and slot = 'records' and kind = ? and ref = ?",
      )
      .get(src.rig, src.ledger, run, kind, ref) as Row | undefined;
  return {
    runCreated: () => {},
    item: (run, kind, ref) => {
      const r = find(run, kind, ref);
      return r && { body: str(r.body), meta: metaOf(str(r.meta)) };
    },
    attempt: (ref) => {
      const r = db
        .prepare(
          "select run, body, meta from kb_item where rig = ? and ledger = ? and slot = 'records' and kind = 'attempt' and ref = ?",
        )
        .get(src.rig, src.ledger, ref) as Row | undefined;
      return r && { run: str(r.run), body: str(r.body), meta: metaOf(str(r.meta)) };
    },
    put: (run, kind, ref, f) => {
      const r = find(run, kind, ref);
      if (!r || !f.meta) return;
      const meta = metaOf(str(r.meta));
      const given = f.meta;
      const add = ORIGIN_FIELDS.filter((k) => given[k] && given[k] !== meta[k]);
      if (!add.length) return;
      for (const k of add) meta[k] = given[k] as string;
      db.prepare("update kb_item set meta = ? where id = ?").run(
        JSON.stringify(meta),
        Number(r.id),
      );
    },
  };
}

/** How many items of each kind one run put in its collection (field notes apart). */
export function runCountsOf(
  db: DatabaseSync,
  rig: string,
  ledger: string,
  run: string,
): Partial<Record<KbKind, number>> & { journal: number } {
  const out: Partial<Record<KbKind, number>> & { journal: number } = { journal: 0 };
  for (const r of db
    .prepare(
      `select kind, count(*) as n,
         sum(case when kind = 'note' and sub in (${JOURNAL_KINDS.map(() => "?").join(", ")}) then 1 else 0 end) as journal
       from kb_item where rig = ? and ledger = ? and run = ? group by kind`,
    )
    .all(...JOURNAL_KINDS, rig, ledger, run) as Row[]) {
    out[str(r.kind) as KbKind] = Number(r.n);
    out.journal += Number(r.journal);
  }
  return out;
}

/**
 * A run's field notes in its records slot, newest first (the Journal tab, goal 176): at most
 * `limit`, with how many it has. A research note (`rn-` ref) is not one, whatever its kind.
 */
export function fieldNotesOf(
  db: DatabaseSync,
  src: { rig: string; ledger: string; run: string },
  limit: number,
): { total: number; items: KbItem[] } {
  const where =
    "rig = ? and ledger = ? and run = ? and slot = 'records' and kind = 'note' and ref not like 'rn-%'";
  const args = [src.rig, src.ledger, src.run];
  const total = Number(
    (db.prepare(`select count(*) as n from kb_item where ${where}`).get(...args) as Row).n,
  );
  const items = (
    db
      .prepare(`select * from kb_item where ${where} order by at desc, id desc limit ?`)
      .all(...args, Math.max(0, Math.floor(limit))) as Row[]
  ).map(itemOf);
  return { total, items };
}

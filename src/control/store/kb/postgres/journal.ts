import type { Sql } from "../../../../common/postgres.ts";
import { type KbKind, metaOf, str } from "../../../../core/kb/index.ts";
import type { KbItem } from "../index.ts";
import { itemOf } from "../items.ts";
import { journalCount, ORIGIN_FIELDS, type Row } from "../journal.ts";
import type { KbIndexTargetLater } from "./replay.ts";

/**
 * Where an event read again puts nothing new but the lane and the trial it names (and what a field
 * note is about), into the fields of the records item it wrote, in place: its text, its time and
 * its seq stay, and so does every version (kb_version is never changed, and its fields are never
 * read back). An item the reading never made is passed over; nothing else is written.
 */
export function originTarget(q: Sql, src: { rig: string; ledger: string }): KbIndexTargetLater {
  const find = async (run: string, kind: string, ref: string) =>
    (await q.get(
      "select id, run, body, meta from kb_item where rig = ? and ledger = ? and run = ? and slot = 'records' and kind = ? and ref = ?",
      src.rig,
      src.ledger,
      run,
      kind,
      ref,
    )) as Row | undefined;
  return {
    runCreated: async () => {},
    item: async (run, kind, ref) => {
      const r = await find(run, kind, ref);
      return r && { body: str(r.body), meta: metaOf(str(r.meta)) };
    },
    attempt: async (ref) => {
      const r = (await q.get(
        "select run, body, meta from kb_item where rig = ? and ledger = ? and slot = 'records' and kind = 'attempt' and ref = ?",
        src.rig,
        src.ledger,
        ref,
      )) as Row | undefined;
      return r && { run: str(r.run), body: str(r.body), meta: metaOf(str(r.meta)) };
    },
    put: async (run, kind, ref, f) => {
      const r = await find(run, kind, ref);
      if (!r || !f.meta) return;
      const meta = metaOf(str(r.meta));
      const given = f.meta;
      const add = ORIGIN_FIELDS.filter((k) => given[k] && given[k] !== meta[k]);
      if (!add.length) return;
      for (const k of add) meta[k] = given[k] as string;
      await q.run("update kb_item set meta = ? where id = ?", JSON.stringify(meta), Number(r.id));
    },
  };
}

/** How many items of each kind one run put in its collection (field notes apart). */
export async function runCountsOf(
  q: Sql,
  rig: string,
  ledger: string,
  run: string,
): Promise<Partial<Record<KbKind, number>> & { journal: number }> {
  const out: Partial<Record<KbKind, number>> & { journal: number } = { journal: 0 };
  for (const r of (await q.all(
    `select kind, count(*) as n,
         ${journalCount().sql} as journal
       from kb_item where rig = ? and ledger = ? and run = ? group by kind`,
    ...journalCount().args,
    rig,
    ledger,
    run,
  )) as Row[]) {
    out[str(r.kind) as KbKind] = Number(r.n);
    out.journal += Number(r.journal);
  }
  return out;
}

/**
 * A run's field notes in its records slot, newest first (the Journal tab, goal 176): at most
 * `limit`, with how many it has. A source note (`rn-` ref) is not one, whatever its kind.
 */
export async function fieldNotesOf(
  q: Sql,
  src: { rig: string; ledger: string; run: string },
  limit: number,
): Promise<{ total: number; items: KbItem[] }> {
  const where =
    "rig = ? and ledger = ? and run = ? and slot = 'records' and kind = 'note' and ref not ilike 'rn-%'";
  const args = [src.rig, src.ledger, src.run];
  const total = Number(
    ((await q.get(`select count(*) as n from kb_item where ${where}`, ...args)) as Row).n,
  );
  const items = (
    (await q.all(
      `select * from kb_item where ${where} order by at desc, id desc limit ?`,
      ...args,
      Math.max(0, Math.floor(limit)),
    )) as Row[]
  ).map(itemOf);
  return { total, items };
}

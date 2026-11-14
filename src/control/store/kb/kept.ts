import type { DatabaseSync } from "node:sqlite";
import { withoutCredentials } from "../../../common/scrub.ts";
import { COMPACTIONS_DIR } from "../../../core/compaction.ts";
import { KB_RECORDS, type KbStored, metaOf, str, writerOfSlot } from "../../../core/kb/index.ts";
import { type ItemPlace, keepVersion } from "./items.ts";

/**
 * Kept conversations from before the harness scrubbed them (goal 175). A rig of an earlier build
 * sent the start of each one in its `context_compacted` event, and control kept it as the text of
 * a records document under `compactions/`, with no file. Control scrubs that text by shape
 * (common/scrub.ts, withoutCredentials: it never knew the values the harness gave the agents) into
 * a new version of the item, written by Thermite's code, with a note in the version's fields. The
 * version before stays, as every version does: the owner reads every version, and an agent reads
 * from the first scrubbed one on (agentsReadFrom). The same event read again, or one a rig of that
 * build sends now, is scrubbed the same way as the reading stores it (reading.ts): so the item's
 * newest text, which the words index holds, is always the scrubbed one.
 */

/** The field of a version whose text Thermite's code scrubbed by shape, and its words. */
export const SCRUBBED = "scrubbed";
const SCRUBBED_NOTE = "Thermite's code scrubbed this text by shape";

export type Row = Record<string, unknown>;

/** Where a records item is, as far as this needs: its slot, kind and id. */
type KeptPlace = Pick<ItemPlace, "slot" | "kind" | "ref">;

/** Whether a records item is a kept conversation whose text the item holds, with no file. */
const textKept = (p: KeptPlace, file: unknown): boolean =>
  p.slot === KB_RECORDS && p.kind === "doc" && p.ref.startsWith(`${COMPACTIONS_DIR}/`) && !file;

/**
 * An item's fields as control keeps them: for a kept conversation whose text the item holds, that
 * text scrubbed by shape, written by Thermite's code, with the note in its fields. Any other item,
 * or a text the scrub leaves as it is, keeps the fields it was given (the same object).
 */
export function scrubbedKept(p: KeptPlace, f: KbStored): KbStored {
  if (!textKept(p, f.file)) return f;
  const body = withoutCredentials(f.body);
  if (body === f.body) return f;
  return {
    ...f,
    body,
    by: writerOfSlot(KB_RECORDS),
    meta: JSON.stringify({ ...metaOf(f.meta), [SCRUBBED]: SCRUBBED_NOTE }),
  };
}

/**
 * One page of the kept conversations whose text control holds, by item id after `after`: each one
 * whose newest version is not scrubbed already, and whose text the scrub changes, gets its
 * scrubbed new version. A second pass finds nothing to do. In the caller's transaction. How many
 * it looked at and scrubbed, and the last id it looked at.
 */
export function scrubKeptPage(
  db: DatabaseSync,
  nextSeq: () => number,
  o: { after: number; limit: number; at: string },
): { looked: number; scrubbed: number; last: number } {
  const rows = db
    .prepare(
      `select i.id, i.campaign, i.rig, i.ledger, i.run, i.slot, i.kind, i.ref, i.title,
         v.body as own, i.by, i.url, i.sub, i.meta
       from kb_item i join kb_version v on v.item = i.id and v.version = i.version
       where i.slot = ? and i.kind = 'doc' and i.ref like ? and i.file_sha256 is null and i.id > ?
       order by i.id limit ?`,
    )
    .all(KB_RECORDS, `${COMPACTIONS_DIR}/%`, o.after, o.limit) as Row[];
  let scrubbed = 0;
  for (const r of rows) {
    if (metaOf(str(r.meta))[SCRUBBED]) continue;
    const place: ItemPlace = {
      campaign: str(r.campaign),
      rig: str(r.rig),
      ledger: str(r.ledger),
      run: str(r.run),
      slot: str(r.slot),
      kind: str(r.kind),
      ref: str(r.ref),
    };
    const held: KbStored = {
      title: str(r.title),
      body: str(r.own),
      by: str(r.by),
      url: r.url ? str(r.url) : null,
      sub: r.sub ? str(r.sub) : null,
      meta: str(r.meta),
      file: null,
    };
    const next = scrubbedKept(place, held);
    if (next === held) continue;
    keepVersion(db, nextSeq(), place, next, { at: o.at });
    scrubbed++;
  }
  return { looked: rows.length, scrubbed, last: Number(rows.at(-1)?.id ?? o.after) };
}

/**
 * The oldest version of an item an agent may read: for a kept conversation stored before the
 * scrubbing, its first scrubbed version; 1 for every other item.
 */
export function agentsReadFrom(db: DatabaseSync, id: number): number {
  const r = db
    .prepare(
      `select min(version) as v from kb_version where item = ?
         and (case when json_valid(meta) then json_extract(meta, '$.${SCRUBBED}') end) is not null`,
    )
    .get(id) as { v: number | null } | undefined;
  return Number(r?.v ?? 1);
}

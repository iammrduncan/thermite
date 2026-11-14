import { jsonText, type Sql } from "../../../../common/postgres.ts";
import { COMPACTIONS_DIR } from "../../../../core/compaction.ts";
import { KB_RECORDS, type KbStored, metaOf, str } from "../../../../core/kb/index.ts";
import type { ItemPlace } from "../items.ts";
import { type Row, SCRUBBED, scrubbedKept } from "../kept.ts";
import { keepVersion } from "./items.ts";

/**
 * One page of the kept conversations whose text control holds, by item id after `after`: each one
 * whose newest version is not scrubbed already, and whose text the scrub changes, gets its
 * scrubbed new version. A second pass finds nothing to do. In the caller's transaction. How many
 * it looked at and scrubbed, and the last id it looked at.
 */
export async function scrubKeptPage(
  q: Sql,
  nextSeq: () => Promise<number>,
  o: { after: number; limit: number; at: string },
): Promise<{ looked: number; scrubbed: number; last: number }> {
  const rows = (await q.all(
    `select i.id, i.campaign, i.rig, i.ledger, i.run, i.slot, i.kind, i.ref, i.title,
         v.body as own, i.by, i.url, i.sub, i.meta
       from kb_item i join kb_version v on v.item = i.id and v.version = i.version
       where i.slot = ? and i.kind = 'doc' and i.ref ilike ? and i.file_sha256 is null and i.id > ?
       order by i.id limit ?`,
    KB_RECORDS,
    `${COMPACTIONS_DIR}/%`,
    o.after,
    o.limit,
  )) as Row[];
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
    await keepVersion(q, await nextSeq(), place, next, { at: o.at });
    scrubbed++;
  }
  return { looked: rows.length, scrubbed, last: Number(rows.at(-1)?.id ?? o.after) };
}

/**
 * The oldest version of an item an agent may read: for a kept conversation stored before the
 * scrubbing, its first scrubbed version; 1 for every other item.
 */
export async function agentsReadFrom(q: Sql, id: number): Promise<number> {
  const r = (await q.get(
    `select min(version) as v from kb_version where item = ?
         and (case when meta is json then ${jsonText("meta", SCRUBBED)} end) is not null`,
    id,
  )) as { v: number | null } | undefined;
  return Number(r?.v ?? 1);
}

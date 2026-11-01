import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../../common/sqlite.ts";

/**
 * The older versions of the knowledge base's items, as a retention policy reads and removes them
 * (core/retention/): a version a newer one of its item replaced. The newest version of each item
 * always stays; the store refuses to remove it (store migration 24). The files a removed version
 * named stay while another version names them, and an orphan goes as the knowledge base's
 * settings say (control/kb/files.ts).
 */

type Row = Record<string, unknown>;

/** One older version: its item and number, run and rig, when it was written, about its bytes. */
export interface OlderVersion {
  item: number;
  version: number;
  rig: string;
  run: string;
  at: string;
  bytes: number;
}

/** Every older version, oldest first. */
export function olderVersions(db: DatabaseSync): OlderVersion[] {
  return (
    db
      .prepare(
        `select v.item, v.version, i.rig, i.run, v.at,
           length(cast(v.title as blob)) + length(cast(v.body as blob)) + length(cast(v.meta as blob))
             + coalesce(length(v.url), 0) + coalesce(length(v.sub), 0) as bytes
         from kb_version v join kb_item i on i.id = v.item
         where v.version < i.version order by v.at, v.item, v.version`,
      )
      .all() as Row[]
  ).map((r) => ({
    item: Number(r.item),
    version: Number(r.version),
    rig: String(r.rig),
    run: String(r.run),
    at: String(r.at),
    bytes: Number(r.bytes),
  }));
}

/**
 * Removes older versions, with their links, in one transaction; never an item's newest. How many
 * went.
 */
export function removeOlderVersions(
  db: DatabaseSync,
  versions: readonly { item: number; version: number }[],
): number {
  return transaction(db, () => {
    const newest = db.prepare("select version from kb_item where id = ?");
    const links = db.prepare("delete from kb_link where item = ? and version = ?");
    const del = db.prepare("delete from kb_version where item = ? and version = ?");
    let n = 0;
    for (const v of versions) {
      const top = newest.get(v.item) as Row | undefined;
      if (!top || Number(top.version) <= v.version) continue;
      links.run(v.item, v.version);
      n += Number(del.run(v.item, v.version).changes);
    }
    return n;
  });
}

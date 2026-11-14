import type { Sql } from "../../../../common/postgres.ts";
import type { OlderVersion, Row } from "../older.ts";

/** Every older version, oldest first. */
export async function olderVersions(q: Sql): Promise<OlderVersion[]> {
  return (
    (await q.all(`select v.item, v.version, i.rig, i.run, v.at,
           octet_length(v.title) + octet_length(v.body) + octet_length(v.meta)
             + coalesce(length(v.url), 0) + coalesce(length(v.sub), 0) as bytes
         from kb_version v join kb_item i on i.id = v.item
         where v.version < i.version order by v.at, v.item, v.version`)) as Row[]
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
export async function removeOlderVersions(
  q: Sql,
  versions: readonly { item: number; version: number }[],
): Promise<number> {
  return await q.tx(async () => {
    const newest = "select version from kb_item where id = ?";
    const links = "delete from kb_link where item = ? and version = ?";
    const del = "delete from kb_version where item = ? and version = ?";
    let n = 0;
    for (const v of versions) {
      const top = (await q.get(newest, v.item)) as Row | undefined;
      if (!top || Number(top.version) <= v.version) continue;
      await q.run(links, v.item, v.version);
      n += Number((await q.run(del, v.item, v.version)).changes);
    }
    return n;
  });
}

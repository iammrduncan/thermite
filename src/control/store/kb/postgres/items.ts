import type { Sql } from "../../../../common/postgres.ts";
import { KB_RECORDS, type KbItemBody, writtenRef } from "../../../../core/kb/index.ts";
import type { KbItem } from "../index.ts";
import { type ItemPlace, itemOf, itemText, type KbVersion, type VersionFields } from "../items.ts";
import { contextOf } from "../words.ts";
import { campaignAbout, followAttempt, indexItem, outcomeFor, unindexItem } from "./words.ts";

/**
 * A new item at `place`, or a new version of the one there, with its links: the item's row holds
 * the newest version, with a new seq; every version, the newest too, is kept in kb_version.
 * `event`: the kb_item event that wrote it. A file item's row holds its own words and its file's
 * text, when control has it, for the words index (itemText); its version keeps its own words.
 * Returns the item's id and its version. In the caller's transaction.
 */
export async function keepVersion(
  q: Sql,
  seq: number,
  place: ItemPlace,
  v: VersionFields,
  o: { at: string; event?: number | undefined; links?: readonly { rel: string; to: string }[] },
): Promise<{ id: number; version: number }> {
  const { campaign, rig, ledger, run, slot, kind, ref } = place;
  const f = v.file ?? undefined;
  const had = (await q.get(
    "select id, version from kb_item where rig = ? and ledger = ? and run = ? and slot = ? and kind = ? and ref = ?",
    rig,
    ledger,
    run,
    slot,
    kind,
    ref,
  )) as { id: number; version: number } | undefined;
  const file = [f?.sha256 ?? null, f?.name ?? null, f?.type ?? null, f?.bytes ?? null] as const;
  const indexed = f ? itemText(v.body, v.fileText ?? "") : v.body;
  // Its outcome and context come from Thermite's own records (words.ts), with each version.
  const outcome = await outcomeFor(q, place, v.meta);
  const about = await campaignAbout(q, campaign);
  const context = contextOf(place, { outcome, sub: v.sub, about });
  let id: number;
  let version: number;
  if (had) {
    id = Number(had.id);
    version = Number(had.version) + 1;
    await unindexItem(q, id);
    await q.run(
      `update kb_item set seq = ?, version = ?, title = ?, body = ?, by = ?, url = ?, sub = ?, meta = ?,
         file_sha256 = ?, file_name = ?, file_type = ?, file_bytes = ?, updated_at = ?, outcome = ?,
         context = ? where id = ?`,
      seq,
      version,
      v.title,
      indexed,
      v.by,
      v.url,
      v.sub,
      v.meta,
      ...file,
      o.at,
      outcome,
      context,
      id,
    );
  } else {
    version = 1;
    id = await q.insert(
      `insert into kb_item (seq, campaign, rig, ledger, run, slot, kind, ref, version, title, body,
             by, url, sub, meta, file_sha256, file_name, file_type, file_bytes, at, updated_at,
             outcome, context)
           values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      campaign,
      rig,
      ledger,
      run,
      slot,
      kind,
      ref,
      v.title,
      indexed,
      v.by,
      v.url,
      v.sub,
      v.meta,
      ...file,
      o.at,
      o.at,
      outcome,
      context,
    );
  }
  await indexItem(q, id, indexed);
  // A recorded attempt's outcome is its experiment's too.
  if (kind === "attempt" && slot === KB_RECORDS) await followAttempt(q, place, ref, outcome);
  await q.run(
    `insert into kb_version (item, version, title, body, by, url, sub, meta, file_sha256,
       file_name, file_type, file_bytes, event, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    version,
    v.title,
    v.body,
    v.by,
    v.url,
    v.sub,
    v.meta,
    ...file,
    o.event ?? null,
    o.at,
  );
  const link =
    "insert into kb_link (item, version, rel, target) values (?, ?, ?, ?) on conflict do nothing";
  for (const l of o.links ?? []) await q.run(link, id, version, l.rel, l.to);
  return { id, version };
}

/**
 * Whether a writer's `kb_item` event may go in: a new item takes a number its slot has not used,
 * and a new version is the next one of the writer's own item, of the same kind. Its words if not.
 * The writer's slot was checked against the event's writer first (control/events/knowledge.ts).
 */
export async function versionRefusal(
  q: Sql,
  src: { rig: string; ledger: string; run: string },
  b: KbItemBody,
): Promise<string | undefined> {
  const had = (await q.get(
    "select kind, version from kb_item where rig = ? and ledger = ? and run = ? and slot = ? and ref = ?",
    src.rig,
    src.ledger,
    src.run,
    b.slot,
    writtenRef(b.slot, b.item),
  )) as { kind: string; version: number } | undefined;
  const which = `item ${b.item} of slot ${b.slot}`;
  if (!had)
    return b.version === 1 ? undefined : `${which} does not exist: version ${b.version} of nothing`;
  if (b.version === 1)
    return `${which} exists already: a new version of it is version ${had.version + 1}`;
  if (had.kind !== b.kind)
    return `${which} is a ${had.kind}: a version keeps its kind, not ${b.kind}`;
  if (b.version !== Number(had.version) + 1)
    return `${which} is at version ${had.version}: the next is ${Number(had.version) + 1}, not ${b.version}`;
  return undefined;
}

/** Every version of an item, oldest first, each with its links. */
export async function versionsOf(q: Sql, id: number): Promise<KbVersion[]> {
  const rows = (await q.all(
    `select version, title, body, by, file_sha256, file_name, file_type, file_bytes, event, at
       from kb_version where item = ? order by version`,
    id,
  )) as Record<string, string | number | null>[];
  const links =
    "select rel, target from kb_link where item = ? and version = ? order by rel, target";
  const out: KbVersion[] = [];
  for (const r of rows)
    out.push({
      version: Number(r.version),
      title: String(r.title),
      body: String(r.body),
      by: String(r.by),
      file_sha256: r.file_sha256 === null ? null : String(r.file_sha256),
      file:
        r.file_sha256 === null
          ? null
          : {
              sha256: String(r.file_sha256),
              name: String(r.file_name),
              type: String(r.file_type),
              bytes: Number(r.file_bytes ?? 0),
            },
      event: r.event === null ? null : Number(r.event),
      at: String(r.at),
      links: ((await q.all(links, id, Number(r.version))) as { rel: string; target: string }[]).map(
        (l) => ({ rel: l.rel, to: l.target }),
      ),
    });
  return out;
}

/**
 * The items whose newest version links to an address, each with how it links (supports,
 * contradicts or follows), oldest link first. A link names an address as its writer gave it.
 */
export async function linksTo(q: Sql, address: string): Promise<{ rel: string; item: KbItem }[]> {
  return (
    (await q.all(
      `select l.rel as link_rel, i.* from kb_link l
         join kb_item i on i.id = l.item and i.version = l.version
         where l.target = ? order by i.at, i.id, l.rel`,
      address,
    )) as Record<string, unknown>[]
  ).map((r) => ({ rel: String(r.link_rel), item: itemOf(r) }));
}

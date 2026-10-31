import type { DatabaseSync } from "node:sqlite";
import {
  KB_RECORDS,
  type KbItemBody,
  type KbItemFile,
  type KbKind,
  KbOutcome,
  writtenRef,
} from "../../../core/kb.ts";
import { str } from "../../../core/kb-index.ts";
import type { KbItem } from "../../kb/index.ts";
import {
  campaignAbout,
  contextOf,
  followAttempt,
  indexItem,
  outcomeFor,
  unindexItem,
} from "./words.ts";

/**
 * Items and their versions in control's knowledge base (goal 175): the one place that writes them,
 * for Thermite's code's records (store/kb/index.ts, from the reading of the runs' events) and for
 * a writer's `kb_item` event (writeItem). A new version keeps every older one (kb_version, which
 * refuses a change or a removal); the item's row holds its newest, with its outcome and context,
 * and the words index follows in the same transaction (words.ts).
 */

/** Where an item is: its collection (campaign), its rig ledger and run, its slot, kind and id. */
export interface ItemPlace {
  campaign: string;
  rig: string;
  ledger: string;
  run: string;
  slot: string;
  kind: string;
  ref: string;
}

/** One version's words, as the item's row and its version keep them (meta as JSON). */
export interface VersionFields {
  title: string;
  body: string;
  by: string;
  url: string | null;
  sub: string | null;
  meta: string;
  file?: KbItemFile | undefined;
  /** A file's text, once control extracted it: the item's row holds it for the words index. */
  fileText?: string | undefined;
}

/**
 * A new item at `place`, or a new version of the one there, with its links: the item's row holds
 * the newest version, with a new seq (the rigs' syncs read after it); every version, the newest
 * too, is kept in kb_version. `event`: the kb_item event that wrote it. A file item's row holds
 * its file's text, when control has it, for the words index; its version keeps its writer's words.
 * Returns the item's id and its version. In the caller's transaction.
 */
export function keepVersion(
  db: DatabaseSync,
  seq: number,
  place: ItemPlace,
  v: VersionFields,
  o: { at: string; event?: number | undefined; links?: readonly { rel: string; to: string }[] },
): { id: number; version: number } {
  const { campaign, rig, ledger, run, slot, kind, ref } = place;
  const f = v.file;
  const had = db
    .prepare(
      "select id, version from kb_item where rig = ? and ledger = ? and run = ? and slot = ? and kind = ? and ref = ?",
    )
    .get(rig, ledger, run, slot, kind, ref) as { id: number; version: number } | undefined;
  const file = [f?.sha256 ?? null, f?.name ?? null, f?.type ?? null, f?.bytes ?? null] as const;
  const indexed = f ? (v.fileText ?? "") : v.body;
  // Its outcome and context come from Thermite's own records (words.ts), with each version.
  const outcome = outcomeFor(db, place, v.meta);
  const about = campaignAbout(db, campaign);
  const context = contextOf(place, { outcome, sub: v.sub, about });
  let id: number;
  let version: number;
  if (had) {
    id = Number(had.id);
    version = Number(had.version) + 1;
    unindexItem(db, id);
    db.prepare(
      `update kb_item set seq = ?, version = ?, title = ?, body = ?, by = ?, url = ?, sub = ?, meta = ?,
         file_sha256 = ?, file_name = ?, file_type = ?, file_bytes = ?, updated_at = ?, outcome = ?,
         context = ? where id = ?`,
    ).run(
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
    id = Number(
      db
        .prepare(
          `insert into kb_item (seq, campaign, rig, ledger, run, slot, kind, ref, version, title, body,
             by, url, sub, meta, file_sha256, file_name, file_type, file_bytes, at, updated_at,
             outcome, context)
           values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        ).lastInsertRowid,
    );
  }
  indexItem(db, id, indexed);
  // A recorded attempt's outcome is its experiment's too.
  if (kind === "attempt" && slot === KB_RECORDS) followAttempt(db, place, ref, outcome);
  db.prepare(
    `insert into kb_version (item, version, title, body, by, url, sub, meta, file_sha256,
       file_name, file_type, file_bytes, event, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, version, v.title, v.body, v.by, v.url, v.sub, v.meta, ...file, o.event ?? null, o.at);
  const link = db.prepare(
    "insert or ignore into kb_link (item, version, rel, target) values (?, ?, ?, ?)",
  );
  for (const l of o.links ?? []) link.run(id, version, l.rel, l.to);
  return { id, version };
}

/**
 * Whether a writer's `kb_item` event may go in: a new item takes a number its slot has not used,
 * and a new version is the next one of the writer's own item, of the same kind. Its words if not.
 * The writer's slot was checked against the event's writer first (control/events/knowledge.ts).
 */
export function versionRefusal(
  db: DatabaseSync,
  src: { rig: string; ledger: string; run: string },
  b: KbItemBody,
): string | undefined {
  const had = db
    .prepare(
      "select kind, version from kb_item where rig = ? and ledger = ? and run = ? and slot = ? and ref = ?",
    )
    .get(src.rig, src.ledger, src.run, b.slot, writtenRef(b.slot, b.item)) as
    | { kind: string; version: number }
    | undefined;
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

/** One version of an item, as kept, with its links. */
export interface KbVersion {
  version: number;
  title: string;
  body: string;
  /** Who wrote it, as its item's `by`. */
  by: string;
  file_sha256: string | null;
  /** Its file, by its SHA-256; null for a blurb or a record. */
  file: KbItemFile | null;
  /** The kb_item event that wrote it; null for a record. */
  event: number | null;
  at: string;
  links: { rel: string; to: string }[];
}

/** Every version of an item, oldest first, each with its links. */
export function versionsOf(db: DatabaseSync, id: number): KbVersion[] {
  const rows = db
    .prepare(
      `select version, title, body, by, file_sha256, file_name, file_type, file_bytes, event, at
       from kb_version where item = ? order by version`,
    )
    .all(id) as Record<string, string | number | null>[];
  const links = db.prepare(
    "select rel, target from kb_link where item = ? and version = ? order by rel, target",
  );
  return rows.map((r) => ({
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
    links: (links.all(id, Number(r.version)) as { rel: string; target: string }[]).map((l) => ({
      rel: l.rel,
      to: l.target,
    })),
  }));
}

/**
 * The items whose newest version links to an address, each with how it links (supports,
 * contradicts or follows), oldest link first. A link names an address as its writer gave it.
 */
export function linksTo(db: DatabaseSync, address: string): { rel: string; item: KbItem }[] {
  return (
    db
      .prepare(
        `select l.rel as link_rel, i.* from kb_link l
         join kb_item i on i.id = l.item and i.version = l.version
         where l.target = ? order by i.at, i.id, l.rel`,
      )
      .all(address) as Record<string, unknown>[]
  ).map((r) => ({ rel: String(r.link_rel), item: itemOf(r) }));
}

/** A writer's item as its version's words: a blurb's text, or a file's name, type and size. */
export function writtenFields(b: KbItemBody): VersionFields {
  return {
    title: b.title,
    body: b.text ?? "",
    by: b.slot,
    url: null,
    sub: null,
    meta: "{}",
    file: b.file,
  };
}

/** An item as control's store keeps its row: its newest version, with its place, outcome and file. */
export function itemOf(r: Record<string, unknown>): KbItem {
  let meta: Record<string, string> = {};
  try {
    const m = JSON.parse(str(r.meta) || "{}") as Record<string, unknown>;
    meta = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, str(v)] as const)) as Record<
      string,
      string
    >;
  } catch {
    // meta is written by this module as JSON; anything else reads as none
  }
  return {
    id: Number(r.id),
    seq: Number(r.seq),
    campaign: str(r.campaign),
    rig: str(r.rig),
    ledger: str(r.ledger),
    run: str(r.run),
    slot: str(r.slot) || KB_RECORDS,
    kind: str(r.kind) as KbKind,
    ref: str(r.ref),
    version: Number(r.version ?? 1),
    title: str(r.title),
    body: str(r.body),
    by: str(r.by),
    url: r.url ? str(r.url) : null,
    sub: r.sub ? str(r.sub) : null,
    meta,
    outcome: KbOutcome.safeParse(r.outcome).data ?? null,
    file: r.file_sha256
      ? {
          sha256: str(r.file_sha256),
          name: str(r.file_name),
          type: str(r.file_type),
          bytes: Number(r.file_bytes ?? 0),
        }
      : null,
    at: str(r.at),
    updated_at: str(r.updated_at),
  };
}

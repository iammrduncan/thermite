import type { DatabaseSync } from "node:sqlite";
import { kbAddress } from "../../../core/kb.ts";
import { itemOf } from "./items.ts";

type Row = Record<string, unknown>;

/**
 * What the knowledge base stores, from its own tables (goal 176, What's stored): each collection's
 * items by type, its older versions, the bytes its versions' text and its files take, the words
 * index, the largest files and the file types, and the newest insert and file control stored.
 * Bytes are counted as the info pane counts them (list.ts, placeTotals): every version's text,
 * and each file control holds once, by its SHA-256.
 */

/** One collection's figures. */
export interface KbStoredCollection {
  campaign: string;
  records: number;
  blurbs: number;
  files: number;
  /** The files its versions name that control holds, each once. */
  file_bytes: number;
  older_versions: number;
  /** Every version's text, and file_bytes. */
  stored_bytes: number;
}

/** A file item, by its newest version's file. */
export interface KbStoredFile {
  address: string;
  name: string;
  type: string;
  bytes: number;
  /** Its text is in the words index: control holds text for it. */
  searched: boolean;
  /** Control holds the file's bytes. */
  held: boolean;
}

export interface KbStoredFigures {
  collections: KbStoredCollection[];
  /** The whole knowledge base: a file two collections name is counted once. */
  all: Omit<KbStoredCollection, "campaign"> & { items: number };
  /** The items the words index holds passages of. */
  words: { items: number };
  largest: KbStoredFile[];
  /** Each file type: its files, their bytes, and how many are searched; the rest are kept whole. */
  file_types: { type: string; files: number; bytes: number; searched: number }[];
  /** The newest version a writer's `kb_item` event stored, and the newest file control kept. */
  last_item: { address: string; version: number; at: string } | null;
  last_file: { sha256: string; bytes: number; at: string } | null;
}

/** How many of the largest files it names. */
export const KB_STORED_FILES = 10;

/** An item's type in SQL, as kbItemType (core/kb.ts) says it. */
const TYPE_SQL =
  "(case when i.file_sha256 is not null then 'file' when i.slot = 'records' then 'record' else 'blurb' end)";

export function storedFigures(db: DatabaseSync): KbStoredFigures {
  const rows = (sql: string) => db.prepare(sql).all() as Row[];
  const by = (sql: string) => new Map(rows(sql).map((r) => [String(r.c), Number(r.n ?? 0)]));
  const types = rows(
    `select i.campaign as c, ${TYPE_SQL} as t, count(*) as n from kb_item i group by 1, 2`,
  );
  const versions = "kb_version v join kb_item i on i.id = v.item";
  const older = by(
    `select i.campaign as c, count(*) as n from ${versions} where v.version < i.version group by 1`,
  );
  const text = by(
    `select i.campaign as c, coalesce(sum(length(cast(v.body as blob))), 0) as n from ${versions} group by 1`,
  );
  const fileBytes = by(
    `select c, sum(bytes) as n from (select distinct i.campaign as c, f.sha256, f.bytes
       from ${versions} join kb_file f on f.sha256 = v.file_sha256) group by c`,
  );
  const typeOf = (c: string, t: string) =>
    types.filter((r) => String(r.c) === c && r.t === t).reduce((n, r) => n + Number(r.n), 0);
  const collections = rows("select campaign as c from kb_collection order by campaign").map((r) => {
    const c = String(r.c);
    const file_bytes = fileBytes.get(c) ?? 0;
    return {
      campaign: c,
      records: typeOf(c, "record"),
      blurbs: typeOf(c, "blurb"),
      files: typeOf(c, "file"),
      file_bytes,
      older_versions: older.get(c) ?? 0,
      stored_bytes: (text.get(c) ?? 0) + file_bytes,
    };
  });
  const one = (sql: string) => Number((db.prepare(sql).get() as Row).n ?? 0);
  const allFiles = one(
    `select coalesce(sum(bytes), 0) as n from kb_file
     where sha256 in (select file_sha256 from kb_version where file_sha256 is not null)`,
  );
  const total = (t: string) => types.filter((r) => r.t === t).reduce((n, r) => n + Number(r.n), 0);
  const all = {
    items: one("select count(*) as n from kb_item"),
    records: total("record"),
    blurbs: total("blurb"),
    files: total("file"),
    file_bytes: allFiles,
    older_versions: one(`select count(*) as n from ${versions} where v.version < i.version`),
    stored_bytes:
      one("select coalesce(sum(length(cast(body as blob))), 0) as n from kb_version") + allFiles,
  };
  const largest = (
    db
      .prepare(
        `select i.*, f.sha256 is not null as held from kb_item i
         left join kb_file f on f.sha256 = i.file_sha256
         where i.file_sha256 is not null order by i.file_bytes desc, i.id limit ?`,
      )
      .all(KB_STORED_FILES) as Row[]
  ).map((r) => ({
    address: kbAddress(itemOf(r)),
    name: String(r.file_name ?? ""),
    type: String(r.file_type ?? ""),
    bytes: Number(r.file_bytes ?? 0),
    searched: String(r.body ?? "") !== "",
    held: Number(r.held) === 1,
  }));
  const file_types = rows(
    `select file_type as t, count(*) as n, coalesce(sum(file_bytes), 0) as b,
       sum(case when body != '' then 1 else 0 end) as s
     from kb_item where file_sha256 is not null group by file_type order by b desc, t`,
  ).map((r) => ({
    type: String(r.t ?? ""),
    files: Number(r.n),
    bytes: Number(r.b),
    searched: Number(r.s ?? 0),
  }));
  const last = db
    .prepare(
      `select i.*, v.version as v_version, v.at as v_at from ${versions}
       where v.event is not null order by v.at desc, v.item desc, v.version desc limit 1`,
    )
    .get() as Row | undefined;
  const file = db
    .prepare("select sha256, bytes, stored_at from kb_file order by stored_at desc, sha256 limit 1")
    .get() as Row | undefined;
  return {
    collections,
    all,
    words: { items: one("select count(distinct item) as n from kb_passage") },
    largest,
    file_types,
    last_item: last
      ? { address: kbAddress(itemOf(last)), version: Number(last.v_version), at: String(last.v_at) }
      : null,
    last_file: file
      ? { sha256: String(file.sha256), bytes: Number(file.bytes), at: String(file.stored_at) }
      : null,
  };
}

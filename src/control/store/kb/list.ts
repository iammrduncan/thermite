import type { DatabaseSync } from "node:sqlite";
import { KB_OUTCOMES, type KbItemType, type KbListSort } from "../../../core/kb.ts";
import type { KbItem } from "../../kb/index.ts";
import { itemOf } from "./items.ts";

/**
 * What one place of control's knowledge base holds (goal 176): the whole knowledge base, a
 * collection, a run of it, or a run's slot. Its folders are the collections, runs or slots in it,
 * each with how many items it holds and its newest change. Its items are every item under it, at
 * any depth, kept by kind, outcome, type and slot (in each, an item matches any value given; one
 * given none keeps all), sorted, and paged with no end to how deep a page starts.
 */

/** A place: nothing for the whole knowledge base, or a collection, a run of it, a slot of that. */
export interface KbListAt {
  campaign?: string | undefined;
  run?: string | undefined;
  slot?: string | undefined;
}

/** A collection, run or slot in a place, with its items, its newest change and, for a run, fresh. */
export interface KbFolderRow {
  name: string;
  items: number;
  /** Its newest item's last change; null when it holds none. */
  updated_at: string | null;
  /** A run that started fresh: its agents read only its own items. False for the others. */
  fresh: boolean;
}

export interface KbListOptions {
  kinds?: readonly string[] | undefined;
  outcomes?: readonly string[] | undefined;
  types?: readonly KbItemType[] | undefined;
  slots?: readonly string[] | undefined;
  /** modified when not given. */
  sort?: KbListSort | undefined;
  /** desc for modified and size when not given, asc for the others. */
  order?: "asc" | "desc" | undefined;
  offset?: number | undefined;
  /** How many items the page holds; 0 gives none, but still counts them. */
  limit: number;
}

/** The counts of the items under a place by each filter, each kept by the other filters only. */
export interface KbListCounts {
  kind: Record<string, number>;
  outcome: Record<string, number>;
  type: Record<string, number>;
  slot: Record<string, number>;
}

export interface KbListed {
  /** Every item under the place. */
  total: number;
  /** Those the filters keep; `items` holds a page of them. */
  matched: number;
  counts: KbListCounts;
  items: KbItem[];
}

type Sql = { sql: string; args: string[] };
type Row = Record<string, unknown>;

/** An item's type in SQL, as kbItemType (core/kb.ts) says it. */
const TYPE_SQL =
  "(case when file_sha256 is not null then 'file' when slot = 'records' then 'record' else 'blurb' end)";
/** Each filter's column, by its name in the counts. */
const FILTERS: Record<keyof KbListCounts, string> = {
  kind: "kind",
  outcome: "outcome",
  type: TYPE_SQL,
  slot: "slot",
};
/** The outcomes in their order (won first), and an item with none after them. */
const OUTCOME_RANK = `(case outcome ${KB_OUTCOMES.map((o, i) => `when '${o}' then ${i}`).join(" ")} else ${KB_OUTCOMES.length} end)`;
const SORTS: Record<KbListSort, string> = {
  name: "title collate nocase",
  kind: "kind",
  outcome: OUTCOME_RANK,
  writer: "slot",
  modified: "updated_at",
  size: "coalesce(file_bytes, -1)",
};

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The SQL that keeps the items under a place, of kb_item as `alias` when given. */
function under(at: KbListAt, alias = ""): Sql {
  const parts: string[] = [];
  const args: string[] = [];
  for (const [column, v] of [
    ["campaign", at.campaign],
    ["run", at.run],
    ["slot", at.slot],
  ] as const) {
    if (v === undefined) break;
    parts.push(`${alias ? `${alias}.` : ""}${column} = ?`);
    args.push(v);
  }
  return { sql: parts.length ? parts.join(" and ") : "1 = 1", args };
}

/** The filters as SQL, but the one named `but`, which its own counts leave out. */
function kept(o: KbListOptions, but?: keyof KbListCounts): Sql {
  const given: Record<keyof KbListCounts, readonly string[] | undefined> = {
    kind: o.kinds,
    outcome: o.outcomes,
    type: o.types,
    slot: o.slots,
  };
  const parts: string[] = [];
  const args: string[] = [];
  for (const [name, values] of Object.entries(given) as [keyof KbListCounts, string[]][]) {
    if (name === but || !values?.length) continue;
    parts.push(` and ${FILTERS[name]} in (${marks(values.length)})`);
    args.push(...values);
  }
  return { sql: parts.join(""), args };
}

/** A page of the items under a place, with how many there are and their counts by filter. */
export function listItems(db: DatabaseSync, at: KbListAt, o: KbListOptions): KbListed {
  const w = under(at);
  const k = kept(o);
  const count = (s: Sql) =>
    Number(
      (db.prepare(`select count(*) as n from kb_item where ${s.sql}`).get(...s.args) as Row).n,
    );
  const total = count(w);
  const matched = k.args.length
    ? count({ sql: `${w.sql}${k.sql}`, args: [...w.args, ...k.args] })
    : total;
  const counts: KbListCounts = { kind: {}, outcome: {}, type: {}, slot: {} };
  for (const name of Object.keys(FILTERS) as (keyof KbListCounts)[]) {
    const others = kept(o, name);
    const rows = db
      .prepare(
        `select ${FILTERS[name]} as v, count(*) as n from kb_item
         where ${w.sql}${others.sql} and ${FILTERS[name]} is not null group by v order by n desc, v`,
      )
      .all(...w.args, ...others.args) as Row[];
    for (const r of rows) counts[name][String(r.v)] = Number(r.n);
  }
  const sort = o.sort ?? "modified";
  const order = o.order ?? (sort === "modified" || sort === "size" ? "desc" : "asc");
  const items =
    o.limit > 0
      ? (
          db
            .prepare(
              `select * from kb_item where ${w.sql}${k.sql}
               order by ${SORTS[sort]} ${order}, updated_at desc, id desc limit ? offset ?`,
            )
            .all(...w.args, ...k.args, o.limit, o.offset ?? 0) as Row[]
        ).map(itemOf)
      : [];
  return { total, matched, counts, items };
}

/** What a place holds in all: its items by type, kind and slot, older versions, and bytes stored. */
export interface KbTotals {
  types: Record<string, number>;
  kinds: Record<string, number>;
  slots: Record<string, number>;
  /** The versions kept before each item's newest. */
  older_versions: number;
  /** Every version's text, and each file control holds once, in bytes. */
  stored_bytes: number;
}

/** A place's totals (KbTotals), of every item under it. */
export function placeTotals(db: DatabaseSync, at: KbListAt): KbTotals {
  const w = under(at);
  const grouped = (column: string) =>
    Object.fromEntries(
      (
        db
          .prepare(
            `select ${column} as v, count(*) as n from kb_item where ${w.sql} group by v order by n desc, v`,
          )
          .all(...w.args) as Row[]
      ).map((r) => [String(r.v), Number(r.n)]),
    );
  const versions = `kb_version v join kb_item i on i.id = v.item where ${under(at, "i").sql}`;
  const one = (sql: string) => Number((db.prepare(sql).get(...w.args) as Row).n);
  return {
    types: grouped(TYPE_SQL),
    kinds: grouped("kind"),
    slots: grouped("slot"),
    older_versions: one(`select count(*) as n from ${versions} and v.version < i.version`),
    stored_bytes:
      one(`select coalesce(sum(length(cast(v.body as blob))), 0) as n from ${versions}`) +
      one(
        `select coalesce(sum(f.bytes), 0) as n from kb_file f where f.sha256 in (
           select v.file_sha256 from ${versions} and v.file_sha256 is not null)`,
      ),
  };
}

/** The collections, runs or slots a place holds, in no order; none in a slot. */
export function placeFolders(db: DatabaseSync, at: KbListAt): KbFolderRow[] {
  const rows = (sql: string, ...args: string[]) =>
    (db.prepare(sql).all(...args) as Row[]).map((r) => ({
      name: String(r.name),
      items: Number(r.n),
      updated_at: r.at ? String(r.at) : null,
      fresh: Number(r.fresh ?? 0) === 1,
    }));
  if (at.campaign === undefined)
    return rows(
      `select c.campaign as name, count(i.id) as n, max(i.updated_at) as at from (
         select campaign from kb_collection union select campaign from kb_item
         union select campaign from kb_run) c
       left join kb_item i on i.campaign = c.campaign group by c.campaign`,
    );
  if (at.run === undefined)
    return rows(
      `select r.run as name, count(i.id) as n, max(i.updated_at) as at, max(s.fresh) as fresh from (
         select run from kb_run where campaign = ?1 union select run from kb_item where campaign = ?1) r
       left join kb_item i on i.campaign = ?1 and i.run = r.run
       left join kb_scope s on s.campaign = ?1 and s.run = r.run
       group by r.run`,
      at.campaign,
    );
  if (at.slot === undefined)
    return rows(
      `select slot as name, count(*) as n, max(updated_at) as at from kb_item
       where campaign = ? and run = ? group by slot`,
      at.campaign,
      at.run,
    );
  return [];
}

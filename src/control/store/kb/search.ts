import type { DatabaseSync } from "node:sqlite";
import {
  type FoundPassage,
  type FoundRow,
  findWords,
  itemsMatching,
  type ScopeSql,
  textStart,
  type WordsFound,
} from "../../../common/search/index.ts";
import { KB_COLUMN_EXAMPLE, type KbSearchMode, OUTCOME_WORDS } from "./query.ts";
import { KB_WORDS } from "./words.ts";

/**
 * Search by words in control's knowledge base (goal 175), with the search engine (common/search/)
 * over the knowledge base's words index (words.ts: passages of the items' newest versions, each
 * with its item's title and a context Thermite writes): ranked by BM25, each hit with its excerpt,
 * why it matched and its passage; several queries fused; "more like this". Every search reads only
 * where it is told (whole collections, or one run's items of a collection), keeps only the kinds,
 * outcomes, runs, slots and collections it is given, and says, with its hits, how many items
 * matched, where its words land (by kind, outcome, run, slot and collection), how many items hold
 * each word, and words close to a word none holds. A forgiving search's outcome words also find
 * the words the records say them with (query.ts). No words: the newest items.
 */

/** Where a search reads: a campaign's whole collection, or only one run's items of it. */
export interface KbWhere {
  campaign: string;
  run?: string | undefined;
}

export interface KbFindOptions {
  /** Its queries; several are fused (RRF). Only empty ones, and no `like`: the newest items. */
  queries: readonly string[];
  /** How the queries are read (query.ts): words (the default) or exact, FTS5's own syntax. */
  mode?: KbSearchMode | undefined;
  /** An item, by its id, to find more like: its own words are one more query, and it is left out. */
  like?: { id: number; title: string; body: string } | undefined;
  kinds?: readonly string[] | undefined;
  /** For notes: their sub-kinds (observation, decision, …). */
  sub?: readonly string[] | undefined;
  outcomes?: readonly string[] | undefined;
  runs?: readonly string[] | undefined;
  slots?: readonly string[] | undefined;
  collections?: readonly string[] | undefined;
  /** Only items of these types: record, blurb or file (core/kb/items.ts, kbItemType). */
  types?: readonly string[] | undefined;
  /** Items left out, by id: those the caller has seen already. */
  seen?: readonly number[] | undefined;
  offset?: number | undefined;
  limit: number;
}

/**
 * A search as the knowledge base takes it (store/kb/index.ts): `like` and `seen` by the items'
 * addresses, which it finds within the search's scope; `limit` 50 when not given.
 */
export type KbFind = Omit<KbFindOptions, "queries" | "like" | "seen" | "limit"> & {
  like?: string | undefined;
  seen?: readonly string[] | undefined;
  limit?: number | undefined;
};

/** Where a search's words land: how many items of its scope they match, by each field. */
export interface KbCounts {
  kind: Record<string, number>;
  outcome: Record<string, number>;
  run: Record<string, number>;
  slot: Record<string, number>;
  collection: Record<string, number>;
}

/** Where a hit's best passage is in its item's text: its place, of how many, and its characters. */
export type KbPassage = FoundPassage;

/** What a search of the knowledge base answers: the engine's, with where its words land. */
export type KbFindResult = WordsFound & { counts: KbCounts };

/** What the knowledge base's context holds, for why. */
export const CONTEXT_WORDS = "its context (kind, outcome, slot, run, campaign)";
/** How many runs and slots the counts name at most: the rest are summed under "other". */
const COUNTED_MAX = 20;

/** An item's type in SQL on `i`, as kbItemType (core/kb/items.ts) says it. */
export const ITEM_TYPE =
  "(case when i.file_sha256 is not null then 'file' when i.slot = 'records' then 'record' else 'blurb' end)";

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The SQL that keeps an item of table `i` within `where`, with its values. */
function within(where: readonly KbWhere[]): ScopeSql {
  const parts = where.map((w) => (w.run ? "(i.campaign = ? and i.run = ?)" : "i.campaign = ?"));
  return {
    sql: `(${parts.join(" or ")})`,
    args: where.flatMap((w) => (w.run ? [w.campaign, w.run] : [w.campaign])),
  };
}

/** What a search keeps of its scope: its filters and what it leaves out, as SQL on `i`. */
function kept(o: KbFindOptions): ScopeSql {
  const parts: string[] = [];
  const args: string[] = [];
  const keep = (column: string, values: readonly (string | number)[] | undefined, not = false) => {
    if (!values?.length) return;
    parts.push(`i.${column} ${not ? "not in" : "in"} (${marks(values.length)})`);
    args.push(...values.map(String));
  };
  keep("kind", o.kinds);
  keep("sub", o.sub);
  keep("outcome", o.outcomes);
  keep("run", o.runs);
  keep("slot", o.slots);
  keep("campaign", o.collections);
  if (o.types?.length) {
    parts.push(`${ITEM_TYPE} in (${marks(o.types.length)})`);
    args.push(...o.types);
  }
  keep("id", [...(o.seen ?? []), ...(o.like ? [o.like.id] : [])], true);
  return { sql: parts.map((s) => ` and ${s}`).join(""), args };
}

/** Whether a grouped row of the counts passes the search's filters. */
function passes(o: KbFindOptions, r: Record<string, unknown>): boolean {
  const ok = (values: readonly string[] | undefined, v: unknown) =>
    !values?.length || values.includes(String(v ?? ""));
  return (
    ok(o.kinds, r.kind) &&
    ok(o.outcomes, r.outcome) &&
    ok(o.runs, r.run) &&
    ok(o.slots, r.slot) &&
    ok(o.collections, r.campaign)
  );
}

/** The counts from rows grouped by campaign, run, slot, kind and outcome, each with its items. */
export function countsOf(rows: Record<string, unknown>[]): KbCounts {
  const out: KbCounts = { kind: {}, outcome: {}, run: {}, slot: {}, collection: {} };
  const add = (m: Record<string, number>, k: unknown, n: number) => {
    const key = String(k ?? "");
    if (key) m[key] = (m[key] ?? 0) + n;
  };
  for (const r of rows) {
    const n = Number(r.n);
    add(out.kind, r.kind, n);
    add(out.outcome, r.outcome, n);
    add(out.run, r.run, n);
    add(out.slot, r.slot, n);
    add(out.collection, r.campaign, n);
  }
  // The most common first; past COUNTED_MAX, the rest in one count.
  const top = (m: Record<string, number>) => {
    const sorted = Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const rest = sorted.slice(COUNTED_MAX).reduce((s, [, n]) => s + n, 0);
    return Object.fromEntries([
      ...sorted.slice(0, COUNTED_MAX),
      ...(rest ? [["other", rest]] : []),
    ]);
  };
  return {
    kind: top(out.kind),
    outcome: top(out.outcome),
    run: top(out.run),
    slot: top(out.slot),
    collection: top(out.collection),
  };
}

/**
 * Items within `where` that the search's queries match, best first, a page of `limit` from
 * `offset`, with how many matched in all, where its words land, how many items hold each word,
 * and words close to those none holds. An exact query FTS5 can't read: why, in words (`refused`).
 */
export function findItems(
  db: DatabaseSync,
  where: readonly KbWhere[],
  o: KbFindOptions,
): KbFindResult {
  const offset = o.offset ?? 0;
  const empty: KbFindResult = {
    matched: 0,
    next_offset: null,
    counts: countsOf([]),
    words: [],
    did_you_mean: [],
    found: [],
  };
  if (!where.length) return empty;
  const w = within(where);
  const k = kept(o);
  const scope = { sql: `${w.sql}${k.sql}`, args: [...w.args, ...k.args] };
  // Where the words land, read with the count of the items they match.
  let groups: Record<string, unknown>[] = [];
  const count = (all: string) => {
    groups = db
      .prepare(
        `select i.campaign as campaign, i.run as run, i.slot as slot, i.kind as kind, i.outcome as outcome,
           count(distinct i.id) as n
         from kb_words join kb_passage p on p.id = kb_words.rowid join kb_item i on i.id = p.item
         where kb_words match ? and ${w.sql} group by 1, 2, 3, 4, 5`,
      )
      .all(all, ...w.args) as Record<string, unknown>[];
    // The counts' groups know no type: a search that keeps some types counts its items.
    const left = o.seen?.length || o.like || o.sub?.length || o.types?.length;
    return left
      ? itemsMatching(db, KB_WORDS, all, scope)
      : groups.filter((r) => passes(o, r)).reduce((s, r) => s + Number(r.n), 0);
  };
  const r = findWords(db, KB_WORDS, {
    queries: o.queries,
    mode: o.mode,
    like: o.like,
    also: OUTCOME_WORDS,
    scope,
    within: w,
    offset,
    limit: o.limit,
    count,
    context: CONTEXT_WORDS,
    columnExample: KB_COLUMN_EXAMPLE,
  });
  if (r) return { ...r, counts: r.refused ? countsOf([]) : countsOf(groups) };
  if (o.like) return { ...empty, like: [] };
  return newest(db, w, k, o, offset);
}

/** No words: the newest items within the scope, newest change first, with their counts. */
function newest(
  db: DatabaseSync,
  w: ScopeSql,
  k: ScopeSql,
  o: KbFindOptions,
  offset: number,
): KbFindResult {
  const groups = db
    .prepare(
      `select i.campaign as campaign, i.run as run, i.slot as slot, i.kind as kind, i.outcome as outcome,
         count(*) as n from kb_item i where ${w.sql} group by 1, 2, 3, 4, 5`,
    )
    .all(...w.args) as Record<string, unknown>[];
  const count = db
    .prepare(`select count(*) as n from kb_item i where ${w.sql}${k.sql}`)
    .get(...w.args, ...k.args) as { n: number };
  const rows = db
    .prepare(
      `select i.* from kb_item i where ${w.sql}${k.sql} order by i.updated_at desc, i.seq desc limit ? offset ?`,
    )
    .all(...w.args, ...k.args, o.limit, offset) as Record<string, unknown>[];
  const matched = Number(count.n);
  return {
    matched,
    next_offset: offset + o.limit < matched ? offset + o.limit : null,
    counts: countsOf(groups),
    words: [],
    did_you_mean: [],
    found: rows.map(
      (row): FoundRow => ({
        row,
        excerpt: textStart(String(row.body ?? "")),
        why: "",
        passage: null,
      }),
    ),
  };
}

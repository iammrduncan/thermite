import type { DatabaseSync } from "node:sqlite";
import {
  EXACT_SYNTAX,
  exactWords,
  forgivingQuery,
  KB_TERMS_MAX,
  type KbSearchMode,
  phrase,
  searchTerms,
} from "./query.ts";
import {
  didYouMean,
  itemsMatching,
  likeQuery,
  marked,
  type ScopeSql,
  WORD_ITEMS_MAX,
} from "./vocab.ts";
import { passagesOf } from "./words.ts";

/**
 * Search by words in control's knowledge base (goal 175): the words index (words.ts: FTS5 over
 * passages of the items' newest versions, each with its item's title and a context Thermite writes)
 * read with BM25, a match in the title counting three times one in the text and the context twice.
 * An item is ranked by its best passage. Each hit has an excerpt of that passage around the words
 * that matched, those words in **bold**, why it matched, and, for a long text, which passage it is
 * and where. Several queries are fused by reciprocal rank fusion (k = 60); "more like this" is one
 * more query, of an item's own words (vocab.ts). Every search reads only where it is told (whole
 * collections, or one run's items of a collection), keeps only the kinds, outcomes, runs, slots and
 * collections it is given, and says, with its hits, how many items matched, where its words land
 * (by kind, outcome, run, slot and collection), how many items hold each word, and words close to
 * a word none holds. No words: the newest items.
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
export interface KbPassage {
  n: number;
  of: number;
  from: number;
  to: number;
}

/** One item found: its row, its excerpt, why it matched, and its passage in a long text. */
export interface KbFoundRow {
  row: Record<string, unknown>;
  excerpt: string;
  why: string;
  passage: KbPassage | null;
}

export interface KbFindResult {
  /** How many items the search keeps in all; `found` holds a page of them. */
  matched: number;
  /** Where the next page starts; null when this page is the last. */
  next_offset: number | null;
  counts: KbCounts;
  /** How many items of the scope hold each of the search's words, up to WORD_ITEMS_MAX. */
  words: { word: string; items: number }[];
  /** For each word no item of the scope holds: words close to it that some do. */
  did_you_mean: { word: string; try: { word: string; items: number }[] }[];
  /** The words "more like this" searched with, when it was asked. */
  like?: string[] | undefined;
  found: KbFoundRow[];
  /** Why an exact search was not run, in words: FTS5 can't read its query. Nothing else is set. */
  refused?: string | undefined;
}

/** How many tokens an excerpt holds. */
const EXCERPT_TOKENS = 40;
/** How many characters of its text an item found by no words in its text shows. */
const NEWEST_EXCERPT = 300;
/** The weights of a match in the title, the context and the text (BM25). */
const WEIGHTS = "3.0, 2.0, 1.0";
/** Reciprocal rank fusion's constant: an item at rank r of a query adds 1 / (RRF_K + r). */
const RRF_K = 60;
/** How many of a search's words are counted, and how many no item holds get a "did you mean". */
const WORDS_COUNTED_MAX = 20;
const SUGGESTED_WORDS_MAX = 3;
/** How many runs and slots the counts name at most: the rest are summed under "other". */
const COUNTED_MAX = 20;

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
function countsOf(rows: Record<string, unknown>[]): KbCounts {
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

/** Why an item matched, in words: which words its title, its text and its context have. */
function whyWords(title: string[], text: string[], context: string[]): string {
  return [
    ...(title.length ? [`the title has ${title.join(", ")}`] : []),
    ...(text.length ? [`the text has ${text.join(", ")}`] : []),
    ...(context.length
      ? [`its context (kind, outcome, slot, run, campaign) has ${context.join(", ")}`]
      : []),
  ].join("; ");
}

/** The start of a text, for an excerpt with no word to show. */
const cut = (t: string) => (t.length > NEWEST_EXCERPT ? `${t.slice(0, NEWEST_EXCERPT)}…` : t);

/** A query's items, best first by their best passage: each item's id and that passage's id. */
function ranked(
  db: DatabaseSync,
  match: string,
  scope: ScopeSql,
  limit: number,
  offset: number,
): { id: number; pid: number }[] {
  return (
    db
      .prepare(
        // bm25() can't be read inside an aggregate: each passage's score is read first.
        `with m as materialized (
           select rowid as pid, bm25(kb_words, ${WEIGHTS}) as s from kb_words where kb_words match ?
         )
         select p.item as id, p.id as pid, min(m.s) as s, i.seq as seq
         from m join kb_passage p on p.id = m.pid join kb_item i on i.id = p.item
         where ${scope.sql} group by p.item order by s, seq desc limit ? offset ?`,
      )
      .all(match, ...scope.args, limit, offset) as { id: number; pid: number }[]
  ).map((r) => ({ id: Number(r.id), pid: Number(r.pid) }));
}

/** Lists fused by reciprocal rank fusion: each item scored by the sum of 1 / (RRF_K + its rank). */
function fused(lists: { id: number; pid: number }[][]): { id: number; pid: number }[] {
  const score = new Map<number, { s: number; pid: number; first: number }>();
  for (const l of lists)
    for (const [rank, x] of l.entries()) {
      const had = score.get(x.id);
      const add = 1 / (RRF_K + rank + 1);
      if (!had) score.set(x.id, { s: add, pid: x.pid, first: rank });
      else {
        had.s += add;
        // The passage of the query that ranked it highest.
        if (rank < had.first) Object.assign(had, { pid: x.pid, first: rank });
      }
    }
  return [...score.entries()]
    .sort((a, b) => b[1].s - a[1].s || a[0] - b[0])
    .map(([id, v]) => ({ id, pid: v.pid }));
}

/** An FTS5 error that says the query is not its syntax, rather than a fault of the store. */
const isQueryError = (err: unknown) =>
  err instanceof Error &&
  /fts5|no such column|unknown special query|unterminated/i.test(err.message);

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
  const exact = o.mode === "exact";
  const queries = o.queries.map((q) => q.trim()).filter(Boolean);
  const matches = exact
    ? queries
    : queries.map((q) => searchTerms(q)).flatMap((t) => (t.length ? [forgivingQuery(t)] : []));
  const like = o.like ? likeQuery(db, o.like.title, o.like.body) : undefined;
  if (like) matches.push(like.match);
  const page = (n: number) => (offset + o.limit < n ? offset + o.limit : null);
  if (!matches.length) {
    if (o.like) return { ...empty, like: [] };
    return newest(db, w, k, o, offset, page);
  }
  const all =
    matches.length === 1 ? (matches[0] as string) : matches.map((m) => `(${m})`).join(" OR ");
  const scope = { sql: `${w.sql}${k.sql}`, args: [...w.args, ...k.args] };
  try {
    const groups = db
      .prepare(
        `select i.campaign as campaign, i.run as run, i.slot as slot, i.kind as kind, i.outcome as outcome,
           count(distinct i.id) as n
         from kb_words join kb_passage p on p.id = kb_words.rowid join kb_item i on i.id = p.item
         where kb_words match ? and ${w.sql} group by 1, 2, 3, 4, 5`,
      )
      .all(all, ...w.args) as Record<string, unknown>[];
    const left = o.seen?.length || o.like || o.sub?.length;
    const matched = left
      ? itemsMatching(db, all, scope)
      : groups.filter((r) => passes(o, r)).reduce((s, r) => s + Number(r.n), 0);
    const best =
      matches.length === 1
        ? ranked(db, all, scope, o.limit, offset)
        : fused(matches.map((m) => ranked(db, m, scope, offset + o.limit, 0))).slice(
            offset,
            offset + o.limit,
          );
    const words = wordsOf(
      db,
      exact ? queries.flatMap(exactWords) : queries.flatMap(searchTerms),
      w,
    );
    const didYouMeanWords = words
      .filter((x) => x.items === 0)
      .slice(0, SUGGESTED_WORDS_MAX)
      .map((x) => ({ word: x.word, try: didYouMean(db, x.word, w) }))
      .filter((x) => x.try.length);
    return {
      matched,
      next_offset: page(matched),
      counts: countsOf(groups),
      words,
      did_you_mean: didYouMeanWords,
      ...(like ? { like: like.words } : {}),
      found: hitsOf(db, all, best),
    };
  } catch (err) {
    if (!exact || !isQueryError(err)) throw err;
    const why = err instanceof Error ? err.message : String(err);
    return {
      ...empty,
      refused: `the exact search is not ${EXACT_SYNTAX} (SQLite said: ${why}). Mend it, or search with mode words, which takes any words`,
    };
  }
}

/**
 * How many items of the scope hold each word, each once, at most WORDS_COUNTED_MAX words, each
 * counted up to WORD_ITEMS_MAX.
 */
function wordsOf(
  db: DatabaseSync,
  words: readonly string[],
  w: ScopeSql,
): { word: string; items: number }[] {
  return [...new Set(words)]
    .slice(0, Math.min(WORDS_COUNTED_MAX, KB_TERMS_MAX * 2))
    .map((word) => ({ word, items: itemsMatching(db, phrase(word), w, WORD_ITEMS_MAX) }));
}

/** The hits of a page: each item's row, with its best passage's excerpt, why and place. */
function hitsOf(
  db: DatabaseSync,
  match: string,
  best: { id: number; pid: number }[],
): KbFoundRow[] {
  if (!best.length) return [];
  const rows = new Map(
    (
      db
        .prepare(`select * from kb_item where id in (${marks(best.length)})`)
        .all(...best.map((b) => b.id)) as Record<string, unknown>[]
    ).map((r) => [Number(r.id), r]),
  );
  // The excerpts and the words each matched, for the hits' passages alone: snippet() and
  // highlight() read the match, so they are asked again for these passages only.
  const shown = new Map(
    (
      db
        .prepare(
          `select kb_words.rowid as pid, p.n as n,
             snippet(kb_words, 2, '**', '**', '…', ${EXCERPT_TOKENS}) as body_part,
             snippet(kb_words, 0, '**', '**', '…', ${EXCERPT_TOKENS}) as title_part,
             highlight(kb_words, 0, char(1), char(2)) as title_marked,
             highlight(kb_words, 1, char(1), char(2)) as context_marked,
             highlight(kb_words, 2, char(1), char(2)) as body_marked
           from kb_words join kb_passage p on p.id = kb_words.rowid
           where kb_words match ? and kb_words.rowid in (${marks(best.length)})`,
        )
        .all(match, ...best.map((b) => b.pid)) as Record<string, unknown>[]
    ).map((r) => [Number(r.pid), r]),
  );
  return best.flatMap((b) => {
    const row = rows.get(b.id);
    if (!row) return [];
    const s = shown.get(b.pid) ?? {};
    const body = String(row.body ?? "");
    const parts = passagesOf(body);
    const n = Number(s.n ?? 0);
    const at = parts[n] ?? { start: 0, end: body.length };
    const inText = marked(String(s.body_marked ?? ""));
    const excerpt = inText.length
      ? String(s.body_part ?? "")
      : body
        ? cut(body.slice(at.start, at.end))
        : String(s.title_part ?? "");
    return [
      {
        row,
        excerpt,
        why: whyWords(
          marked(String(s.title_marked ?? "")),
          inText,
          marked(String(s.context_marked ?? "")),
        ),
        passage:
          parts.length > 1 ? { n: n + 1, of: parts.length, from: at.start, to: at.end } : null,
      },
    ];
  });
}

/** No words: the newest items within the scope, newest change first, with their counts. */
function newest(
  db: DatabaseSync,
  w: ScopeSql,
  k: ScopeSql,
  o: KbFindOptions,
  offset: number,
  page: (n: number) => number | null,
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
    next_offset: page(matched),
    counts: countsOf(groups),
    words: [],
    did_you_mean: [],
    found: rows.map((row) => ({
      row,
      excerpt: cut(String(row.body ?? "")),
      why: "",
      passage: null,
    })),
  };
}

import type { DatabaseSync } from "node:sqlite";
import { passagesOf, type WordsTables } from "./passages.ts";
import {
  type AlsoWords,
  anyOf,
  exactSyntax,
  exactWords,
  phrase,
  type SearchMode,
  searchTerms,
  TERMS_MAX,
} from "./query.ts";
import {
  didYouMean,
  itemsMatching,
  likeQuery,
  marked,
  type ScopeSql,
  WORD_ITEMS_MAX,
} from "./vocab.ts";

/**
 * Search by words in a words index (goal 175): FTS5 over passages of its items (passages.ts), read
 * with BM25, a match in the title counting three times one in the text and the context twice. An
 * item is ranked by its best passage. Each hit has an excerpt of that passage around the words that
 * matched, those words in **bold**, why it matched, and, for a long text, which passage it is and
 * where. Several queries are fused by reciprocal rank fusion (k = 60); "more like this" is one more
 * query, of an item's own words (vocab.ts). A search says, with its hits, how many items matched,
 * how many items hold each word, and words close to a word none holds. Control's knowledge base
 * and a rig's index of a run's own research both search this way; each gives its own scope, the
 * words its forgiving queries also find, and what its context holds.
 */

/** Where a hit's best passage is in its item's text: its place, of how many, and its characters. */
export interface FoundPassage {
  n: number;
  of: number;
  from: number;
  to: number;
}

/** One item found: its row, its excerpt, why it matched, and its passage in a long text. */
export interface FoundRow {
  row: Record<string, unknown>;
  excerpt: string;
  why: string;
  passage: FoundPassage | null;
}

/** A search, as a words index takes it. */
export interface WordsFind {
  /** Its queries; several are fused (RRF). */
  queries: readonly string[];
  /** How the queries are read (query.ts): words (the default) or exact, FTS5's own syntax. */
  mode?: SearchMode | undefined;
  /** An item to find more like: its own words are one more query. */
  like?: { title: string; body: string } | undefined;
  /** What a forgiving query's words also find (query.ts). */
  also?: AlsoWords | undefined;
  /** The items it ranks and gives: its scope with its filters. */
  scope: ScopeSql;
  /** Where its words are counted and suggested: its scope without its filters. */
  within: ScopeSql;
  offset: number;
  limit: number;
  /** How many items match in all, if the index's owner counts them its own way. */
  count?: ((match: string) => number) | undefined;
  /** What the index's context holds, for why: "its context (kind, outcome, …)". */
  context: string;
  /** A column filter that means something in this index, for the words of a refusal. */
  columnExample: string;
}

export interface WordsFound {
  /** How many items the search keeps in all; `found` holds a page of them. */
  matched: number;
  /** Where the next page starts; null when this page is the last. */
  next_offset: number | null;
  /** How many items of the scope hold each of the search's words, up to WORD_ITEMS_MAX. */
  words: { word: string; items: number }[];
  /** For each word no item of the scope holds: words close to it that some do. */
  did_you_mean: { word: string; try: { word: string; items: number }[] }[];
  /** The words "more like this" searched with, when it was asked. */
  like?: string[] | undefined;
  found: FoundRow[];
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

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Why an item matched, in words: which words its title, its text and its context have. */
function whyWords(
  title: string[],
  text: string[],
  context: string[],
  contextWords: string,
): string {
  return [
    ...(title.length ? [`the title has ${title.join(", ")}`] : []),
    ...(text.length ? [`the text has ${text.join(", ")}`] : []),
    ...(context.length ? [`${contextWords} has ${context.join(", ")}`] : []),
  ].join("; ");
}

/** The start of a text, for an excerpt with no word to show. */
export const textStart = (t: string) =>
  t.length > NEWEST_EXCERPT ? `${t.slice(0, NEWEST_EXCERPT)}…` : t;

/** A query's items, best first by their best passage: each item's id and that passage's id. */
export function rankedItems(
  db: DatabaseSync,
  t: WordsTables,
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
           select rowid as pid, bm25(${t.words}, ${WEIGHTS}) as s from ${t.words} where ${t.words} match ?
         )
         select p.item as id, p.id as pid, min(m.s) as s, i.seq as seq
         from m join ${t.passages} p on p.id = m.pid join ${t.items} i on i.id = p.item
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

/** The FTS5 queries a search asks: each of its queries as its mode reads it, then `like`'s. */
function matchesOf(
  db: DatabaseSync,
  t: WordsTables,
  o: Pick<WordsFind, "queries" | "mode" | "like" | "also">,
): { matches: string[]; queries: string[]; like?: { match: string; words: string[] } } {
  const queries = o.queries.map((q) => q.trim()).filter(Boolean);
  const matches =
    o.mode === "exact"
      ? [...queries]
      : queries.map((q) => searchTerms(q)).flatMap((x) => (x.length ? [anyOf(x, o.also)] : []));
  const like = o.like ? likeQuery(db, t, o.like.title, o.like.body) : undefined;
  if (like) matches.push(like.match);
  return { matches, queries, ...(like ? { like } : {}) };
}

/**
 * Items within the search's scope that its queries match, best first, a page of `limit` from
 * `offset`, with how many matched in all, how many items hold each word, and words close to those
 * none holds. Undefined when it has nothing to ask (no words, no `like`): its owner gives the
 * newest. An exact query FTS5 can't read: why, in words (`refused`).
 */
export function findWords(db: DatabaseSync, t: WordsTables, o: WordsFind): WordsFound | undefined {
  const exact = o.mode === "exact";
  const { matches, queries, like } = matchesOf(db, t, o);
  if (!matches.length) return undefined;
  const all =
    matches.length === 1 ? (matches[0] as string) : matches.map((m) => `(${m})`).join(" OR ");
  const page = (n: number) => (o.offset + o.limit < n ? o.offset + o.limit : null);
  try {
    const matched = o.count ? o.count(all) : itemsMatching(db, t, all, o.scope);
    const best =
      matches.length === 1
        ? rankedItems(db, t, all, o.scope, o.limit, o.offset)
        : fused(matches.map((m) => rankedItems(db, t, m, o.scope, o.offset + o.limit, 0))).slice(
            o.offset,
            o.offset + o.limit,
          );
    const words = wordsOf(
      db,
      t,
      exact ? queries.flatMap(exactWords) : queries.flatMap(searchTerms),
      o.within,
    );
    const suggested = words
      .filter((x) => x.items === 0)
      .slice(0, SUGGESTED_WORDS_MAX)
      .map((x) => ({ word: x.word, try: didYouMean(db, t, x.word, o.within) }))
      .filter((x) => x.try.length);
    return {
      matched,
      next_offset: page(matched),
      words,
      did_you_mean: suggested,
      ...(like ? { like: like.words } : {}),
      found: hitsOf(db, t, all, best, o.context),
    };
  } catch (err) {
    if (!exact || !isQueryError(err)) throw err;
    const why = err instanceof Error ? err.message : String(err);
    return {
      matched: 0,
      next_offset: null,
      words: [],
      did_you_mean: [],
      found: [],
      refused: `the exact search is not ${exactSyntax(o.columnExample)} (SQLite said: ${why}). Mend it, or search with mode words, which takes any words`,
    };
  }
}

/**
 * How many items of the scope hold each word, each once, at most WORDS_COUNTED_MAX words, each
 * counted up to WORD_ITEMS_MAX.
 */
function wordsOf(
  db: DatabaseSync,
  t: WordsTables,
  words: readonly string[],
  within: ScopeSql,
): { word: string; items: number }[] {
  return [...new Set(words)]
    .slice(0, Math.min(WORDS_COUNTED_MAX, TERMS_MAX * 2))
    .map((word) => ({ word, items: itemsMatching(db, t, phrase(word), within, WORD_ITEMS_MAX) }));
}

/** The hits of a page: each item's row, with its best passage's excerpt, why and place. */
function hitsOf(
  db: DatabaseSync,
  t: WordsTables,
  match: string,
  best: { id: number; pid: number }[],
  contextWords: string,
): FoundRow[] {
  if (!best.length) return [];
  const rows = new Map(
    (
      db
        .prepare(`select * from ${t.items} where id in (${marks(best.length)})`)
        .all(...best.map((b) => b.id)) as Record<string, unknown>[]
    ).map((r) => [Number(r.id), r]),
  );
  // The excerpts and the words each matched, for the hits' passages alone: snippet() and
  // highlight() read the match, so they are asked again for these passages only.
  const shown = new Map(
    (
      db
        .prepare(
          `select ${t.words}.rowid as pid, p.n as n,
             snippet(${t.words}, 2, '**', '**', '…', ${EXCERPT_TOKENS}) as body_part,
             snippet(${t.words}, 0, '**', '**', '…', ${EXCERPT_TOKENS}) as title_part,
             highlight(${t.words}, 0, char(1), char(2)) as title_marked,
             highlight(${t.words}, 1, char(1), char(2)) as context_marked,
             highlight(${t.words}, 2, char(1), char(2)) as body_marked
           from ${t.words} join ${t.passages} p on p.id = ${t.words}.rowid
           where ${t.words} match ? and ${t.words}.rowid in (${marks(best.length)})`,
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
        ? textStart(body.slice(at.start, at.end))
        : String(s.title_part ?? "");
    return [
      {
        row,
        excerpt,
        why: whyWords(
          marked(String(s.title_marked ?? "")),
          inText,
          marked(String(s.context_marked ?? "")),
          contextWords,
        ),
        passage:
          parts.length > 1 ? { n: n + 1, of: parts.length, from: at.start, to: at.end } : null,
      },
    ];
  });
}

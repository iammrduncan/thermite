import type { DatabaseSync } from "node:sqlite";
import { COMMON, phrase } from "./query.ts";
import { scratchWords } from "./words.ts";

/**
 * The words index's own words (goal 175): how many items of a search's scope hold each of its
 * words, "did you mean" for a word none holds, and the words that find more like one item. The
 * index keeps stems (the porter stemmer's: "regress" for "regression"), read through fts5vocab
 * (kb_words_terms); a text's stems come from a scratch index with the same tokenizer. Every count
 * and every suggestion is of the search's scope alone: a word of a collection the run may not read
 * is never told.
 */

/** SQL that keeps an item `i` within a search's scope, with its values (search.ts). */
export interface ScopeSql {
  sql: string;
  args: string[];
}

/**
 * How many items within `scope` an FTS5 query matches; counted up to `max` when it is given, so a
 * common word costs no more than a rare one.
 */
export function itemsMatching(
  db: DatabaseSync,
  match: string,
  scope: ScopeSql,
  max?: number,
): number {
  const items = `select distinct p.item from kb_words join kb_passage p on p.id = kb_words.rowid
    join kb_item i on i.id = p.item where kb_words match ? and ${scope.sql}`;
  const r = db
    .prepare(`select count(*) as n from (${items}${max ? ` limit ${Math.floor(max)}` : ""})`)
    .get(match, ...scope.args) as { n: number };
  return Number(r.n);
}

/** How far a word's items are counted: past it, a word's count says this many. */
export const WORD_ITEMS_MAX = 1_000;

/** A text's stems as the words index makes them, in the text's order. */
export function stemsOf(text: string): string[] {
  const db = scratchWords();
  try {
    db.prepare("insert into w (rowid, body) values (1, ?)").run(text);
    const rows = db.prepare("select term, offset from w_terms").all() as {
      term: string;
      offset: number;
    }[];
    return rows.sort((a, b) => a.offset - b.offset).map((r) => r.term);
  } finally {
    db.close();
  }
}

/**
 * A stem as an FTS5 query of the index's own word: the stem as a phrase where the stemmer gives it
 * back unchanged, else as a prefix (the stemmer shortens a few stems again: "acceler" to "accel").
 */
function stemQueries(stems: readonly string[]): string[] {
  const again = stemsOf(stems.join(" "));
  return stems.map((s, i) => (again[i] === s ? phrase(s) : `${phrase(s)}*`));
}

/** The edit distance between two words, or more than `max` once it is past it. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let k = 1; k <= b.length; k++)
      row[k] = Math.min(
        (prev[k] ?? 0) + 1,
        (row[k - 1] ?? 0) + 1,
        (prev[k - 1] ?? 0) + (a[i - 1] === b[k - 1] ? 0 : 1),
      );
    if (Math.min(...row) > max) return max + 1;
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

/** A word as an item holds it: the first word an FTS5 query marks in one item within `scope`. */
function asWritten(db: DatabaseSync, match: string, scope: ScopeSql): string | undefined {
  const r = db
    .prepare(
      `select highlight(kb_words, 0, char(1), char(2)) as t, highlight(kb_words, 1, char(1), char(2)) as c,
         highlight(kb_words, 2, char(1), char(2)) as b
       from kb_words join kb_passage p on p.id = kb_words.rowid join kb_item i on i.id = p.item
       where kb_words match ? and ${scope.sql} limit 1`,
    )
    .get(match, ...scope.args) as Record<string, string> | undefined;
  return [r?.t, r?.b, r?.c].flatMap((text) => marked(text ?? ""))[0];
}

/** The words highlight() marked in a text, each once, in lower case. */
export function marked(text: string): string[] {
  const out = new Set<string>();
  // Each marked word sits between the marks highlight() was given: char(1) and char(2).
  for (const part of text.split("\u0001").slice(1)) {
    const w = part.slice(0, part.indexOf("\u0002")).toLowerCase().trim();
    if (w) out.add(w);
  }
  return [...out];
}

/** How many words a "did you mean" offers for one word, at most. */
const SUGGESTED_MAX = 3;
/** How many of the index's words close to a word are checked against the scope, at most. */
const CANDIDATES_MAX = 8;

/**
 * Words the scope holds that are close to `word`, which it does not hold: the index's words with the
 * same first letter within an edit distance of 2 (1 for a short word) of its stem, those more
 * items hold first, each as an item writes it, with how many items of the scope hold it.
 */
export function didYouMean(
  db: DatabaseSync,
  word: string,
  scope: ScopeSql,
): { word: string; items: number }[] {
  const [stem] = stemsOf(word);
  if (!stem || stem.length < 3 || /^\d+$/.test(stem)) return [];
  const max = stem.length <= 5 ? 1 : 2;
  const first = stem.slice(0, 1);
  const near = (
    db
      .prepare("select term, doc from kb_words_terms where term >= ? and term <= ?")
      .all(first, `${first}￿`) as { term: string; doc: number }[]
  )
    .map((r) => ({ term: r.term, doc: Number(r.doc), d: distance(stem, r.term, max) }))
    .filter((r) => r.d > 0 && r.d <= max)
    .sort((a, b) => a.d - b.d || b.doc - a.doc)
    .slice(0, CANDIDATES_MAX);
  if (!near.length) return [];
  const queries = stemQueries(near.map((r) => r.term));
  const out: { word: string; items: number }[] = [];
  for (const q of queries) {
    if (out.length >= SUGGESTED_MAX) break;
    const items = itemsMatching(db, q, scope, WORD_ITEMS_MAX);
    if (!items) continue;
    const written = asWritten(db, q, scope);
    if (written && !out.some((o) => o.word === written)) out.push({ word: written, items });
  }
  return out;
}

/** How many of an item's words "more like this" searches with, at most, as Lucene's MoreLikeThis. */
const LIKE_TERMS = 25;
/** A word fewer passages than this hold says nothing of what is alike. */
const LIKE_MIN_DOCS = 2;

/** The stems of the common words, which "more like this" leaves out. */
let commonStems: Set<string> | undefined;

/**
 * The words that find items like one item, as Lucene's MoreLikeThis picks them: each stem of its
 * title and text scored by how often the item has it times its rarity in the whole index (1 + ln(N
 * / (df + 1)), N the passages), the best LIKE_TERMS of them; common words, single letters and words
 * in fewer than LIKE_MIN_DOCS passages left out. The FTS5 query of any of them, and the stems.
 */
export function likeQuery(
  db: DatabaseSync,
  title: string,
  body: string,
): { match: string; words: string[] } | undefined {
  commonStems ??= new Set(stemsOf([...COMMON].join(" ")));
  const tf = new Map<string, number>();
  for (const s of stemsOf(`${title}\n${body}`))
    if (s.length > 1 && !commonStems.has(s)) tf.set(s, (tf.get(s) ?? 0) + 1);
  const n = Number((db.prepare("select count(*) as n from kb_passage").get() as { n: number }).n);
  const df = db.prepare("select doc from kb_words_terms where term = ?");
  const scored: [string, number][] = [];
  for (const [term, count] of tf) {
    const docs = Number((df.get(term) as { doc: number } | undefined)?.doc ?? 0);
    if (docs < LIKE_MIN_DOCS) continue;
    scored.push([term, count * (1 + Math.log(n / (docs + 1)))]);
  }
  const words = scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LIKE_TERMS)
    .map(([term]) => term);
  if (!words.length) return undefined;
  return { match: stemQueries(words).join(" OR "), words };
}

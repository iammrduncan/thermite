import { DatabaseSync } from "node:sqlite";

/**
 * A words index's tables and passages (goal 175): FTS5 over passages of its items' texts. A text up
 * to ONE_PASSAGE_MAX characters is one passage; a longer one, such as a source read whole, is cut
 * into passages of about PASSAGE_CHARS, so a search ranks the part that matched and its hit points
 * into the text. Each passage is indexed with its item's title and context. The index's content is
 * a view that reads the passages' text out of their items, so no text is kept twice. Control's
 * knowledge base and a rig's index of a run's own research are built the same way, each on its own
 * tables (WordsTables).
 */

/**
 * The tokenizer of every words index, and of the stems a search compares with it (vocab.ts):
 * English stems over unicode61's words, which an underscore splits ("win_confirmed" is "win" and
 * "confirmed"). Keeping such words whole was measured on the needle test and lost: "win" then no
 * longer finds the records' win_confirmed.
 */
export const TOKENIZE = "porter unicode61 remove_diacritics 2";
/** The same tokenizer's words before they are stemmed. */
const UNSTEMMED = "unicode61 remove_diacritics 2";

/** About how long a passage of a long text is, in characters. */
const PASSAGE_CHARS = 2_000;
/** A text up to this long is one passage. */
const ONE_PASSAGE_MAX = 3_000;
/** How far from PASSAGE_CHARS a passage may end, to end at a paragraph, a sentence or a space. */
const CUT_SLACK = 400;

/**
 * The tables of one words index. `items` holds one row for each item, with an integer `id`, a
 * `seq` (a higher one is newer) and its `title`, `context` and `body`; the others are the index's
 * own: its passages, the view of their text, the FTS5 table and its words (fts5vocab).
 */
export interface WordsTables {
  items: string;
  passages: string;
  view: string;
  words: string;
  terms: string;
}

/** A words index's passages, view, index and words, over `t.items` (made by its owner). */
export function wordsSchema(t: WordsTables): string {
  return `
create table ${t.passages} (
  id integer primary key,
  item integer not null,
  -- Its place in its item's text: the first passage is 0.
  n integer not null,
  -- Where it is in the text, in SQLite's characters (code points), for substr().
  start integer not null,
  len integer not null
);
create index ${t.passages}_item on ${t.passages} (item, n);
create view ${t.view} as
  select p.id as id, p.item as item, i.title as title, i.context as context,
    substr(i.body, p.start + 1, p.len) as body
  from ${t.passages} p join ${t.items} i on i.id = p.item;
create virtual table ${t.words} using fts5(
  title, context, body, content = '${t.view}', content_rowid = 'id',
  tokenize = '${TOKENIZE}'
);
-- The index's words, each with how many passages hold it (vocab.ts).
create virtual table ${t.terms} using fts5vocab('${t.words}', 'row');
`;
}

/** One passage of a text: where it starts and ends, in JavaScript's characters (UTF-16 units). */
export interface Passage {
  start: number;
  end: number;
}

/** Where a passage ends: at a blank line, a sentence's end or a space near `at`, else at `at`. */
function cutAt(text: string, from: number, at: number): number {
  const lo = Math.max(from + 1, at - CUT_SLACK);
  const window = text.slice(lo, at + CUT_SLACK);
  const best = (re: RegExp): number | undefined => {
    let pick: number | undefined;
    for (const m of window.matchAll(re)) {
      const end = lo + m.index + m[0].length;
      if (pick === undefined || Math.abs(end - at) < Math.abs(pick - at)) pick = end;
    }
    return pick;
  };
  let end = best(/\n\s*\n/g) ?? best(/[.!?]["')\]]?\s/g) ?? best(/\s/g) ?? at;
  // Never between the two halves of a character outside the BMP.
  if (/[\uDC00-\uDFFF]/.test(text[end] ?? "")) end++;
  return end;
}

/** A text's passages: one for a short text, else about PASSAGE_CHARS each, in order. */
export function passagesOf(text: string): Passage[] {
  const out: Passage[] = [];
  let start = 0;
  while (text.length - start > ONE_PASSAGE_MAX) {
    const end = cutAt(text, start, start + PASSAGE_CHARS);
    out.push({ start, end });
    start = end;
  }
  out.push({ start, end: text.length });
  return out;
}

/** A JavaScript offset in a text as SQLite counts characters: a surrogate pair is one. */
const sqlChars = (text: string, at: number): number =>
  at - (text.slice(0, at).match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

/** A text's passages as the passages table keeps them: each one's place, start and length, in SQLite's characters. */
export function passageRows(body: string): [number, number, number][] {
  const plain = !/[\uD800-\uDFFF]/.test(body);
  const at = (i: number) => (plain ? i : sqlChars(body, i));
  return passagesOf(body).map((p, n) => [n, at(p.start), at(p.end) - at(p.start)]);
}

/** Takes an item's passages out of the words index as they are: call it before its row changes. */
export function unindexItem(db: DatabaseSync, t: WordsTables, id: number): void {
  db.prepare(
    `insert into ${t.words} (${t.words}, rowid, title, context, body)
     select 'delete', id, title, context, body from ${t.view} where item = ?`,
  ).run(id);
  db.prepare(`delete from ${t.passages} where item = ?`).run(id);
}

/** Puts an item's passages into the words index, as its row is now (its text: `body`). */
export function indexItem(db: DatabaseSync, t: WordsTables, id: number, body: string): void {
  const add = db.prepare(`insert into ${t.passages} (item, n, start, len) values (?, ?, ?, ?)`);
  for (const r of passageRows(body)) add.run(id, ...r);
  db.prepare(
    `insert into ${t.words} (rowid, title, context, body)
     select id, title, context, body from ${t.view} where item = ?`,
  ).run(id);
}

/**
 * A scratch index with the words index's tokenizer, for the stems of a text (vocab.ts); `stems`
 * false: its words before they are stemmed.
 */
export function scratchWords(stems = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`create virtual table w using fts5(body, tokenize = '${stems ? TOKENIZE : UNSTEMMED}');
create virtual table w_terms using fts5vocab('w', 'instance');`);
  return db;
}

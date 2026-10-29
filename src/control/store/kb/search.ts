import type { DatabaseSync } from "node:sqlite";

/**
 * Search by words in control's knowledge base (goal 175): the words index (kb_words, FTS5 with the
 * porter stemmer, written in each item's own transaction: schema.ts) read with BM25, a match in an
 * item's title counting three times one in its text. Each hit has an excerpt of its text around
 * the words that matched, those words in **bold**, and why it matched: which of the search's words
 * its title and its text have. A search with no words gives the newest items. Every search reads
 * only where it is told: whole collections, or one run's items of a collection.
 */

/** Where a search reads: a campaign's whole collection, or only one run's items of it. */
export interface KbWhere {
  campaign: string;
  run?: string | undefined;
}

export interface KbFindOptions {
  kinds?: readonly string[] | undefined;
  /** For notes: their sub-kinds (observation, decision, …). */
  sub?: readonly string[] | undefined;
  limit: number;
}

/** One item found: its row, its excerpt and why it matched. */
export interface KbFoundRow {
  row: Record<string, unknown>;
  excerpt: string;
  why: string;
}

/** The most words of a search the index is asked for: the rest are left out. */
export const KB_TERMS_MAX = 12;
/** How many tokens an excerpt holds. */
const EXCERPT_TOKENS = 40;
/** How many characters of its text an item found by no words shows. */
const NEWEST_EXCERPT = 300;

/** Words too common to tell items apart: a search leaves them out. */
const COMMON = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its may no not of on or our so than that the their them then there these they this those to too was we were what when where which who why will with would you your".split(
    " ",
  ),
);

/**
 * A search's words as the index takes them: runs of letters and digits, in lower case, each once,
 * common words and single letters left out, the first KB_TERMS_MAX.
 */
export function searchTerms(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((w) => !COMMON.has(w) && (w.length > 1 || /\d/.test(w)));
  return [...new Set(kept)].slice(0, KB_TERMS_MAX);
}

/** The start of a text, for an excerpt with no word to show. */
const cut = (t: string) => (t.length > NEWEST_EXCERPT ? `${t.slice(0, NEWEST_EXCERPT)}…` : t);

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The SQL that keeps an item of table `i` within `where`, with its values. */
function within(where: readonly KbWhere[]): { sql: string; args: string[] } {
  const parts = where.map((w) => (w.run ? "(i.campaign = ? and i.run = ?)" : "i.campaign = ?"));
  return {
    sql: `(${parts.join(" or ")})`,
    args: where.flatMap((w) => (w.run ? [w.campaign, w.run] : [w.campaign])),
  };
}

/** The kinds and sub-kinds a search keeps, as SQL on table `i`, with its values. */
function kept(o: KbFindOptions): { sql: string; args: string[] } {
  const kinds = o.kinds?.length ? [...o.kinds] : [];
  const sub = o.sub?.length ? [...o.sub] : [];
  return {
    sql: [
      ...(kinds.length ? [`i.kind in (${marks(kinds.length)})`] : []),
      ...(sub.length ? [`i.sub in (${marks(sub.length)})`] : []),
    ]
      .map((s) => ` and ${s}`)
      .join(""),
    args: [...kinds, ...sub],
  };
}

/** The words highlight() marked in a text, each once, in lower case. */
function marked(text: string): string[] {
  const out = new Set<string>();
  // Each marked word sits between the marks highlight() was given: char(1) and char(2).
  for (const part of text.split("\u0001").slice(1)) {
    const w = part.slice(0, part.indexOf("\u0002")).toLowerCase().trim();
    if (w) out.add(w);
  }
  return [...out];
}

/** Why an item matched, in words: which words its title and its text have. */
function whyWords(title: string[], text: string[]): string {
  return [
    ...(title.length ? [`the title has ${title.join(", ")}`] : []),
    ...(text.length ? [`the text has ${text.join(", ")}`] : []),
  ].join("; ");
}

/**
 * Items within `where` that have any of the search's words, best first by BM25 (a word in the
 * title counts three times one in the text), at most `limit`, with how many matched in all. No
 * words: the newest items, newest change first.
 */
export function findItems(
  db: DatabaseSync,
  q: string,
  where: readonly KbWhere[],
  o: KbFindOptions,
): { matched: number; found: KbFoundRow[] } {
  if (!where.length) return { matched: 0, found: [] };
  const w = within(where);
  const k = kept(o);
  const terms = searchTerms(q);
  if (!terms.length) {
    const count = db
      .prepare(`select count(*) as n from kb_item i where ${w.sql}${k.sql}`)
      .get(...w.args, ...k.args) as { n: number };
    const rows = db
      .prepare(
        `select i.* from kb_item i where ${w.sql}${k.sql} order by i.updated_at desc, i.seq desc limit ?`,
      )
      .all(...w.args, ...k.args, o.limit) as Record<string, unknown>[];
    return {
      matched: Number(count.n),
      found: rows.map((row) => {
        return { row, excerpt: cut(String(row.body ?? "")), why: "" };
      }),
    };
  }
  const match = terms.map((t) => `"${t}"`).join(" OR ");
  const from = `from kb_words join kb_item i on i.id = kb_words.rowid where kb_words match ? and ${w.sql}${k.sql}`;
  const count = db.prepare(`select count(*) as n ${from}`).get(match, ...w.args, ...k.args) as {
    n: number;
  };
  const rows = db
    .prepare(`select i.* ${from} order by bm25(kb_words, 3.0, 1.0), i.seq desc limit ?`)
    .all(match, ...w.args, ...k.args, o.limit) as Record<string, unknown>[];
  if (!rows.length) return { matched: Number(count.n), found: [] };
  // The excerpts and the words each matched, for the hits alone: snippet() and highlight() read
  // the match, so they are asked again for these rows only.
  const ids = rows.map((r) => Number(r.id));
  const shown = new Map(
    (
      db
        .prepare(
          `select rowid as id, snippet(kb_words, 1, '**', '**', '…', ${EXCERPT_TOKENS}) as body_part,
             snippet(kb_words, 0, '**', '**', '…', ${EXCERPT_TOKENS}) as title_part,
             highlight(kb_words, 0, char(1), char(2)) as title_marked,
             highlight(kb_words, 1, char(1), char(2)) as body_marked
           from kb_words where kb_words match ? and rowid in (${marks(ids.length)})`,
        )
        .all(match, ...ids) as Record<string, unknown>[]
    ).map((r) => [Number(r.id), r]),
  );
  return {
    matched: Number(count.n),
    found: rows.map((row) => {
      const s = shown.get(Number(row.id)) ?? {};
      const inText = marked(String(s.body_marked ?? ""));
      const inTitle = marked(String(s.title_marked ?? ""));
      const body = String(row.body ?? "");
      const excerpt = inText.length
        ? String(s.body_part ?? "")
        : body
          ? cut(body)
          : String(s.title_part ?? "");
      return { row, excerpt, why: whyWords(inTitle, inText) };
    }),
  };
}

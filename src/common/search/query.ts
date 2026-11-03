/**
 * What a search asks a words index (goal 175), in its two modes. The forgiving mode, the default,
 * takes plain words: any of them matches, common words are left out, and a word may also find the
 * words its owner says it with (a knowledge base's outcome words). The exact mode passes FTS5's own
 * query syntax as it is written: "a phrase", prefix*, NEAR(a b, 5), NOT, AND, OR, (groups) and
 * column filters (title:, context:, body:). Every query is given to SQLite as a bound value, never
 * as SQL; a query FTS5 can't read is answered in words (find.ts).
 */

/** How a search reads its words. */
export type SearchMode = "words" | "exact";

/** The most words of a forgiving search the index is asked for: the rest are left out. */
export const TERMS_MAX = 12;

/** Words too common to tell items apart: a forgiving search leaves them out. */
export const COMMON = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its may no not of on or our so than that the their them then there these they this those to too was we were what when where which who why will with would you your".split(
    " ",
  ),
);

/**
 * Words a forgiving search for a word on the left also finds: the words on the right. Each index's
 * owner gives its own (control's knowledge base: its outcome words); none by default.
 */
export type AlsoWords = readonly (readonly [readonly string[], readonly string[]])[];

/**
 * A forgiving search's words as the index takes them: runs of letters, digits and underscores, in
 * lower case, each once, common words and single letters left out, the first TERMS_MAX.
 */
export function searchTerms(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const kept = words.filter((w) => !COMMON.has(w) && (w.length > 1 || /\d/.test(w)));
  return [...new Set(kept)].slice(0, TERMS_MAX);
}

/** A word as an FTS5 phrase: in double quotes, any double quote in it doubled. */
export const phrase = (w: string): string => `"${w.replaceAll('"', '""')}"`;

/** A forgiving search's words, with the words they also find, as one FTS5 query of any of them. */
export function anyOf(terms: readonly string[], also: AlsoWords = []): string {
  const all = new Set<string>();
  for (const t of terms) {
    all.add(t);
    for (const [from, to] of also) if (from.includes(t)) for (const w of to) all.add(w);
  }
  return [...all].map(phrase).join(" OR ");
}

/** FTS5's operators, which an exact search's words are not. */
const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

/**
 * The words of an exact search, for the counts of the items that hold each: its words and its
 * phrases' words, without its operators, column names and stars, in lower case, each once.
 */
export function exactWords(q: string): string[] {
  const bare = q.replace(/[\p{L}\p{N}_]+\s*:/gu, " ").replace(/\{[^}]*\}\s*:/g, " ");
  const words = (bare.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => !OPERATORS.has(w));
  return [...new Set(words.map((w) => w.toLowerCase()))].slice(0, TERMS_MAX);
}

/**
 * What an exact search may hold, for the words of a refusal, with an example of a column filter
 * that means something in the index searched (`title: word or context: regress`).
 */
export const exactSyntax = (columnExample: string): string =>
  `FTS5's query syntax: words, "a phrase", prefix*, a AND b, a OR b, a NOT b, NEAR(a b, 10), (groups), and a column filter such as ${columnExample} (the columns are title, context and body)`;

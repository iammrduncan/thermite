import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { passagesOf, phrase, rankedItems, tokensOf } from "../../../common/search/index.ts";
import type { Ledger, SourceRow } from "../../ledger/index.ts";
import { normalizeQuote, quotePlaces } from "../checks.ts";
import { RUN_WORDS } from "./tables.ts";

/**
 * search_corpus (goal 175): an exact phrase in a run's archived sources. The words index finds the
 * sources that hold every word of the phrase; then each is checked as add_claim checks a quote
 * (normalizeQuote on both: case, words and punctuation exact, whitespace and typographic quotes
 * and dashes folded), and a match gives the exact place: its offset in the archived text, as
 * read_source takes it, and the source's own characters, to quote as they are. A source that holds
 * the words in this order but not these characters (other case, punctuation or word endings) is a
 * near miss: never a match, and said with the source's own characters.
 */

/** One page: at most this many matches, and this many characters of them. */
const PAGE = 30;
const PAGE_CHARS = 11_000;
/** The longest phrase searched, in characters. */
const PHRASE_MAX = 200;
/** How much of the text an excerpt shows before and after a match. */
const BEFORE = 200;
const AFTER = 300;
/** How many places in one source a match counts, at most. */
const PLACES_MAX = 100;
/** How many near misses one page names, at most. */
const NEAR_MAX = 5;

/** A source that holds the phrase exactly: where first, how many places, its characters there. */
export interface CorpusMatch {
  source: string;
  url: string;
  /** The first place's offset in the archived text, as read_source takes it. */
  at: number;
  places: number;
  /** The source's own characters there: a quote add_claim verifies. */
  quote: string;
  excerpt: string;
}

/** A page of search_corpus's answer. */
export interface CorpusPage {
  matches: CorpusMatch[];
  skip?: number;
  next_skip?: number;
  more?: string;
  /** Sources that hold the words in this order, not these characters: never matches. */
  near?: { source: string; url: string; at: number; quote: string }[];
  near_note?: string;
  note?: string;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The sources of the index that hold every word of the phrase, in some passage or other. */
function holdingEvery(db: DatabaseSync, words: readonly string[]): Set<number> {
  let out: Set<number> | undefined;
  const { words: w, passages, items } = RUN_WORDS;
  const q = db.prepare(
    `select distinct p.item as id from ${w} join ${passages} p on p.id = ${w}.rowid
     join ${items} i on i.id = p.item where ${w} match ? and i.kind = 'source'`,
  );
  for (const word of new Set(words)) {
    const ids = new Set((q.all(phrase(word)) as { id: number }[]).map((r) => Number(r.id)));
    out = out ? new Set([...out].filter((id) => ids.has(id))) : ids;
    if (!out.size) break;
  }
  return out ?? new Set();
}

/**
 * Where the phrase's words are in a source's passage, in this order, as the index reads them: the
 * source's own characters there and their offset in its text; undefined when no one passage has them.
 */
function nearPlace(
  db: DatabaseSync,
  item: number,
  match: string,
  text: string,
): { at: number; quote: string } | undefined {
  const r = db
    .prepare(
      `select p.n as n, highlight(${RUN_WORDS.words}, 2, char(1), char(2)) as b
       from ${RUN_WORDS.words} join ${RUN_WORDS.passages} p on p.id = ${RUN_WORDS.words}.rowid
       where ${RUN_WORDS.words} match ? and p.item = ? limit 1`,
    )
    .get(`body: ${match}`, item) as { n: number; b: string } | undefined;
  if (!r) return undefined;
  const open = r.b.indexOf("\u0001");
  const close = r.b.indexOf("\u0002", open);
  if (open < 0 || close < 0) return undefined;
  const start = passagesOf(text)[Number(r.n)]?.start ?? 0;
  return { at: start + open, quote: r.b.slice(open + 1, close) };
}

/**
 * A page of the sources that hold a phrase exactly, from `skip`: each with where (its first place,
 * and how many places), the source's own characters, and an excerpt; fewer when their excerpts
 * would not fit a tool's answer, with `next_skip` for the next page. Then the near misses.
 */
export function corpusPage(
  db: DatabaseSync,
  ledger: Ledger,
  run: string,
  text: string,
  skip: number,
): CorpusPage {
  const needle = text.trim().slice(0, PHRASE_MAX);
  if (needle.length < 2) return { matches: [] };
  const words = tokensOf(needle);
  if (!words.length)
    return {
      matches: [],
      note: "search_corpus finds words: the text has none, only punctuation or spaces",
    };
  const quote = normalizeQuote(needle);
  const from = Math.max(0, Math.trunc(Number(skip) || 0));
  const every = holdingEvery(db, words);
  // The sources whose one passage holds the phrase first, best first; then the others that hold
  // every word (the phrase may cross two passages), in the order they were archived.
  const match = phrase(needle);
  const all = { sql: "i.kind = 'source'", args: [] };
  const inOne = every.size
    ? rankedItems(db, RUN_WORDS, match, all, every.size, 0)
        .map((x) => x.id)
        .filter((id) => every.has(id))
    : [];
  const first = new Set(inOne);
  const order = [...inOne, ...[...every].filter((id) => !first.has(id)).sort((a, b) => a - b)];
  const refs = new Map(
    order.length
      ? (
          db
            .prepare(`select id, ref from ${RUN_WORDS.items} where id in (${marks(order.length)})`)
            .all(...order) as { id: number; ref: string }[]
        ).map((r) => [Number(r.id), r.ref])
      : [],
  );
  const matches: CorpusMatch[] = [];
  const near: NonNullable<CorpusPage["near"]> = [];
  let seen = 0;
  let size = 0;
  let more = false;
  for (const id of order) {
    const s = ledger.sources.get(run, refs.get(id) ?? "") as SourceRow | undefined;
    if (!s) continue;
    let body: string;
    try {
      // The archived text, as add_claim reads it.
      body = readFileSync(s.text_path, "utf8");
    } catch {
      continue; // its text is gone from the rig: nothing to quote
    }
    // add_claim's own check first; where it holds, each place in the text's own characters.
    if (!normalizeQuote(body).includes(quote)) {
      if (near.length < NEAR_MAX && first.has(id)) {
        const n = nearPlace(db, id, match, body);
        if (n) near.push({ source: s.id, url: s.url, ...n });
      }
      continue;
    }
    if (seen++ < from) continue;
    const places = quotePlaces(body, needle, PLACES_MAX);
    const at = places[0];
    if (!at) continue;
    const m = {
      source: s.id,
      url: s.url,
      at: at.start,
      places: places.length,
      quote: body.slice(at.start, at.end),
      excerpt: body.slice(Math.max(0, at.start - BEFORE), at.end + AFTER),
    };
    const len = JSON.stringify(m).length;
    if (matches.length >= PAGE || (matches.length > 0 && size + len > PAGE_CHARS)) {
      more = true;
      break;
    }
    matches.push(m);
    size += len;
  }
  return {
    matches,
    ...(from ? { skip: from } : {}),
    ...(more
      ? {
          next_skip: from + matches.length,
          more: `more sources match: search_corpus again with skip ${from + matches.length} for the next page`,
        }
      : {}),
    ...(near.length
      ? {
          near,
          near_note:
            "These sources hold the words in this order, but not these exact characters (case, punctuation or word endings differ): add_claim checks a quote character for character, so quote a source's own words, as its quote gives them.",
        }
      : {}),
  };
}

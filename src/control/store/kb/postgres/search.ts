import type { Sql } from "../../../../common/postgres.ts";
import {
  type FoundPassage,
  type FoundRow,
  passagesOf,
  type ScopeSql,
  searchTerms,
  textStart,
} from "../../../../common/search/index.ts";
import { OUTCOME_WORDS } from "../query.ts";
import {
  CONTEXT_WORDS,
  countsOf,
  ITEM_TYPE,
  type KbFindOptions,
  type KbFindResult,
  type KbWhere,
} from "../search.ts";

/**
 * Search by words in control's knowledge base on PostgreSQL, until its words index is built
 * (goal 269): a plain match. An item matches when its title, its text or its context holds one
 * of the search's words, as letters, whatever their case; the newest change comes first, with no
 * ranking. It reads only where it is told and keeps only what its filters keep, as the search on
 * SQLite does (../../kb/search.ts), and says how many items matched, where its words land and how
 * many items hold each word. What needs the index is not answered: a word's stem, a suggestion
 * for a word none holds, and an exact search, which is refused in words.
 */

/** How many of a search's words are counted. */
const WORDS_COUNTED_MAX = 20;
/** How many characters of an item's text an excerpt shows before its first word found. */
const EXCERPT_BEFORE = 60;

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

/** What an item's words are matched in, in SQL on `i`: its title, its context and its text. */
const WORDS_SQL = "lower(i.title || ' ' || i.context || ' ' || i.body)";

/** The SQL that keeps the items that hold any of `words`, with its values. */
function holding(words: readonly string[]): ScopeSql {
  return {
    sql: `(${words.map(() => `strpos(${WORDS_SQL}, ?) > 0`).join(" or ")})`,
    args: [...words],
  };
}

/** The words a search matches: each query's own, and those its outcome words also find. */
function wordsOf(o: KbFindOptions): { asked: string[]; all: string[] } {
  const asked = [...new Set(o.queries.flatMap((q) => searchTerms(q)))];
  const all = new Set(asked);
  for (const w of asked)
    for (const [from, to] of OUTCOME_WORDS)
      if (from.includes(w)) for (const also of to) all.add(also.toLowerCase());
  return { asked, all: [...all] };
}

/** Why an item matched, in words: which words its title, its text and its context have. */
function whyOf(row: Record<string, unknown>, words: readonly string[]): string {
  const has = (field: unknown) => {
    const text = String(field ?? "").toLowerCase();
    return words.filter((w) => text.includes(w));
  };
  const title = has(row.title);
  const text = has(row.body);
  const context = has(row.context);
  return [
    ...(title.length ? [`the title has ${title.join(", ")}`] : []),
    ...(text.length ? [`the text has ${text.join(", ")}`] : []),
    ...(context.length ? [`${CONTEXT_WORDS} has ${context.join(", ")}`] : []),
  ].join("; ");
}

/** Where the first of the words an item's text holds is; the text's length when it holds none. */
const firstAt = (body: string, words: readonly string[]): number => {
  const lower = body.toLowerCase();
  return Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), body.length);
};

/** The passage of a long text that holds the first of the words; none for a short text. */
function passageOf(body: string, words: readonly string[]): FoundPassage | null {
  const parts = passagesOf(body);
  if (parts.length < 2) return null;
  const at = firstAt(body, words);
  const n = Math.max(
    0,
    parts.findIndex((p) => at >= p.start && at < p.end),
  );
  const part = parts[n] ?? { start: 0, end: body.length };
  return { n: n + 1, of: parts.length, from: part.start, to: part.end };
}

/**
 * An item's text around the first of the words it holds, those words in **bold** as the search
 * on SQLite marks them; its start when it holds none.
 */
function excerptOf(body: string, words: readonly string[]): string {
  const at = firstAt(body, words);
  const shown =
    at >= body.length || at <= EXCERPT_BEFORE
      ? textStart(body)
      : `…${textStart(body.slice(at - EXCERPT_BEFORE))}`;
  // The longest word first: a word inside another is marked with it, once.
  const letters = [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return letters.length ? shown.replace(new RegExp(letters.join("|"), "giu"), "**$&**") : shown;
}

/**
 * Items within `where` that hold any of the search's words, newest change first, a page of
 * `limit` from `offset`, with how many matched in all, where its words land and how many items
 * hold each word. An exact search: why it is not run, in words (`refused`).
 */
export async function findItems(
  q: Sql,
  where: readonly KbWhere[],
  o: KbFindOptions,
): Promise<KbFindResult> {
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
  if (o.mode === "exact" && o.queries.some((x) => x.trim()))
    return {
      ...empty,
      refused:
        "an exact search needs the knowledge base's words index, which a store on PostgreSQL does not have yet: search by words",
    };
  // "More like this" takes the item's title's words: its telling words need the index.
  const like = o.like ? searchTerms(o.like.title) : undefined;
  const { asked, all } = wordsOf(like ? { ...o, queries: [...o.queries, o.like?.title ?? ""] } : o);
  if (!all.length) return o.like ? { ...empty, like: [] } : await newest(q, w, k, o, offset);
  const m = holding(all);
  // Where the words land: within the scope, whatever the filters keep.
  const groups = (await q.all(
    `select i.campaign as campaign, i.run as run, i.slot as slot, i.kind as kind, i.outcome as outcome,
         count(*) as n from kb_item i where ${w.sql} and ${m.sql} group by 1, 2, 3, 4, 5`,
    ...w.args,
    ...m.args,
  )) as Record<string, unknown>[];
  const matched = Number(
    (
      await q.get(
        `select count(*) as n from kb_item i where ${w.sql}${k.sql} and ${m.sql}`,
        ...w.args,
        ...k.args,
        ...m.args,
      )
    )?.n ?? 0,
  );
  const rows = (await q.all(
    `select i.* from kb_item i where ${w.sql}${k.sql} and ${m.sql}
       order by i.updated_at desc, i.seq desc limit ? offset ?`,
    ...w.args,
    ...k.args,
    ...m.args,
    o.limit,
    offset,
  )) as Record<string, unknown>[];
  const words: { word: string; items: number }[] = [];
  for (const word of asked.slice(0, WORDS_COUNTED_MAX)) {
    const one = holding([word]);
    const n = await q.get(
      `select count(*) as n from kb_item i where ${w.sql} and ${one.sql}`,
      ...w.args,
      ...one.args,
    );
    words.push({ word, items: Number(n?.n ?? 0) });
  }
  return {
    matched,
    next_offset: offset + o.limit < matched ? offset + o.limit : null,
    counts: countsOf(groups),
    words,
    did_you_mean: [],
    ...(like ? { like } : {}),
    found: rows.map((row): FoundRow => {
      const body = String(row.body ?? "");
      return {
        row,
        excerpt: excerptOf(body, all),
        why: whyOf(row, all),
        passage: passageOf(body, all),
      };
    }),
  };
}

/** No words: the newest items within the scope, newest change first, with their counts. */
async function newest(
  q: Sql,
  w: ScopeSql,
  k: ScopeSql,
  o: KbFindOptions,
  offset: number,
): Promise<KbFindResult> {
  const groups = (await q.all(
    `select i.campaign as campaign, i.run as run, i.slot as slot, i.kind as kind, i.outcome as outcome,
         count(*) as n from kb_item i where ${w.sql} group by 1, 2, 3, 4, 5`,
    ...w.args,
  )) as Record<string, unknown>[];
  const count = (await q.get(
    `select count(*) as n from kb_item i where ${w.sql}${k.sql}`,
    ...w.args,
    ...k.args,
  )) as { n: number };
  const rows = (await q.all(
    `select i.* from kb_item i where ${w.sql}${k.sql} order by i.updated_at desc, i.seq desc limit ? offset ?`,
    ...w.args,
    ...k.args,
    o.limit,
    offset,
  )) as Record<string, unknown>[];
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

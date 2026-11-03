import { type WordsTables, wordsSchema } from "../../../common/search/index.ts";

/**
 * The tables of the index of a run's own research (index.ts): one row for each item, with what it
 * was indexed from, and the search engine's words index over them (common/search/).
 */

/** The index's tables. */
export const RUN_WORDS: WordsTables = {
  items: "item",
  passages: "passage",
  view: "passage_text",
  words: "words",
  terms: "words_terms",
};

/** The version of the index's tables: an index of another version is made again. */
export const VERSION = 1;

/** The index's tables as they are made, at VERSION. */
export const SCHEMA = `
create table item (
  id integer primary key,
  -- A higher seq was indexed later: the newer of two hits that rank the same comes first.
  seq integer not null,
  kind text not null,
  ref text not null,
  -- What it was indexed from (items.ts): a new key makes it anew.
  key text not null,
  at text not null,
  title text not null,
  state text,
  context text not null,
  body text not null,
  unique (kind, ref)
);
create index item_at on item (at);
${wordsSchema(RUN_WORDS)}
pragma user_version = ${VERSION};
`;

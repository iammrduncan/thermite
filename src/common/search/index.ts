/**
 * Thermite's search by words (goal 175): one engine for every words index, so control's knowledge
 * base and a rig's index of a run's own research rank the same text the same way. SQLite's FTS5
 * over passages of each item's text, with the same tokenizer (passages.ts), read with BM25 and the
 * same weights, excerpts and why, fused queries and "more like this" (find.ts), the forgiving and
 * the exact query (query.ts), and each word's count and "did you mean" (vocab.ts). Each index's
 * owner keeps its items, its scope and what its context holds.
 */

export {
  type FoundPassage,
  type FoundRow,
  findWords,
  rankedItems,
  textStart,
  type WordsFound,
} from "./find.ts";
export {
  indexItem,
  passageRows,
  passagesOf,
  unindexItem,
  type WordsTables,
  wordsSchema,
} from "./passages.ts";
export { phrase, type SearchMode, searchTerms } from "./query.ts";
export { EVERY_ITEM, itemsMatching, type ScopeSql, tokensOf } from "./vocab.ts";

import type { SearchMode } from "../../../common/search/index.ts";

/**
 * What a search of control's knowledge base asks its words index (goal 175), beyond the engine's
 * two modes (common/search/): Thermite's outcome words, which a forgiving search also finds, and
 * the column filter a refusal names as an example.
 */

/** How a search reads its words. */
export type KbSearchMode = SearchMode;

/**
 * Thermite's outcome words: a forgiving search for a word on the left also finds the words on the
 * right, the words the runs' records and the items' outcomes (core/kb/items.ts) say it with. Plain words
 * only: an agent that writes "failed" finds the experiments the planner dropped and the attempts
 * the judge found worse, no better or broken. The exact mode leaves them out.
 */
export const OUTCOME_WORDS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [
    ["fail", "failed", "failing", "failure", "failures"],
    ["failed", "dropped", "regress", "slower", "neutral", "broken"],
  ],
  [
    ["slow", "slower", "worse", "regression", "regressed"],
    ["slower", "regress"],
  ],
  [
    ["faster", "speedup", "win", "won"],
    ["faster", "speedup", "win", "won"],
  ],
];

/** A column filter of the knowledge base's index, for the words of a refusal. */
export const KB_COLUMN_EXAMPLE = "title: word or context: regress";

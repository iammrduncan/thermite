/**
 * Which store the tests run on: SQLite, or PostgreSQL with `--store postgres` (scripts/test.mjs;
 * goal 268). A test runs on both unless it says, with one of the options below, why it is a test
 * of one alone.
 */

/** Whether every store a test opens is on PostgreSQL. */
export const ON_POSTGRES = process.env.THERMITE_TEST_STORE === "postgres";

/**
 * The options of a test of the store on SQLite alone: its file, its copies beside it, its
 * migrations from an older version. A store on PostgreSQL has none of them.
 */
export const sqliteOnly = {
  skip: ON_POSTGRES
    ? "a test of the store on SQLite: its file, its copies or its migrations"
    : false,
};

/**
 * The options of a test of the knowledge base's words index: ranking, stems, passages, marked
 * excerpts, suggestions and exact queries. A store on PostgreSQL has no index until goal 269,
 * and answers a search with a plain match.
 */
export const wordsIndex = {
  skip: ON_POSTGRES ? "the knowledge base's words index on PostgreSQL is goal 269" : false,
};

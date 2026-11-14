import { registerHooks } from "node:module";
import { setStoreOpener } from "../../src/control/store/index.ts";
import { postgresStore } from "./postgres.ts";

/**
 * Loaded before each test file when the tests run with `--store postgres` (scripts/test.mjs):
 * every store a test opens is then on PostgreSQL, behind the same interface (goal 268;
 * postgres.ts says which PostgreSQL).
 */

// A test that reaches the SQLite database itself is left out, not failed: the test files get
// `node:test` from sqlite-only.ts, which says how.
const leavesOut = new URL("./sqlite-only.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "node:test" && context.parentURL !== leavesOut
      ? { url: leavesOut, shortCircuit: true }
      : next(specifier, context);
  },
});

setStoreOpener(postgresStore);

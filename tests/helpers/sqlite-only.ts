import * as runner from "node:test";
import { NotOnSqlite } from "../../src/control/store/behind.ts";

/**
 * `node:test` as the test files get it when the tests run on PostgreSQL (`--store postgres`,
 * store-postgres.ts): the same, but a test that reaches the SQLite database itself (sqliteBehind)
 * is left out, with its reason, where it would fail. Such a test is a test of the SQLite store:
 * it makes a store as an older version left it, or reads a table no call gives. Every other
 * failure is a failure, as on SQLite.
 */

const WHY = "it reaches the SQLite database itself: a test of the store on SQLite";

type Body = (this: unknown, t: runner.TestContext) => unknown;

/** `body`, left out when it turns out to reach the SQLite database itself. */
const leftOut = (body: Body): Body =>
  async function (this: unknown, t) {
    try {
      return await body.call(this, t);
    } catch (err) {
      if (!(err instanceof NotOnSqlite)) throw err;
      t.skip(WHY);
    }
  };

/** A test function of the runner whose tests are left out so. A test that takes `done` is as it was. */
function leavingOut<F extends (...args: never[]) => unknown>(real: F): F {
  const wrapped = (...args: unknown[]) =>
    (real as unknown as (...a: unknown[]) => unknown)(
      ...args.map((a) => (typeof a === "function" && a.length < 2 ? leftOut(a as Body) : a)),
    );
  return Object.assign(wrapped, real) as unknown as F;
}

export const test = leavingOut(runner.test);
export const it = leavingOut(runner.it);
export const { after, afterEach, before, beforeEach, describe, mock, run, suite } = runner;
export type { TestContext } from "node:test";
export default test;

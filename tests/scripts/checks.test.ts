import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
// @ts-expect-error: a script's module, plain JavaScript with no types.
import { acceptanceChecks } from "../../scripts/acceptance/lib/checks.mjs";

/** The acceptance scripts' one way to check (goal 125, T3): what each prints and keeps. */
describe("acceptance checks", () => {
  let printed: string[] = [];
  const log = console.log;
  beforeEach(() => {
    printed = [];
    console.log = (line: string) => void printed.push(line);
  });
  afterEach(() => {
    console.log = log;
  });

  test("PASS and FAIL with the detail, kept for the report and counted", () => {
    const report = { checks: [] as unknown[] };
    const { check, failed } = acceptanceChecks({ max: 13, into: report.checks });
    assert.equal(check("one", true), true);
    assert.equal(check("two", 0, { long: "a detail longer than twelve" }), false);
    assert.equal(check("three", "yes", "said as it is"), true);
    assert.deepEqual(printed, ["PASS one", 'FAIL two: {"long":"a de', "PASS three: said as it is"]);
    assert.deepEqual(report.checks, [
      { name: "one", ok: true },
      { name: "two", ok: false, detail: { long: "a detail longer than twelve" } },
      { name: "three", ok: true, detail: "said as it is" },
    ]);
    assert.equal(failed(), 1);
  });

  test("with stop, the first failure ends the script", () => {
    const { check, results } = acceptanceChecks({ stop: true });
    check("fine", true);
    assert.throws(() => check("broken", false), /^Error: failed: broken$/);
    assert.equal(results.length, 2);
  });
});

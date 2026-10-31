import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseDuration } from "../../src/core/duration.ts";

const _readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("durations", () => {
  test("a duration in its units; words are refused", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("8h"), 8 * 3_600_000);
    assert.throws(() => parseDuration("8 hours"));
  });
});

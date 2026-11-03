import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { globToRegExp, matchesAny } from "../../src/core/glob.ts";

const _readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("globs", () => {
  test("paths matched by a glob, and ** across folders", () => {
    assert.ok(matchesAny("src/kernel/a/b.cu", ["src/kernel/**"]));
    assert.ok(!matchesAny("src/bench/timer.cpp", ["src/kernel/**"]));
    assert.ok(globToRegExp("src/*.cu").test("src/a.cu"));
    assert.ok(!globToRegExp("src/*.cu").test("src/x/a.cu"));
    assert.ok(globToRegExp("**/*.md").test("README.md"));
  });
});

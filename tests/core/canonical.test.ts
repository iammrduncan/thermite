import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { canonicalJson, canonicalSha } from "../../src/core/canonical.ts";

const _readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("canonical JSON", () => {
  test("sorts keys and omits undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null], c: undefined }), '{"a":[true,null],"b":1}');
  });
  test("is independent of key order", () => {
    assert.equal(
      canonicalSha({ x: 1, y: { b: 2, a: 1 } }),
      canonicalSha({ y: { a: 1, b: 2 }, x: 1 }),
    );
  });
  test("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson({ score: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson([Number.POSITIVE_INFINITY]), /non-finite/);
  });
});

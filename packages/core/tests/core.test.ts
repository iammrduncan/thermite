import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGE, THERMITE_VERSION } from "../src/index.ts";

test("@thermite/core exports version metadata", () => {
  assert.equal(PACKAGE.name, "@thermite/core");
  assert.equal(PACKAGE.version, THERMITE_VERSION);
  assert.match(THERMITE_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

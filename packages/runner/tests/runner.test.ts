import assert from "node:assert/strict";
import test from "node:test";
import { THERMITE_VERSION } from "@thermite/core";
import { PACKAGE } from "../src/index.ts";

test("@thermite/runner resolves workspace @thermite/core version", () => {
  assert.equal(PACKAGE.name, "@thermite/runner");
  assert.equal(PACKAGE.version, THERMITE_VERSION);
});

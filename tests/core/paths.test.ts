import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, test } from "node:test";
import { joinPath, normalizePath } from "../../src/core/paths.ts";
import { type Draw, forCases } from "../helpers/property.ts";

/** A path drawn from the parts that normalizing turns on: names, dots, ".." and slashes. */
const PARTS = ["a", "b", ".", "..", "...", ".a", "/", "//"];
const drawPath = (d: Draw) => d.list(d.int(0, 8), () => PARTS[d.int(0, PARTS.length - 1)]).join("");

describe("paths as text", () => {
  test("a path normalizes as Node's path.posix.normalize does", () => {
    for (const p of ["", ".", "./", "/", "//", "a/..", "a/../", "../a/../..", "/../a", "a//b/./c/"])
      assert.equal(normalizePath(p), posix.normalize(p), JSON.stringify(p));
    forCases(2000, 1, drawPath, (p) => assert.equal(normalizePath(p), posix.normalize(p)));
  });

  test("paths join as Node's path.posix.join joins them", () => {
    assert.equal(joinPath(), posix.join());
    assert.equal(joinPath("", ""), posix.join("", ""));
    assert.equal(joinPath("/home/thermite/", "tunnel"), "/home/thermite/tunnel");
    forCases(
      2000,
      7,
      (d) => d.list(d.int(0, 3), () => drawPath(d)),
      (ps) => assert.equal(joinPath(...ps), posix.join(...ps)),
    );
  });
});

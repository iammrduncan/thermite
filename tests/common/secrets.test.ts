import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sameSecret } from "../../src/common/secrets.ts";

/** Every TypeScript file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

describe("secrets are compared in constant time", () => {
  test("sameSecret is true for the same secret only, whatever the lengths", () => {
    assert.equal(sameSecret("trial.abc123", "trial.abc123"), true);
    assert.equal(sameSecret("", ""), true);
    assert.equal(sameSecret("trial.abc123", "trial.abc124"), false);
    assert.equal(sameSecret("trial.abc123", "trial.abc1234"), false);
    assert.equal(sameSecret("", "x"), false);
  });

  test("no source compares an authorization header with === or !==", () => {
    const plain = /header\(\s*["']authorization["']\s*\)\s*[!=]==|[!=]==\s*`Bearer /i;
    const src = fileURLToPath(new URL("../../src/", import.meta.url));
    const found = sources(src).filter((f) => plain.test(readFileSync(f, "utf8")));
    assert.deepEqual(found, [], "compare tokens with sameSecret (src/common/secrets.ts)");
  });
});

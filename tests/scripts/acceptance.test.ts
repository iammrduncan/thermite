import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

/**
 * The acceptance scripts (scripts/acceptance/): each check has its npm script, so `npm run` lists
 * them all, and every script and its parts carry `// @ts-check`, so the typecheck reads them.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const DIR = "scripts/acceptance";
/** The compose smoke keeps the name it had before the acceptance checks had theirs. */
const OWN_NAMES: Record<string, string> = { "compose-smoke": "smoke:compose" };

const mjs = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `${dir}/${f}`);

describe("the acceptance scripts", () => {
  test("each check has an npm script, acceptance:<name>, that runs it", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
      string,
      string
    >;
    const checks = mjs(DIR);
    assert.ok(checks.length >= 20, checks.join(", "));
    for (const file of checks) {
      const name = file.slice(DIR.length + 1, -".mjs".length);
      const script = OWN_NAMES[name] ?? `acceptance:${name}`;
      assert.equal(scripts[script], `node ${file}`, script);
    }
    // And no acceptance:<name> names a script that is not there.
    for (const [script, command] of Object.entries(scripts))
      if (script.startsWith("acceptance:"))
        assert.ok(checks.includes(command.replace(/^node /, "")), `${script}: ${command}`);
  });

  test("every script and its parts start with // @ts-check, after a shebang", () => {
    const files = [...mjs(DIR), ...mjs(`${DIR}/lib`), ...mjs(`${DIR}/quick-start`)];
    for (const file of files) {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      const first = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
      assert.equal(first, "// @ts-check", file);
    }
  });
});

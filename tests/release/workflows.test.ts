import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The GitHub Actions workflows: each action is pinned by its full commit, with its version in a
 * comment, so a tag moved upstream changes nothing that runs here; and no script a step runs
 * holds an expression, so a value from a tag, a branch or the run reaches it as an environment
 * variable, never as its text.
 */
const dir = join(import.meta.dirname, "..", "..", ".github", "workflows");
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));

test("every action is pinned by its commit, with its version beside it", () => {
  assert.ok(workflows.length >= 2);
  for (const { name, text } of workflows) {
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.*)$/gm)].map((m) => m[1] as string);
    assert.ok(uses.length > 0, name);
    for (const use of uses)
      assert.match(use, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${use}`);
  }
});

test("no step's script holds an expression", () => {
  for (const { name, text } of workflows) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
      if (!run) return;
      const indent = (run[1] as string).length;
      const script = [run[2] as string];
      for (const next of lines.slice(i + 1)) {
        if (next.trim() && next.length - next.trimStart().length <= indent) break;
        script.push(next);
      }
      // A GitHub Actions expression, not a template: written with its dollar sign apart.
      assert.ok(!script.join("\n").includes(`$${"{{"}`), `${name}:${i + 1}: ${line.trim()}`);
    });
  }
});

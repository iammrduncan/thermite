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

/** The repository's files, by their path from the root, without installed or built ones. */
function repoFiles(): string[] {
  const root = join(import.meta.dirname, "..", "..");
  const skip = new Set([".git", "node_modules", "dist", ".astro", ".dev", ".internal"]);
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out;
}

/** The paths that start each of CI's heavy jobs: one extended regular expression a line. */
function heavyPaths(): Map<string, string[]> {
  const ci = workflows.find((w) => w.name === "ci.yml")?.text ?? "";
  const lists = new Map<string, string[]>();
  for (const m of ci.matchAll(/\n {10}([A-Z_]+): \|\n((?: {12}\^[^\n]*\n)+)/g))
    lists.set(
      m[1] as string,
      (m[2] as string)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
  return lists;
}

/** Where a file goes when it splits into a folder named for it (CONVENTIONS.md). */
const splitOf = (path: string) =>
  path.replace(/\/([^/.]+)\.([^/]+)$/, (_, name: string, ext: string) => `/${name}/index.${ext}`);

test("CI's heavy jobs start by folders, so a split or a move into a folder keeps each one running", () => {
  const lists = heavyPaths();
  const ci = workflows.find((w) => w.name === "ci.yml")?.text ?? "";
  // The jobs the step decides are the lists it reads.
  const jobs = /for job in ([a-z_ ]+); do/.exec(ci)?.[1]?.split(" ") ?? [];
  assert.deepEqual(
    [...lists.keys()],
    jobs.map((j) => j.toUpperCase()),
  );
  const files = repoFiles();
  for (const [job, patterns] of lists) {
    // Changing the workflow runs them all.
    assert.ok(patterns.includes("^\\.github/workflows/ci\\.yml$"), job);
    for (const pattern of patterns) {
      const re = new RegExp(pattern);
      const matched = files.filter((f) => re.test(f));
      assert.ok(matched.length > 0, `${job}: ${pattern} names no file of the repository`);
      // Code (src/, tests/ and scripts/, which the size rule splits): every file the path names
      // is still named once it moves into a folder of its own name.
      if (!/^\^(src|tests|scripts)\//.test(pattern)) continue;
      for (const file of matched)
        assert.match(splitOf(file), re, `${job}: ${pattern} names ${file} but not its split`);
    }
  }
  // The rule fails a path that names a file alone.
  assert.doesNotMatch(splitOf("src/core/paths.ts"), /^src\/core\/paths\.ts$/);
  assert.match(splitOf("src/core/paths.ts"), /^src\/core\/paths(\.ts$|\/)/);
  assert.equal(splitOf("tests/docs/quick-start.test.ts"), "tests/docs/quick-start/index.test.ts");
});

test("the release workflow's dry run starts by folders too", () => {
  const release = workflows.find((w) => w.name === "release.yml")?.text ?? "";
  const paths = /\n {4}paths:\n((?: {6}- [^\n]*\n)+)/.exec(release)?.[1] ?? "";
  const list = paths
    .split("\n")
    .map((l) => l.replace(/^ *- /, ""))
    .filter(Boolean);
  assert.ok(list.length > 0);
  for (const path of list)
    assert.ok(path.endsWith("/**") || path === ".github/workflows/release.yml", path);
});

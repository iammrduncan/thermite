import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  commentsOf,
  compare,
  exceptionsText,
  exportsOf,
  type Finding,
  findingText,
  listOf,
  lower,
  missingPathsIn,
  namesOf,
  unusedExports,
} from "../../scripts/checks/lib/loose-ends.ts";

const filesOf = (o: Record<string, string>) => ({
  files: Object.keys(o),
  read: (f: string) => o[f] ?? "",
});

describe("exports nothing imports", () => {
  test("declarations and export lists are exports; names passed on from another file are not", () => {
    const text = [
      "export function a() {}",
      "export const B = 1;",
      "export interface C {}",
      "export type D = string;",
      "export async function e() {}",
      "const f = 1;",
      "export { f, f as g };",
      'export { h } from "./h.ts";',
      'export * from "./i.ts";',
    ].join("\n");
    assert.deepEqual(exportsOf(text).sort(), ["B", "C", "D", "a", "e", "f", "g"]);
    assert.ok(!namesOf(text).has("h"), "a name only passed on is not a use");
  });

  test("an export another file names is in use; one only its own file names, or none, is not", () => {
    const { files, read } = filesOf({
      "src/core/a.ts":
        "export const used = 1;\nexport const own = 2;\nexport const dead = 3;\nown;",
      "src/core/index.ts": 'export { used, own, dead } from "./a.ts";',
      "tests/core/a.test.ts": 'import { used } from "../../src/core/index.ts";\nused;',
    });
    const found = unusedExports(files, read);
    assert.deepEqual(
      found.map((f) => [f.file, f.name, f.local]),
      [
        ["src/core/a.ts", "own", true],
        ["src/core/a.ts", "dead", false],
      ],
    );
    assert.match(findingText(found[0] as Finding), /only its own file uses it\. Drop the export/);
    assert.match(findingText(found[1] as Finding), /nothing uses it\. Remove it/);
  });

  test("only production files are held to it", () => {
    const { files, read } = filesOf({ "tests/helpers/x.ts": "export const lonely = 1;" });
    assert.deepEqual(unusedExports(files, read), []);
  });
});

describe("paths that name no file", () => {
  const on = new Set([
    "src/core/paths.ts",
    "src/harness/agents/cli/loop.ts",
    "src/control/kits/upload.ts",
    "tests/helpers",
    "AGENTS.md",
  ]);
  const exists = (p: string) => on.has(p);

  test("a path from the root names a file, a folder or a module without .ts; a moved one names none", () => {
    const text = [
      "// The paths (src/core/paths), the helpers (tests/helpers/) and the loop",
      "// (src/harness/agents/cli/loop.ts) are there; src/harness/terminal/ moved.",
      'const s = "src/made/up.ts"; // a string is data, not a path in words',
    ].join("\n");
    const found = missingPathsIn("src/harness/x.ts", text, exists);
    assert.deepEqual(
      found.map((f) => [f.line, f.name]),
      [[2, "src/harness/terminal"]],
    );
    assert.match(
      findingText(found[0] as Finding),
      /^src\/harness\/x\.ts:2: src\/harness\/terminal names no file\./,
    );
  });

  test("a module from a folder above the file, or from a part, names a file", () => {
    const text =
      "// The trial loop (cli/loop.ts) and the upload (kits/upload.ts); cli/gone.ts is not.";
    const found = missingPathsIn("src/harness/agents/worker/run.ts", text, exists);
    assert.deepEqual(
      found.map((f) => f.name),
      ["cli/gone.ts"],
    );
  });

  test("patterns, placeholders and project paths are not Thermite's files", () => {
    const text =
      "// tests/**/*.test.ts, src/control/<name>.ts, src/kernel/work.c and src/core/{a,b}.ts";
    assert.deepEqual(missingPathsIn("scripts/x.mjs", text, exists), []);
  });

  test("a page is read whole, links to the repository included; the changelog is history", () => {
    const page = [
      "See `tests/helpers/` and [the loop](https://github.com/iammrduncan/thermite/blob/main/src/harness/agents/cli/loop.ts).",
      "The old one was `scripts/gone.mjs`, linked [here](https://github.com/iammrduncan/thermite/blob/main/src/gone.ts).",
      "Another project's [file](https://github.com/someone/else/blob/main/src/x.ts) is not ours.",
    ].join("\n");
    assert.deepEqual(
      missingPathsIn("docs/_site/src/content/docs/reference/x.md", page, exists).map((f) => f.name),
      ["scripts/gone.mjs", "src/gone.ts"],
    );
    assert.deepEqual(missingPathsIn("CHANGELOG.md", page, exists), []);
  });

  test("comments in shell and YAML start at #; block comments run over lines", () => {
    assert.deepEqual(commentsOf("x.sh", 'echo "#x" src/a\n# src/b'), ['#x" src/a', "# src/b"]);
    assert.deepEqual(commentsOf("x.ts", "a /* one\ntwo */ b // three\nc"), [
      "/* one",
      "two  // three",
      "",
    ]);
  });
});

describe("the list of today's exceptions", () => {
  const found: Finding[] = [
    { kind: "export", file: "src/a.ts", name: "x", local: true },
    { kind: "path", file: "src/a.ts", name: "src/gone", line: 3 },
  ];

  test("listed findings pass; a new one and a listed one that is gone fail", () => {
    const e = listOf(found);
    assert.deepEqual(e, { exports: { "src/a.ts": ["x"] }, paths: { "src/a.ts": ["src/gone"] } });
    assert.deepEqual(compare(found, e), { added: [], gone: [] });
    const later: Finding[] = [
      { kind: "export", file: "src/a.ts", name: "y", local: false },
      found[1] as Finding,
    ];
    const { added, gone } = compare(later, e);
    assert.deepEqual(
      added.map((f) => f.name),
      ["y"],
    );
    assert.deepEqual(gone, [{ kind: "export", file: "src/a.ts", name: "x" }]);
    assert.deepEqual(lower(later, e), { exports: {}, paths: { "src/a.ts": ["src/gone"] } });
  });

  test("the list is written as the formatter writes it", () => {
    const long = Array.from({ length: 12 }, (_, i) => `aLongExportName${i}`);
    const text = exceptionsText({ exports: { "src/a.ts": ["x"], "src/b.ts": long }, paths: {} });
    assert.ok(
      text.startsWith(
        '{\n  "exports": {\n    "src/a.ts": ["x"],\n    "src/b.ts": [\n      "aLongExportName0",',
      ),
    );
    assert.ok(text.endsWith('    ]\n  },\n  "paths": {}\n}\n'));
    assert.deepEqual(JSON.parse(text).exports["src/b.ts"], long);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  broken,
  brokenText,
  compare,
  EXCEPTIONS_PATH,
  type Exceptions,
  exceptionsJson,
  importsOf,
  isPage,
  listOf,
  lower,
  partOf,
  resolve,
  scan,
} from "../../scripts/checks/lib/imports.ts";

const ROOT = join(import.meta.dirname, "..", "..");

describe("reading imports", () => {
  test("static, type, multi-line, export-from, side-effect and dynamic imports", () => {
    const text = [
      'import { a } from "./a.ts";',
      'import type { B } from "../core/b.ts";',
      "import {",
      "  c,",
      "  d,",
      '} from "./c.ts";',
      'export { e } from "./e.ts";',
      'import "./side.ts";',
      'const m = await import("./lazy.ts");',
      'import { createHash } from "node:crypto";',
    ].join("\n");
    assert.deepEqual(importsOf(text), [
      "./a.ts",
      "../core/b.ts",
      "./c.ts",
      "./e.ts",
      "./side.ts",
      "./lazy.ts",
      "node:crypto",
    ]);
  });
  test("paths resolve from the importing file", () => {
    assert.equal(resolve("src/control/ui/x.ts", "../../core/y.ts"), "src/core/y.ts");
    assert.equal(resolve("src/control/x.ts", "./ui/y.ts"), "src/control/ui/y.ts");
    assert.equal(partOf("src/harness/judge/judge.ts"), "harness");
    assert.equal(partOf("tests/harness/x.test.ts"), null);
    assert.equal(isPage("src/control/ui/components/index.ts"), true);
    assert.equal(isPage("src/control/dashboard/index.ts"), true);
    assert.equal(isPage("src/control/dashboard/rigs/page.ts"), true);
    assert.equal(isPage("src/control/store.ts"), false);
  });
});

describe("the import rule", () => {
  const rule = (file: string, spec: string) => broken(file, spec)?.rule ?? null;

  test("the parts import core, common and agents, never each other", () => {
    assert.equal(rule("src/control/store.ts", "../core/ids.ts"), null);
    assert.equal(rule("src/harness/main.ts", "../common/log.ts"), null);
    assert.equal(rule("src/supervisor/advise.ts", "../agents/prompt.ts"), null);
    assert.equal(rule("src/supervisor/advise.ts", "../harness/ledger.ts"), "part");
    assert.equal(rule("src/cli/thermite.ts", "../control/store.ts"), "part");
  });
  test("core imports nothing of the parts, and does no I/O but node:crypto", () => {
    assert.equal(rule("src/core/x.ts", "../common/log.ts"), "part");
    assert.equal(rule("src/core/x.ts", "node:crypto"), null);
    assert.equal(rule("src/core/x.ts", "node:fs"), "core-io");
    assert.equal(rule("src/core/x.ts", "zod"), null);
    assert.equal(rule("src/common/x.ts", "node:fs"), null);
  });
  test("common imports core only; agents imports core and common", () => {
    assert.equal(rule("src/common/x.ts", "../core/y.ts"), null);
    assert.equal(rule("src/common/x.ts", "../agents/y.ts"), "part");
    assert.equal(rule("src/agents/x.ts", "../common/y.ts"), null);
    assert.equal(rule("src/agents/x.ts", "../harness/y.ts"), "part");
  });
  test("domain modules never import page code; pages may", () => {
    assert.equal(rule("src/control/store.ts", "./ui/components.ts"), "page");
    assert.equal(rule("src/control/ui/runs.ts", "./components.ts"), null);
    assert.equal(rule("src/control/dashboard/index.ts", "../ui/components.ts"), null);
    assert.equal(rule("src/control/dashboard/rigs/page.ts", "../../ui/components.ts"), null);
    assert.equal(rule("src/control/ui/runs.ts", "../store.ts"), null);
    // Control's main makes control, its pages among the rest.
    assert.equal(rule("src/control/main.ts", "./dashboard/index.ts"), null);
    assert.equal(rule("src/control/api/index.ts", "../dashboard/index.ts"), "page");
  });
  test("production code never imports tests or scripts; tests may import anything", () => {
    assert.equal(rule("src/control/x.ts", "../../tests/helpers/fixtures.ts"), "tests");
    assert.equal(broken("tests/control/x.test.ts", "../../src/harness/ledger.ts"), null);
  });
  test("a broken import says what to do", () => {
    const b = broken("src/cli/thermite.ts", "../control/store.ts");
    assert.ok(b);
    assert.match(brokenText(b), /a part imports another part\. Move the shared code/);
  });
});

describe("a folder that is a module is imported through its index.ts", () => {
  // The judge and the agents are modules, and the scheduler is one inside the agents.
  const indexed = new Set([
    "src/harness/judge",
    "src/harness/agents",
    "src/harness/agents/scheduler",
  ]);
  const rule = (file: string, spec: string) => broken(file, spec, indexed)?.rule ?? null;

  test("code outside a module imports its index.ts, never a file inside it", () => {
    assert.equal(rule("src/harness/main.ts", "./judge/index.ts"), null);
    assert.equal(rule("src/harness/main.ts", "./judge/judge.ts"), "folder");
    assert.equal(rule("src/harness/agents/registry.ts", "../judge/held-out.ts"), "folder");
    const b = broken("src/harness/main.ts", "./judge/judge.ts", indexed);
    assert.ok(b);
    assert.equal(b.index, "src/harness/judge/index.ts");
    assert.match(
      brokenText(b),
      /imports a file inside it\. Import the folder's interface, src\/harness\/judge\/index\.ts, instead/,
    );
  });
  test("inside a module, files import each other directly", () => {
    assert.equal(rule("src/harness/judge/judge.ts", "./baseline.ts"), null);
    assert.equal(rule("src/harness/judge/jobs/confirm.ts", "../decide.ts"), null);
    assert.equal(rule("src/harness/agents/scheduler/lanes.ts", "./rounds.ts"), null);
  });
  test("a namespace's files are imported one by one; a module inside one is held all the same", () => {
    assert.equal(rule("src/control/api/runs.ts", "../../core/api/control/runs.ts"), null);
    assert.equal(rule("src/harness/main.ts", "../core/events/kinds.ts"), null);
    assert.equal(rule("src/control/api/index.ts", "../../common/api/control.ts"), null);
    assert.equal(rule("src/control/dashboard/rigs/page.ts", "../../ui/rigs/list.ts"), null);
    const components = new Set(["src/control/ui/components"]);
    const into = (spec: string) => broken("src/control/dashboard/session.ts", spec, components);
    assert.equal(into("../ui/components/icons.ts")?.rule, "folder");
    assert.equal(into("../ui/components/index.ts"), null);
  });
  test("a nested module is reached through the outermost index.ts that does not hold the importer", () => {
    const via = (file: string, spec: string) => broken(file, spec, indexed)?.index ?? null;
    // From outside the agents: the agents' index.ts, for a file of the scheduler too.
    assert.equal(
      via("src/harness/controller/loops.ts", "../agents/scheduler/index.ts"),
      "src/harness/agents/index.ts",
    );
    assert.equal(
      via("src/harness/controller/loops.ts", "../agents/scheduler/rounds.ts"),
      "src/harness/agents/index.ts",
    );
    assert.equal(rule("src/harness/controller/loops.ts", "../agents/index.ts"), null);
    // From inside the agents, outside the scheduler: the scheduler's index.ts.
    assert.equal(rule("src/harness/agents/registry.ts", "./scheduler/index.ts"), null);
    assert.equal(
      via("src/harness/agents/index.ts", "./scheduler/rounds.ts"),
      "src/harness/agents/scheduler/index.ts",
    );
  });
  test("a folder that is no namespace is a module, with or without its index.ts", () => {
    const b = broken("src/control/api/kits.ts", "../kits/repos.ts");
    assert.ok(b);
    assert.equal(b.rule, "folder");
    assert.match(brokenText(b), /If src\/control\/kits\/ has no index\.ts, give it one\./);
  });
  test("an import across the parts is held to the part rule first, so its exception stands", () => {
    assert.equal(rule("src/cli/thermite/local.ts", "../../harness/broker/devices.ts"), "part");
  });
  test("no exception excuses it, and none is listed for it", () => {
    const files: Record<string, string> = {
      "src/harness/judge/index.ts": 'export { Judge } from "./judge.ts";',
      "src/harness/judge/judge.ts": 'import { baselineState } from "./baseline.ts";',
      "src/harness/main.ts": 'import { Judge } from "./judge/judge.ts";',
    };
    const found = scan(Object.keys(files), (f) => files[f] ?? "");
    assert.deepEqual(
      found.map((b) => [b.file, b.target, b.rule]),
      [["src/harness/main.ts", "src/harness/judge/judge.ts", "folder"]],
    );
    assert.deepEqual(listOf(found), {});
    const listed: Exceptions = { "src/harness/main.ts": ["src/harness/judge/judge.ts"] };
    assert.deepEqual(
      compare(found, listed).added.map((b) => b.target),
      ["src/harness/judge/judge.ts"],
    );
  });
});

describe("the exceptions only shrink", () => {
  const files: Record<string, string> = {
    "src/cli/a.ts": 'import { x } from "../control/x.ts";\nimport { y } from "../control/y.ts";',
    "src/core/v.ts": 'import { readFileSync } from "node:fs";',
  };
  const found = scan(Object.keys(files), (f) => files[f] ?? "");

  test("listed imports pass; a new one fails", () => {
    const listed: Exceptions = {
      "src/cli/a.ts": ["src/control/x.ts", "src/control/y.ts"],
      "src/core/v.ts": ["node:fs"],
    };
    assert.deepEqual(listOf(found), listed);
    assert.deepEqual(compare(found, listed), { added: [], gone: [] });
    const fewer = { "src/cli/a.ts": ["src/control/x.ts"], "src/core/v.ts": ["node:fs"] };
    assert.deepEqual(
      compare(found, fewer).added.map((b) => b.target),
      ["src/control/y.ts"],
    );
  });
  test("an exception whose import is gone fails until it is lowered", () => {
    const listed: Exceptions = {
      "src/cli/a.ts": ["src/control/x.ts", "src/control/y.ts", "src/control/z.ts"],
      "src/core/v.ts": ["node:fs"],
      "src/cli/moved.ts": ["src/harness/w.ts"],
    };
    assert.deepEqual(compare(found, listed).gone, [
      { file: "src/cli/a.ts", target: "src/control/z.ts" },
      { file: "src/cli/moved.ts", target: "src/harness/w.ts" },
    ]);
    assert.deepEqual(lower(found, listed), {
      "src/cli/a.ts": ["src/control/x.ts", "src/control/y.ts"],
      "src/core/v.ts": ["node:fs"],
    });
  });
  test("the list is written as the formatter lays it out, and reads back the same", () => {
    const e: Exceptions = {
      "src/cli/a.ts": ["src/control/x.ts"],
      "src/supervisor/long-file-name.ts": Array.from(
        { length: 4 },
        (_, i) => `src/harness/m${i}-long-module-name.ts`,
      ),
    };
    const text = exceptionsJson(e);
    assert.deepEqual(JSON.parse(text), e);
    assert.match(text, /"src\/cli\/a.ts": \["src\/control\/x.ts"\]/);
    assert.match(text, /"src\/supervisor\/long-file-name.ts": \[\n {4}"/);
    assert.equal(exceptionsJson({}), "{}\n");
  });
  test("the repository's list is well formed and names only production files", () => {
    const e = JSON.parse(readFileSync(join(ROOT, EXCEPTIONS_PATH), "utf8")) as Exceptions;
    for (const [file, targets] of Object.entries(e)) {
      assert.ok(file.startsWith("src/"), file);
      assert.ok(targets.length > 0, file);
      assert.deepEqual(targets, [...targets].sort(), file);
    }
  });
});

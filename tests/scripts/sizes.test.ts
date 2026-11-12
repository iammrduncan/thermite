import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  BASELINE_PATH,
  type Baseline,
  compare,
  DUE_COMMAND,
  type Finding,
  findingText,
  inScope,
  LOWER_COMMAND,
  lineCount,
  listDue,
  lower,
  SPLIT_LINES,
  start,
  WARN_LINES,
} from "../../scripts/checks/lib/sizes.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const big = SPLIT_LINES + 100;
const sizes = (o: Record<string, number>) => new Map(Object.entries(o));
const only = (found: Finding[]): Finding => {
  assert.equal(found.length, 1, JSON.stringify(found));
  return found[0] as Finding;
};

describe("the size check's scope", () => {
  test("code and scripts in the folders in scope", () => {
    assert.equal(
      inScope("src/control/store.ts", () => ""),
      true,
    );
    assert.equal(
      inScope("scripts/checks/public.mjs", () => ""),
      true,
    );
    assert.equal(
      inScope("containers/rig/start.sh", () => ""),
      true,
    );
    assert.equal(
      inScope("docs/plan/roadmap.md", () => ""),
      false,
    );
    assert.equal(
      inScope(".claude/skills/x.ts", () => ""),
      false,
    );
    assert.equal(
      inScope("src/control/ui/style.css", () => ""),
      false,
    );
  });
  test("a kit's target code is not ours; a wrapper without an extension is, with a shebang", () => {
    assert.equal(
      inScope("kits/smoke-gpu/kernel.cu", () => ""),
      false,
    );
    assert.equal(
      inScope("containers/thermite", () => "#!"),
      true,
    );
    assert.equal(
      inScope("containers/Containerfile", () => "FR"),
      false,
    );
  });
  test("lines are counted as wc -l counts them", () => {
    assert.equal(lineCount(""), 0);
    assert.equal(lineCount("a\n"), 1);
    assert.equal(lineCount("a\nb\n"), 2);
    assert.equal(lineCount("a\nb"), 2);
  });
});

describe("the size rule", () => {
  const base: Baseline = { files: { "src/a.ts": { lines: big } } };

  test("a file over 800 lines at its baseline passes", () => {
    assert.deepEqual(compare(sizes({ "src/a.ts": big, "src/b.ts": 400 }), base), []);
  });
  test("a file over 800 lines that grows fails, with what to do", () => {
    const f = only(compare(sizes({ "src/a.ts": big + 1 }), base));
    assert.equal(f.problem, "grew");
    assert.match(findingText(f), /up from 900\. A file over 800 lines doesn't grow/);
  });
  test("a file newly over 800 lines fails", () => {
    const found = compare(sizes({ "src/a.ts": big, "src/new.ts": SPLIT_LINES + 1 }), base);
    assert.deepEqual(
      found.map((f) => [f.file, f.problem]),
      [["src/new.ts", "new"]],
    );
  });
  test("a file at exactly 800 lines is not over", () => {
    // It is over 700, so it is listed as due a split: the limit itself does not hold it yet.
    const listed: Baseline = { ...base, split_due: ["src/b.ts"] };
    assert.deepEqual(compare(sizes({ "src/a.ts": big, "src/b.ts": SPLIT_LINES }), listed), []);
  });
  test("a recorded reason lets a file stay over 800 lines and grow", () => {
    const why: Baseline = { files: { "src/a.ts": { lines: big, reason: "a table of tests" } } };
    assert.deepEqual(compare(sizes({ "src/a.ts": big + 50 }), why), []);
  });
  test("a split leaves the baseline stale until it is lowered", () => {
    const shrunk = only(compare(sizes({ "src/a.ts": big - 10 }), base));
    assert.equal(shrunk.problem, "stale");
    assert.ok(findingText(shrunk).includes(LOWER_COMMAND));
    assert.match(findingText(only(compare(sizes({}), base))), /no longer over 800/);
  });
});

describe("the warning at 700 lines", () => {
  const near = WARN_LINES + 40;
  const base: Baseline = { files: {}, split_due: ["src/a.ts"] };

  test("a file listed as due a split passes, and may grow up to 800 lines", () => {
    assert.deepEqual(compare(sizes({ "src/a.ts": near, "src/b.ts": WARN_LINES }), base), []);
    assert.deepEqual(compare(sizes({ "src/a.ts": SPLIT_LINES }), base), []);
  });
  test("a file newly over 700 lines fails until it is listed, with what to do", () => {
    const f = only(compare(sizes({ "src/a.ts": near, "src/new.ts": WARN_LINES + 1 }), base));
    assert.deepEqual([f.file, f.problem], ["src/new.ts", "due"]);
    const text = findingText(f);
    assert.match(text, /701 lines, newly over 700\. Its split is due before it reaches 800/);
    assert.ok(text.includes(DUE_COMMAND));
    assert.match(text, /Don't trim it to stay under\./);
    // A baseline from before the warning lists none: every file over 700 lines is new to it.
    const before = compare(sizes({ "src/a.ts": near }), { files: {} });
    assert.deepEqual(
      before.map((x) => x.problem),
      ["due"],
    );
  });
  test("a file at exactly 700 lines is not over", () => {
    assert.deepEqual(compare(sizes({ "src/b.ts": WARN_LINES }), { files: {}, split_due: [] }), []);
  });
  test("a listed file that was split, or is gone, fails until the list is lowered", () => {
    const split = only(compare(sizes({ "src/a.ts": 300 }), base));
    assert.equal(split.problem, "not-due");
    assert.match(findingText(split), /300 lines now, no longer over 700/);
    assert.ok(findingText(split).includes(LOWER_COMMAND));
    assert.equal(only(compare(sizes({}), base)).problem, "not-due");
    assert.deepEqual(lower(sizes({ "src/a.ts": 300 }), base), { files: {}, split_due: [] });
  });
  test("a listed file that passes 800 lines is held by the limit, and comes off the list", () => {
    const found = compare(sizes({ "src/a.ts": SPLIT_LINES + 1 }), base);
    assert.deepEqual(
      found.map((f) => f.problem),
      ["new", "not-due"],
    );
    assert.match(findingText(found[1] as Finding), /801 lines now, over 800/);
  });
  test("listing adds the files newly over 700 lines, sorted, and takes none off", () => {
    const now = sizes({ "src/c.ts": near, "src/a.ts": 300, "src/b.ts": big, "src/d.ts": 700 });
    assert.deepEqual(listDue(now, base), { files: {}, split_due: ["src/a.ts", "src/c.ts"] });
  });
});

describe("lowering and starting the baseline", () => {
  test("lower brings entries down or drops them, and never raises or adds", () => {
    const b: Baseline = {
      files: {
        "src/a.ts": { lines: big },
        "src/b.ts": { lines: big },
        "src/c.ts": { lines: big },
        "src/d.ts": { lines: big, reason: "kept" },
      },
    };
    const now = sizes({
      "src/a.ts": big - 20,
      "src/b.ts": 300,
      "src/c.ts": big + 5,
      "src/d.ts": big + 7,
      "src/new.ts": big,
    });
    assert.deepEqual(lower(now, b), {
      files: {
        "src/a.ts": { lines: big - 20 },
        "src/c.ts": { lines: big },
        "src/d.ts": { lines: big + 7, reason: "kept" },
      },
      split_due: [],
    });
  });
  test("the first baseline holds every file over 800 lines, and those over 700 as due a split", () => {
    assert.deepEqual(
      start(sizes({ "src/b.ts": big, "src/a.ts": 801, "src/c.ts": 800, "src/e.ts": 700 })),
      {
        files: { "src/a.ts": { lines: 801 }, "src/b.ts": { lines: big } },
        split_due: ["src/c.ts"],
      },
    );
  });
  test("the repository's baseline is well formed and sorted", () => {
    const b = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8")) as Baseline;
    const names = Object.keys(b.files);
    assert.deepEqual(names, [...names].sort());
    for (const [file, entry] of Object.entries(b.files)) {
      assert.ok(Number.isInteger(entry.lines) && entry.lines > SPLIT_LINES, file);
      if (entry.reason !== undefined) assert.ok(entry.reason.trim().length > 0, file);
    }
    const due = b.split_due ?? [];
    assert.deepEqual(due, [...new Set(due)].sort());
  });
});

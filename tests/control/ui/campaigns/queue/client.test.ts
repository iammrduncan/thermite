import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PICKER_CORE_JS,
  PLANNER_JS,
} from "../../../../../src/control/ui/campaigns/queue/client.ts";
import { directionName, directionTokens } from "../../../../../src/core/directions.ts";

/** A direction as the Planner tab gives it to its script (data-dirs). */
interface Dir {
  name: string;
  tried: number;
  wins: number;
  queued: number;
  lanes: string[];
  rules: string[];
  new: boolean;
}
interface Item {
  name: string;
  fresh?: boolean;
  d?: Dir;
}
interface Ctx {
  start: number;
  q: string;
}

/** The picker's page-free parts, exactly as the browser runs them. */
const core = new Function(
  `${PICKER_CORE_JS}; return { nameOf, pickContext, pickItems, pickChoose, tokensIn, figures };`,
)() as {
  nameOf: (text: string) => string;
  pickContext: (value: string, caret: number) => Ctx | null;
  pickItems: (dirs: Dir[], q: string) => Item[];
  pickChoose: (
    value: string,
    caret: number,
    ctx: Ctx,
    name: string,
  ) => { value: string; caret: number };
  tokensIn: (text: string) => ({ name: string } | { bad: string })[];
  figures: (d: Dir) => string;
};

const dir = (name: string, o: Partial<Dir> = {}): Dir => ({
  name,
  tried: 0,
  wins: 0,
  queued: 0,
  lanes: [],
  rules: [],
  new: false,
  ...o,
});
const DIRS = [
  dir("gemv-tiling", { tried: 4, rules: ["avoid"] }),
  dir("vector-loads", { tried: 1, queued: 1, rules: ["try"] }),
  dir("dequant-fusion", { tried: 7, wins: 2, queued: 2, lanes: ["lane-1"] }),
  dir("gemv-reduction", { tried: 3, wins: 1, queued: 1 }),
  dir("split-k", { queued: 1 }),
  dir("shared-memory-tiling", { new: true, rules: ["try"] }),
];
const names = (items: Item[]) => items.map((x) => (x.fresh ? `new ${x.name}` : x.name));

describe("the Planner tab's : picker (goal 066)", () => {
  test("typing : after a space or at the start opens it; a colon inside a word or a number does not", () => {
    const at = (text: string) => core.pickContext(text, text.length);
    assert.deepEqual(at(":"), { start: 0, q: "" });
    assert.deepEqual(at("stop :"), { start: 5, q: "" });
    assert.deepEqual(at("stop :gemv t"), { start: 5, q: "gemv t" });
    assert.deepEqual(at("(see :split"), { start: 5, q: "split" });
    for (const closed of [
      "note:",
      "at 10:30",
      "stop :gemv tiling:",
      "stop :gemv tiling: and ",
      "::",
      "stop : x",
    ])
      assert.equal(at(closed), null, closed);
    // Only the letters before the caret count.
    assert.deepEqual(core.pickContext("stop :vec and more", 9), { start: 5, q: "vec" });
  });

  test("the list: the run's directions holding the letters, those that start with them first, then the busiest", () => {
    // Nothing typed: every direction, busiest first (tried, up next and lanes on it), then by name.
    assert.deepEqual(names(core.pickItems(DIRS, "")), [
      "dequant-fusion",
      "gemv-reduction",
      "gemv-tiling",
      "vector-loads",
      "split-k",
      "shared-memory-tiling",
    ]);
    assert.deepEqual(names(core.pickItems(DIRS, "gemv")), ["gemv-reduction", "gemv-tiling"]);
    // A name's start comes before the same letters inside another name.
    assert.deepEqual(names(core.pickItems(DIRS, "memory")), ["shared-memory-tiling", "new memory"]);
    assert.deepEqual(names(core.pickItems(DIRS, "s")), [
      "split-k",
      "shared-memory-tiling",
      "dequant-fusion",
      "vector-loads",
    ]);
    // Spaces and dashes are the same, and case doesn't matter.
    assert.deepEqual(names(core.pickItems(DIRS, "Split K")), ["split-k"]);
    assert.deepEqual(names(core.pickItems(DIRS, "gemv til")), ["gemv-tiling"]);
    // A direction the planner has yet to design is listed, marked new by its data.
    assert.equal(core.pickItems(DIRS, "shared")[0]?.d?.new, true);
  });

  test("a name the run doesn't have is offered last as new, once it can be a name and no direction starts with it", () => {
    assert.deepEqual(names(core.pickItems(DIRS, "async copy")), ["new async copy"]);
    // Letters that some name still starts with: no new entry yet.
    assert.deepEqual(names(core.pickItems(DIRS, "ve")), ["vector-loads"]);
    // Letters inside a name only: that name, then the new one.
    assert.deepEqual(names(core.pickItems(DIRS, "loads x")), ["new loads x"]);
    assert.deepEqual(names(core.pickItems(DIRS, "reduction")), ["gemv-reduction", "new reduction"]);
    // One letter is too short for a name; spaces are kept as typed, in lowercase.
    assert.deepEqual(names(core.pickItems(DIRS, "z")), []);
    assert.deepEqual(names(core.pickItems(DIRS, "Double  Buffering")), ["new double buffering"]);
    // A run with no directions yet offers only the new name.
    assert.deepEqual(names(core.pickItems([], "split k")), ["new split k"]);
  });

  test("picking replaces the typed letters, and the rest of the word, with :name: and a space", () => {
    const pick = (text: string, caret: number, name: string) => {
      const ctx = core.pickContext(text, caret);
      assert.ok(ctx, text);
      return core.pickChoose(text, caret, ctx, name);
    };
    assert.deepEqual(pick("stop :gem", 9, "gemv-tiling"), {
      value: "stop :gemv-tiling: ",
      caret: 19,
    });
    // In the middle of the text: the word's end goes, the rest stays with one space.
    assert.deepEqual(pick("stop :vec and more", 9, "vector-loads"), {
      value: "stop :vector-loads: and more",
      caret: 19,
    });
    assert.deepEqual(pick("stop :vec:", 9, "vector-loads").value, "stop :vector-loads: ");
    assert.deepEqual(pick("try :", 5, "double buffering").value, "try :double buffering: ");
    // What a pick writes names that direction, for control and the planner alike.
    assert.deepEqual(directionTokens(pick("try :", 5, "double buffering").value), [
      "double-buffering",
    ]);
  });

  test("names and :name: tokens read as control reads them", () => {
    for (const text of [
      "shared memory tiling",
      ":Split K:",
      " :gemv-tiling: ",
      "x",
      "anything with $hared memory!",
      "a direction whose name is far too long to be one",
      "::",
    ])
      assert.equal(core.nameOf(text), directionName(text) ?? "", text);
    const text =
      "stop :gemv tiling: at 10:30, put :Vector-Loads: first, and :a direction whose name is far too long to be one: later";
    assert.deepEqual(core.tokensIn(text), [
      { name: "gemv-tiling" },
      { name: "vector-loads" },
      { bad: ":a direction whose name is far too long to be one:" },
    ]);
    assert.deepEqual(
      core.tokensIn(text).flatMap((t) => ("name" in t ? [t.name] : [])),
      directionTokens(text),
    );
  });

  test("each direction's figures in words, and the script parses", () => {
    assert.equal(core.figures(DIRS[2] as Dir), "7 tried · 2 wins · 2 up next · lane-1 on it now");
    assert.equal(core.figures(dir("split-k", { queued: 1 })), "not tried yet · 1 up next");
    assert.equal(
      core.figures(dir("x", { new: true })),
      "new: the planner designs it at its next round",
    );
    assert.doesNotThrow(() => new Function(PLANNER_JS));
  });
});

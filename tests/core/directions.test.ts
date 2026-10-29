import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommandPayloads } from "../../src/core/commands.ts";
import {
  CONVERT_PER_ROUND,
  convertedRule,
  directionName,
  directionOf,
  directionParts,
  directionsToDesign,
  directionTokens,
  isLegacyRule,
  notADirection,
  researchDirectionRefusal,
  rulesToConvert,
} from "../../src/core/directions.ts";
import { StructuredDirective } from "../../src/core/directives.ts";

describe("directions, written as plain words or :name: (goal 066)", () => {
  test("a direction's name: case, spaces and dashes don't matter; colons are optional", () => {
    for (const written of [
      "shared memory tiling",
      "Shared Memory Tiling",
      ":shared memory tiling:",
      " :shared-memory  tiling: ",
      "shared-memory-tiling",
    ])
      assert.equal(directionName(written), "shared-memory-tiling", written);
    assert.equal(directionName(":split-k:"), "split-k");
    // An experiment's words map to the same name, so a rule and an experiment meet.
    assert.equal(directionOf("Shared memory tiling"), "shared-memory-tiling");
  });

  test("text that can't be a direction's name is refused in plain words", () => {
    for (const bad of ["", "x", ":x:", "anything with $hared memory!", "tiles; and more", "::"])
      assert.equal(directionName(bad), undefined, bad);
    assert.match(
      notADirection("anything with $hared memory!"),
      /is not a direction's name: write it in letters, digits, spaces and dashes, such as shared memory tiling or :shared memory tiling:/,
    );
    assert.match(
      notADirection("a direction whose name is far too long to be one"),
      /is too long for a direction's name: use at most 41 letters/,
    );
    assert.equal(notADirection("loop tiling"), "");
  });

  test("a text such as a message names directions as :name:, each once, and nothing else does", () => {
    assert.deepEqual(
      directionTokens("stop :gemv tiling: and put :Vector-Loads: first, then :gemv-tiling: again"),
      ["gemv-tiling", "vector-loads"],
    );
    for (const none of [
      "stop trying tiling",
      "at 10:30:45 it stalled",
      "note: try it",
      "a ratio 1 :2 vs 3",
      ":x: is too short",
      "http://example.com:8080/x",
    ])
      assert.deepEqual(directionTokens(none), [], none);
    assert.deepEqual(directionTokens("(see :split k:)"), ["split-k"]);
  });

  test("a message to the planner, in parts: plain words, each :name: as a direction, and a :name: too long to be one", () => {
    const long = ":a direction whose name is far too long to be one:";
    const text = `stop :gemv tiling: at 10:30, put :Vector-Loads: first, and ${long} later`;
    const parts = directionParts(text);
    assert.equal(parts.map((p) => p.text).join(""), text);
    assert.deepEqual(
      parts.map((p) => (p.name ? `[${p.name}]` : p.bad ? `[bad ${p.text}]` : p.text)),
      [
        "stop ",
        "[gemv-tiling]",
        " at 10:30, put ",
        "[vector-loads]",
        " first, and ",
        `[bad ${long}]`,
        " later",
      ],
    );
    assert.match(
      parts.find((p) => p.bad)?.bad ?? "",
      /is too long for a direction's name: use at most 41 letters, digits, spaces and dashes/,
    );
    assert.deepEqual(directionParts("plain words only"), [{ text: "plain words only" }]);
    assert.deepEqual(directionParts(""), []);
  });

  test("a rule's direction is kept as its name; words (match) are no longer a rule", () => {
    const ok = StructuredDirective.parse({
      kind: "avoid",
      family: ":Shared memory tiling:",
      rationale: "slow",
    });
    assert.equal(ok.family, "shared-memory-tiling");
    const words = StructuredDirective.safeParse({
      kind: "avoid",
      match: "anything with shared memory",
      rationale: "slow",
    });
    assert.ok(!words.success);
    assert.match(
      words.error.issues.map((i) => i.message).join("; "),
      /a rule no longer takes match: name its direction in family, in plain words or as :name:/,
    );
    // A trial_minutes rule gives its minutes, a whole number from 1 to 1440.
    assert.equal(
      StructuredDirective.parse({ kind: "trial_minutes", value: 120, rationale: "r" }).value,
      120,
    );
    for (const value of [0, 1441, 1.5, "120", undefined]) {
      const bad = StructuredDirective.safeParse({ kind: "trial_minutes", value, rationale: "r" });
      assert.ok(!bad.success, String(value));
      assert.match(bad.error.issues[0]?.message ?? "", /a trial_minutes rule gives value: minutes/);
    }
    // A keep_working rule is on or off.
    assert.equal(
      StructuredDirective.parse({ kind: "keep_working", value: "on", rationale: "r" }).value,
      "on",
    );
    for (const value of ["yes", 1, undefined]) {
      const bad = StructuredDirective.safeParse({ kind: "keep_working", value, rationale: "r" });
      assert.ok(!bad.success, String(value));
      assert.match(
        bad.error.issues[0]?.message ?? "",
        /a keep_working rule gives value: on or off/,
      );
    }
    // An experiment's direction written :name: is kept without its colons.
    const add = CommandPayloads.queue_add.parse({ run: "r-1", title: "t", family: ":split k:" });
    assert.equal(add.family, "split k");
    assert.equal(
      CommandPayloads.queue_add.parse({ run: "r-1", title: "t", family: "Loop: order" }).family,
      "Loop: order",
    );
  });

  test("an old rule in words is legacy; the directions rules name that the run lacks wait for the planner", () => {
    assert.ok(isLegacyRule({ kind: "avoid", match: "anything slow" }));
    assert.ok(!isLegacyRule({ kind: "avoid", family: "tiling" }));
    assert.ok(!isLegacyRule({ kind: "note", value: "x" }));
    assert.deepEqual(
      directionsToDesign(
        [
          { id: 1, body: { kind: "avoid", family: "tiling", rationale: "a" } },
          { id: 2, body: { kind: "try", family: "split-k", rationale: "b" } },
          { id: 3, body: { kind: "mandate", family: "split-k", rationale: "c" } },
          { id: 4, body: { kind: "avoid", match: "anything slow", rationale: "d" } },
        ],
        ["tiling"],
      ),
      [
        {
          name: "split-k",
          rules: [
            { id: 2, kind: "try", rationale: "b" },
            { id: 3, kind: "mandate", rationale: "c" },
          ],
        },
      ],
    );
    assert.match(
      researchDirectionRefusal(["blogs"]),
      /^A research run's directions are its task kinds: :explore:, :primary:, :contradict:, :consolidate:\. Its planner designs no new direction, so a rule for :blogs: would do nothing\. Name a task kind\.$/,
    );
  });

  test("an old rule in words converts to a rule on a direction: the same kind, why and source, and its words", () => {
    const rules = [
      { id: 1, body: { kind: "avoid", family: "tiling", rationale: "a" } },
      { id: 4, body: { kind: "mandate", match: "anything with vector loads", rationale: "b" } },
      { id: 6, body: { kind: "note", value: "x", rationale: "c" } },
    ];
    assert.deepEqual(rulesToConvert(rules), [
      { rule: 4, kind: "mandate", words: "anything with vector loads", rationale: "b" },
    ]);
    // A round converts at most CONVERT_PER_ROUND, the oldest first; the rest wait.
    const many = Array.from({ length: CONVERT_PER_ROUND + 3 }, (_, i) => ({
      id: i + 1,
      body: { kind: "avoid", match: `words ${i + 1}`, rationale: "r" },
    }));
    assert.deepEqual(
      rulesToConvert(many).map((r) => r.rule),
      Array.from({ length: CONVERT_PER_ROUND }, (_, i) => i + 1),
    );
    const old = {
      kind: "avoid",
      match: "anything that uses shared memory",
      rationale: "slow on this GPU",
      citations: ["run 3"],
      from_message: 2,
    };
    const next = convertedRule(7, old, "shared-memory");
    assert.deepEqual(next, {
      kind: "avoid",
      family: "shared-memory",
      rationale: "slow on this GPU",
      citations: ["run 3"],
      from_message: 2,
      converted_from: { rule: 7, words: "anything that uses shared memory" },
    });
    assert.ok(!isLegacyRule(next), "the new rule names a direction: code keeps it");
  });
});

/**
 * The rules a plan is held to: AVOID and MANDATE, the directions rules name, old rules in words to
 * convert, a kind of rule as a direction's name; and the fallback plan.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fallbackPlan,
  type PlannerInput,
  plannerContext,
  validatePlan,
} from "../../../../src/harness/agents/planner/index.ts";
import { base } from "./setup.ts";

describe("planner", () => {
  test("AVOID families are never assigned and MANDATE families always are", () => {
    const input: PlannerInput = {
      ...base,
      directives: [
        {
          id: 1,
          body: { kind: "avoid", family: "tiling", rationale: "measured null", citations: [] },
        },
        {
          id: 2,
          body: { kind: "mandate", family: "vectorize", rationale: "try SIMD", citations: [] },
        },
      ],
    };
    const bad = validatePlan(
      {
        assignments: [
          { lane: "lane-1", family: "tiling", focus: "x tiles", parent: "champion" },
          { lane: "lane-2", family: "unroll", focus: "unroll 4", parent: "champion" },
        ],
      },
      input,
    );
    assert.ok(bad.errors.some((e) => /AVOID/.test(e)));
    assert.ok(bad.errors.some((e) => /MANDATE/.test(e)));
    const f = fallbackPlan(input);
    assert.ok(!f.assignments.some((a) => a.family === "tiling"));
    assert.ok(f.assignments.some((a) => a.family === "vectorize"));
    assert.deepEqual(
      f.newFamilies.map((x) => x.id),
      ["vectorize"],
    );
  });

  test("rules name directions (goal 066): the run's, or new ones the planner designs in its words", () => {
    const input: PlannerInput = {
      ...base,
      directions: ["tiling", "unroll"],
      queue: {
        up_next: [{ id: "x-000000000001", title: "tile it", family: "tiling", by: "owner" }],
        proposed: [],
        in_progress: [],
        tried: [],
      },
      directives: [
        // The owner's rule for a direction the run doesn't have yet: the planner designs it.
        {
          id: 7,
          body: { kind: "try", family: "split-k", rationale: "won elsewhere", citations: [] },
        },
        // An old rule in words: never designed, but converted (below).
        { id: 8, body: { kind: "avoid", match: "anything slow", rationale: "x", citations: [] } },
      ],
      ownerMessages: [
        { id: 1, text: "stop :tiling: for now" },
        { id: 2, text: "and never touch the timer code" },
      ],
    };
    const assignments = [
      { lane: "lane-1", experiment: "x-000000000001", why: "w" },
      { lane: "lane-2", title: "split the k loop", family: "split k", why: "rule 7" },
    ];
    const context = JSON.parse(plannerContext(input)) as Record<string, unknown>;
    assert.deepEqual(context.directions, ["tiling", "unroll"]);
    assert.deepEqual(context.to_design, [
      { name: "split-k", rules: [{ id: 7, kind: "try", rationale: "won elsewhere" }] },
    ]);
    assert.deepEqual(
      (context.owner_messages as { directions: string[] }[]).map((m) => m.directions),
      [["tiling"], []],
    );
    assert.equal((context.directives as { legacy?: boolean }[])[1]?.legacy, true);
    // Not designed, a rule for a new direction, words: each refused with what to do.
    const bad = validatePlan(
      {
        assignments,
        rules: [
          { kind: "avoid", family: "timer code", rationale: "asked", from_message: 2 },
          { kind: "avoid", match: "the timer", rationale: "asked", from_message: 2 },
          { kind: "avoid", family: "tiling", rationale: "asked", from_message: 5 },
        ],
      },
      input,
    );
    assert.deepEqual(bad.errors, [
      "rule 7 names :split-k:, a direction this run doesn't have yet: design it in new_families, with its name and what it means, in your words",
      "rules: :timer-code: is not one of the run's directions: to make a rule for a new direction, design it in new_families too",
      "rules: a rule names its direction in family: a rule no longer takes match",
      "rules: message 5 is not one of the owner's messages given to you",
      'rule 8 is an old rule in words ("anything slow"): convert it, in convert, to the direction its words mean: one in directions, or a new one you design in new_families',
    ]);
    // Designed in the answer: the rules stand, by name, from the owner's plain words or :name:.
    const good = validatePlan(
      {
        assignments,
        new_families: [
          { id: ":split k:", description: "split the reduction over k across blocks" },
          { id: "Timer code", description: "any change to the timing code" },
        ],
        rules: [
          { kind: "avoid", family: ":tiling:", rationale: "you said so", from_message: 1 },
          { kind: "avoid", family: "timer code", rationale: "asked", from_message: 2 },
        ],
        convert: [{ rule: 8, family: ":unroll:" }],
      },
      input,
    );
    assert.deepEqual(good.errors, []);
    assert.deepEqual(good.plan?.convert, [{ rule: 8, family: "unroll" }]);
    assert.deepEqual(
      good.plan?.newFamilies.map((f) => f.id),
      ["split-k", "timer-code"],
    );
    assert.deepEqual(
      good.plan?.rules.map((r) => [r.kind, r.family, r.from_message]),
      [
        ["avoid", "tiling", 1],
        ["avoid", "timer-code", 2],
      ],
    );
  });

  test("each old rule in words is converted: to the run's direction its words mean, or a new one designed in the answer", () => {
    const input: PlannerInput = {
      ...base,
      directions: ["tiling", "unroll"],
      directives: [
        { id: 3, body: { kind: "try", family: "tiling", rationale: "won", citations: [] } },
        {
          id: 4,
          body: {
            kind: "avoid",
            match: "anything that uses shared memory",
            rationale: "slow on this GPU",
            citations: [],
          },
        },
        {
          id: 5,
          body: { kind: "mandate", match: "loop unrolling", rationale: "r", citations: [] },
        },
      ],
    };
    const assignments = [
      { lane: "lane-1", title: "unroll by 4", family: "unroll", why: "w" },
      { lane: "lane-2", title: "tile it", family: "tiling", why: "w" },
    ];
    // The model reads each one to convert, with its kind, words and why.
    const context = JSON.parse(plannerContext(input)) as Record<string, unknown>;
    assert.deepEqual(context.to_convert, [
      {
        rule: 4,
        kind: "avoid",
        words: "anything that uses shared memory",
        rationale: "slow on this GPU",
      },
      { rule: 5, kind: "mandate", words: "loop unrolling", rationale: "r" },
    ]);
    // Left out, a rule that is not one, twice, a new direction not designed, a kind of rule, or
    // text that is no direction: each refused with what to do.
    const bad = validatePlan(
      {
        assignments,
        convert: [
          { rule: 4, family: "shared memory" },
          { rule: 3, family: "tiling" },
          { rule: 9, family: "tiling" },
          { rule: 4, family: "tiling" },
        ],
      },
      input,
    );
    assert.deepEqual(bad.errors, [
      "convert: rule 4: :shared-memory: is not one of the run's directions: to convert it to a new direction, design it in new_families too",
      "convert: rule 3 is not an old rule in words in to_convert",
      "convert: rule 9 is not an old rule in words in to_convert",
      "convert: rule 4 is converted twice: give it one direction",
      'rule 5 is an old rule in words ("loop unrolling"): convert it, in convert, to the direction its words mean: one in directions, or a new one you design in new_families',
    ]);
    assert.deepEqual(
      validatePlan(
        {
          assignments,
          convert: [
            { rule: 4, family: "avoid" },
            { rule: 5, family: "loop $unrolling" },
          ],
        },
        input,
      ).errors.map((e) =>
        e.replace(/ is a kind of rule .*/, "").replace(/ is not a direction.*/, ""),
      ),
      ['convert: rule 4: "avoid"', 'convert: rule 5: "loop $unrolling"'],
    );
    // One the run has, or one designed in the same answer: both stand, by name.
    const good = validatePlan(
      {
        assignments,
        new_families: [
          { id: "Shared memory", description: "kernels that stage data in shared memory" },
        ],
        convert: [
          { rule: 4, family: ":shared memory:" },
          { rule: 5, family: "unroll" },
        ],
      },
      input,
    );
    assert.deepEqual(good.errors, []);
    assert.deepEqual(good.plan?.convert, [
      { rule: 4, family: "shared-memory" },
      { rule: 5, family: "unroll" },
    ]);
    // With no old rule in words, nothing to convert.
    assert.equal(
      (JSON.parse(plannerContext(base)) as Record<string, unknown>).to_convert,
      undefined,
    );
    assert.deepEqual(
      validatePlan({ assignments }, { ...base, directions: ["tiling", "unroll"] }).errors,
      [],
    );
  });

  test("a kind of rule is never a direction's name", () => {
    const bad = validatePlan(
      {
        new_families: [{ id: "mandate", description: "what the owner mandated" }],
        add: [{ ref: "n-1", title: "wider loads", family: "Lane_Count", why: "more lanes" }],
        assignments: [
          { lane: "lane-1", family: "try", focus: "unroll by 4", parent: "champion" },
          { lane: "lane-2", experiment: "n-1", parent: "champion" },
        ],
      },
      base,
    );
    assert.deepEqual(
      bad.errors.map((e) => e.replace(/ is a kind of rule .*/, "")),
      ['new_families: "mandate"', 'add n-1: the family "Lane_Count"', 'lane-1: the family "try"'],
    );
    assert.match(
      String(bad.errors[0]),
      /avoid, try, mandate, priority, lane_count, trial_minutes, keep_working, note/,
    );
    const ok = validatePlan(
      {
        new_families: [{ id: "try-unroll", description: "unroll the tail" }],
        assignments: [
          { lane: "lane-1", family: "try-unroll", focus: "unroll by 4", parent: "champion" },
          { lane: "lane-2", family: "notes-cache", focus: "cache the notes", parent: "champion" },
        ],
      },
      base,
    );
    assert.deepEqual(ok.errors, [], "a name that only starts with one is fine");
  });

  test("the fallback plan skips directions whose goals the champion already meets (goal 079)", () => {
    const fam = (id: string, description: string, attempts = 0) => ({
      id,
      description,
      status: "live" as const,
      attempts,
      verdicts: {},
      best_delta: null,
    });
    const input: PlannerInput = {
      ...base,
      laneCount: 2,
      families: [
        fam("make-it-fast", "reach the fast goal", 0),
        fam("correctness", "keep the correct goal", 0),
        fam("tidy", "small clean-ups", 5),
      ],
      goalReport: {
        champion_seq: 2,
        goals: [
          { goal: "fast", status: "unmet", reasons: "" },
          { goal: "correct", status: "met", reasons: "" },
        ],
      },
    };
    const f = fallbackPlan(input);
    const given = f.assignments.map((x) => x.family);
    assert.ok(!given.includes("correctness"), "its only goal is met");
    // The direction for the unmet goal comes first, then the rest.
    assert.deepEqual(given, ["make-it-fast", "tidy"]);
    // With every direction's goals met, a direction for each goal still unmet.
    const done = fallbackPlan({
      ...input,
      families: [fam("make-it-fast", "reach the fast goal")],
      goalReport: {
        champion_seq: 3,
        goals: [
          { goal: "fast", status: "met", reasons: "" },
          { goal: "small", status: "unmet", reasons: "" },
        ],
      },
    });
    assert.deepEqual(
      done.newFamilies.map((x) => x.id),
      ["small"],
    );
    assert.deepEqual(
      done.assignments.map((x) => x.family),
      ["small", "small"],
    );
    // Without a goal report, nothing is skipped.
    assert.equal(fallbackPlan({ ...input, goalReport: undefined }).assignments.length, 2);
  });
});

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
  test("AVOID directions are never assigned and MANDATE directions always are", () => {
    const input: PlannerInput = {
      ...base,
      directives: [
        {
          id: 1,
          body: { kind: "avoid", direction: "tiling", rationale: "measured null", citations: [] },
        },
        {
          id: 2,
          body: { kind: "mandate", direction: "vectorize", rationale: "try SIMD", citations: [] },
        },
      ],
    };
    const bad = validatePlan(
      {
        assignments: [
          { lane: "lane-1", direction: "tiling", focus: "x tiles", parent: "champion" },
          { lane: "lane-2", direction: "unroll", focus: "unroll 4", parent: "champion" },
        ],
      },
      input,
    );
    assert.ok(bad.errors.some((e) => /AVOID/.test(e)));
    assert.ok(bad.errors.some((e) => /MANDATE/.test(e)));
    const f = fallbackPlan(input);
    assert.ok(!f.assignments.some((a) => a.direction === "tiling"));
    assert.ok(f.assignments.some((a) => a.direction === "vectorize"));
    assert.deepEqual(
      f.newDirections.map((x) => x.id),
      ["vectorize"],
    );
  });

  test("rules name directions (goal 066): the run's, or new ones the planner designs in its words", () => {
    const input: PlannerInput = {
      ...base,
      directions: ["tiling", "unroll"],
      queue: {
        up_next: [{ id: "x-000000000001", title: "tile it", direction: "tiling", by: "owner" }],
        proposed: [],
        in_progress: [],
        tried: [],
      },
      directives: [
        // The owner's rule for a direction the run doesn't have yet: the planner designs it.
        {
          id: 7,
          body: { kind: "try", direction: "split-k", rationale: "won elsewhere", citations: [] },
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
      { lane: "lane-2", title: "split the k loop", direction: "split k", why: "rule 7" },
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
          { kind: "avoid", direction: "timer code", rationale: "asked", from_message: 2 },
          { kind: "avoid", match: "the timer", rationale: "asked", from_message: 2 },
          { kind: "avoid", direction: "tiling", rationale: "asked", from_message: 5 },
        ],
      },
      input,
    );
    assert.deepEqual(bad.errors, [
      "rule 7 names :split-k:, a direction this run doesn't have yet: design it in new_directions, with its name and what it means, in your words",
      "rules: :timer-code: is not one of the run's directions: to make a rule for a new direction, design it in new_directions too",
      "rules: a rule gives its direction in direction: a rule no longer takes match",
      "rules: message 5 is not one of the owner's messages given to you",
      'rule 8 is an old rule in words ("anything slow"): convert it, in convert, to the direction its words mean: one in directions, or a new one you design in new_directions',
    ]);
    // Designed in the answer: the rules stand, by name, from the owner's plain words or :name:.
    const good = validatePlan(
      {
        assignments,
        new_directions: [
          { id: ":split k:", description: "split the reduction over k across blocks" },
          { id: "Timer code", description: "any change to the timing code" },
        ],
        rules: [
          { kind: "avoid", direction: ":tiling:", rationale: "you said so", from_message: 1 },
          { kind: "avoid", direction: "timer code", rationale: "asked", from_message: 2 },
        ],
        convert: [{ rule: 8, direction: ":unroll:" }],
      },
      input,
    );
    assert.deepEqual(good.errors, []);
    assert.deepEqual(good.plan?.convert, [{ rule: 8, direction: "unroll" }]);
    assert.deepEqual(
      good.plan?.newDirections.map((f) => f.id),
      ["split-k", "timer-code"],
    );
    assert.deepEqual(
      good.plan?.rules.map((r) => [r.kind, r.direction, r.from_message]),
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
        { id: 3, body: { kind: "try", direction: "tiling", rationale: "won", citations: [] } },
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
      { lane: "lane-1", title: "unroll by 4", direction: "unroll", why: "w" },
      { lane: "lane-2", title: "tile it", direction: "tiling", why: "w" },
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
          { rule: 4, direction: "shared memory" },
          { rule: 3, direction: "tiling" },
          { rule: 9, direction: "tiling" },
          { rule: 4, direction: "tiling" },
        ],
      },
      input,
    );
    assert.deepEqual(bad.errors, [
      "convert: rule 4: :shared-memory: is not one of the run's directions: to convert it to a new direction, design it in new_directions too",
      "convert: rule 3 is not an old rule in words in to_convert",
      "convert: rule 9 is not an old rule in words in to_convert",
      "convert: rule 4 is converted twice: give it one direction",
      'rule 5 is an old rule in words ("loop unrolling"): convert it, in convert, to the direction its words mean: one in directions, or a new one you design in new_directions',
    ]);
    assert.deepEqual(
      validatePlan(
        {
          assignments,
          convert: [
            { rule: 4, direction: "avoid" },
            { rule: 5, direction: "loop $unrolling" },
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
        new_directions: [
          { id: "Shared memory", description: "kernels that stage data in shared memory" },
        ],
        convert: [
          { rule: 4, direction: ":shared memory:" },
          { rule: 5, direction: "unroll" },
        ],
      },
      input,
    );
    assert.deepEqual(good.errors, []);
    assert.deepEqual(good.plan?.convert, [
      { rule: 4, direction: "shared-memory" },
      { rule: 5, direction: "unroll" },
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
        new_directions: [{ id: "mandate", description: "what the owner mandated" }],
        add: [{ ref: "n-1", title: "wider loads", direction: "Lane_Count", why: "more lanes" }],
        assignments: [
          { lane: "lane-1", direction: "try", focus: "unroll by 4", parent: "champion" },
          { lane: "lane-2", experiment: "n-1", parent: "champion" },
        ],
      },
      base,
    );
    assert.deepEqual(
      bad.errors.map((e) => e.replace(/ is a kind of rule .*/, "")),
      [
        'new_directions: "mandate"',
        'add n-1: the direction "Lane_Count"',
        'lane-1: the direction "try"',
      ],
    );
    assert.match(
      String(bad.errors[0]),
      /avoid, try, mandate, priority, lane_count, trial_minutes, keep_working, planner_note/,
    );
    const ok = validatePlan(
      {
        new_directions: [{ id: "try-unroll", description: "unroll the tail" }],
        assignments: [
          { lane: "lane-1", direction: "try-unroll", focus: "unroll by 4", parent: "champion" },
          {
            lane: "lane-2",
            direction: "notes-cache",
            focus: "cache the notes",
            parent: "champion",
          },
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
      registry: [
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
    const given = f.assignments.map((x) => x.direction);
    assert.ok(!given.includes("correctness"), "its only goal is met");
    // The direction for the unmet goal comes first, then the rest.
    assert.deepEqual(given, ["make-it-fast", "tidy"]);
    // With every direction's goals met, a direction for each goal still unmet.
    const done = fallbackPlan({
      ...input,
      registry: [fam("make-it-fast", "reach the fast goal")],
      goalReport: {
        champion_seq: 3,
        goals: [
          { goal: "fast", status: "met", reasons: "" },
          { goal: "small", status: "unmet", reasons: "" },
        ],
      },
    });
    assert.deepEqual(
      done.newDirections.map((x) => x.id),
      ["small"],
    );
    assert.deepEqual(
      done.assignments.map((x) => x.direction),
      ["small", "small"],
    );
    // Without a goal report, nothing is skipped.
    assert.equal(fallbackPlan({ ...input, goalReport: undefined }).assignments.length, 2);
  });

  test("a round planned while a lane is on a trial plans the free lanes only (goal 215)", () => {
    const queue = {
      up_next: [
        {
          id: "x-1",
          title: "port the patch",
          by: "owner",
          tries: {
            of: 3,
            try: 2,
            lanes: ["lane-2"],
            earlier: [{ n: 1, lane: "lane-2", result: "no_attempt" }],
          },
        },
        { id: "x-2", title: "other", by: "owner" },
      ],
      proposed: [],
      in_progress: [{ id: "x-0", title: "a long build", by: "owner", lane: "lane-1" }],
      tried: [],
    };
    const input: PlannerInput = { ...base, queue, busy: [{ lane: "lane-1", experiment: "x-0" }] };
    const context = JSON.parse(plannerContext(input)) as Record<string, unknown>;
    assert.deepEqual(context.lanes, ["lane-2"]);
    assert.deepEqual(context.busy_lanes, [{ lane: "lane-1", experiment: "x-0" }]);
    // The free lane alone: the plan the lab's model gave, refused before (goal 215).
    const good = validatePlan(
      { assignments: [{ lane: "lane-2", experiment: "x-2", parent: "champion" }] },
      input,
    );
    assert.deepEqual(good.errors, []);
    assert.deepEqual(
      good.plan?.handout.map((h) => h.lane),
      ["lane-2"],
    );
    // The busy lane named too, on what it is on: refused with why, and only that.
    const busy = validatePlan(
      {
        assignments: [
          { lane: "lane-1", experiment: "x-0", parent: "champion" },
          { lane: "lane-2", experiment: "x-2", parent: "champion" },
        ],
      },
      input,
    );
    assert.deepEqual(busy.errors, [
      "lane-1 is still on a trial (experiment x-0): leave it out. The fixed rules give it the next experiment up next after your hand-out, which it starts when its trial ends",
    ]);
    // An experiment lane-2 tried waits for lane-1, which has not, though lane-1 is busy.
    const tried = validatePlan(
      { assignments: [{ lane: "lane-2", experiment: "x-1", parent: "champion" }] },
      input,
    );
    assert.deepEqual(tried.errors, [
      "lane-2: experiment x-1 was tried on lane-2 already (try 2 of 3 is next): leave it up next for lane-1, which has not tried it and is still on a trial",
    ]);
    // With every lane busy, the plan gives every lane one, as before.
    const all = {
      ...input,
      busy: [
        { lane: "lane-1", experiment: "x-0" },
        { lane: "lane-2", experiment: null },
      ],
    };
    assert.deepEqual(JSON.parse(plannerContext(all)).lanes, ["lane-1", "lane-2"]);
    assert.equal(JSON.parse(plannerContext(all)).busy_lanes, undefined);
  });
});

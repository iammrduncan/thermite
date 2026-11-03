import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type GoalContract, parseContract } from "../../../src/core/contract.ts";
import { goalChecks, parseGoalChecks } from "../../../src/core/goal/index.ts";
import { KitSchema } from "../../../src/core/kit.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/** Goal 082: each goal's real check, from the contract and the kit. */

const kit = KitSchema.parse({
  schema_version: 1,
  name: "sum-kit",
  target: "cpu",
  build: { command: ["make"], outputs: ["out"] },
  cells: {
    small: { n: 128, flags: "--fast --check", work: 1 },
    diag: { params: { n: 8192, flags: "--full" }, timeout_s: 1800 },
    hidden: { n: 4096, secret: "HIDDEN-INPUT", work: 2 },
  },
  run: { command: ["{build:out/bench}", "{params}", "{out}"], timeout_s: 60 },
  metrics: { ops: { unit: "op/s", work: "work" } },
  check: { command: ["node", "{kit:check.mjs}"] },
  verifiers: {
    correct: { cells: ["small", "hidden"], priority: 1 },
    deep: { cells: ["diag", "gone"], requires: ["correct"] },
  },
});

function contract(): GoalContract {
  const p = parseContract({
    schema_version: 1,
    campaign: "sum-goals",
    version: 1,
    title: "Sum goals",
    mode: "goal",
    project: {
      repo: "proj",
      commit: "a".repeat(40),
      kit: { repo: "sum-kit", commit: "b".repeat(40) },
    },
    target: { type: "cpu", class: "test" },
    goals: [
      {
        id: "correct",
        description: "still correct",
        verify: { type: "code", verifier: "correct" },
      },
      { id: "deep", description: "the deep check", verify: { type: "code", verifier: "deep" } },
      {
        id: "fast",
        description: "fast enough",
        verify: {
          type: "metric_threshold",
          metric: "ops",
          op: ">=",
          value: 5e7,
          cells: ["small", "hidden"],
        },
      },
      {
        id: "missing",
        description: "a verifier the kit lacks",
        verify: { type: "code", verifier: "nope" },
      },
      {
        id: "clear",
        description: "readable",
        required: false,
        verify: { type: "review", criteria: ["clear names"] },
      },
    ],
    deliverable: "a commit",
    editable_paths: ["src/**"],
    held_out_cells: ["hidden"],
    threshold_reps: 3,
  });
  assert.ok(p.ok && p.contract.mode === "goal", JSON.stringify(p));
  return p.contract as GoalContract;
}

describe("each goal's real check (goal 082)", () => {
  test("with the kit: measured cases with their parameters and limits, held-out cases by name only", () => {
    const c = goalChecks(contract(), { kit, repo: "sum-kit", commit: "b".repeat(40) });
    assert.deepEqual(c.kit, { name: "sum-kit", repo: "sum-kit", commit: "b".repeat(40) });
    assert.deepEqual(c.run_command, ["{build:out/bench}", "{params}", "{out}"]);
    assert.equal(c.timeout_s, 60);
    const by = Object.fromEntries(c.goals.map((g) => [g.goal, g]));
    assert.equal(by.correct?.how, "verifier");
    assert.equal(by.correct?.priority, 1);
    // Measured first; the held-out case by name, with its limit, never its parameters.
    assert.deepEqual(by.correct?.cells, [
      {
        name: "small",
        held_out: false,
        params: { n: 128, flags: "--fast --check", work: 1 },
        args: "n=128\nflags=--fast --check\nwork=1",
        timeout_s: 60,
      },
      { name: "hidden", held_out: true, timeout_s: 60 },
    ]);
    assert.ok(!JSON.stringify(c).includes("HIDDEN-INPUT"));
    // A cell's own limit, a cell the kit lacks, the gate.
    assert.deepEqual(by.deep?.requires, ["correct"]);
    assert.deepEqual(by.deep?.cells, [
      {
        name: "diag",
        held_out: false,
        params: { n: 8192, flags: "--full" },
        args: "n=8192\nflags=--full",
        timeout_s: 1800,
      },
      { name: "gone", held_out: false, missing: true },
    ]);
    assert.equal(by.fast?.how, "threshold");
    assert.deepEqual(
      [by.fast?.metric, by.fast?.op, by.fast?.value, by.fast?.unit, by.fast?.reps],
      ["ops", ">=", 5e7, "op/s", 3],
    );
    assert.deepEqual(
      by.fast?.cells?.map((x) => [x.name, x.held_out]),
      [
        ["small", false],
        ["hidden", true],
      ],
    );
    assert.deepEqual(by.missing?.problems, ["the kit has no verifier nope"]);
    assert.equal(by.missing?.cells, null);
    assert.deepEqual(by.clear?.criteria, ["clear names"]);
    assert.equal(by.clear?.required, false);
  });

  test("without the kit: what the contract says, and no case it cannot know", () => {
    const c = goalChecks(contract());
    assert.equal(c.kit, null);
    assert.equal(c.run_command, null);
    const by = Object.fromEntries(c.goals.map((g) => [g.goal, g]));
    assert.equal(by.correct?.verifier, "correct");
    assert.equal(by.correct?.cells, null);
    // A threshold names its cells in the contract: their names, and which are held out.
    assert.deepEqual(by.fast?.cells, [
      { name: "small", held_out: false },
      { name: "hidden", held_out: true },
    ]);
    assert.deepEqual(by.missing?.problems, []);
  });

  test("a rig's report is read field by field, and a held-out case's parameters are dropped", () => {
    const read = parseGoalChecks({
      kit: { name: "k", repo: "k", commit: "c" },
      run_command: ["run", 5],
      timeout_s: 60,
      goals: [
        {
          goal: "g",
          how: "verifier",
          description: "d",
          cells: [
            { name: "a", held_out: false, params: { n: 1, deep: { x: 1 } }, timeout_s: 10 },
            { name: "h", held_out: true, params: { secret: "HIDDEN-INPUT" } },
          ],
          problems: [],
        },
        { goal: "bad", how: "guess" },
      ],
    });
    assert.deepEqual(read?.run_command, ["run"]);
    assert.equal(read?.goals.length, 1);
    assert.deepEqual(read?.goals[0]?.cells?.[0]?.params, { n: 1 });
    assert.ok(!JSON.stringify(read).includes("HIDDEN-INPUT"));
    assert.equal(parseGoalChecks({ nothing: true }), null);
  });

  test("a goal run's rig reports its goals' checks when the run starts", async () => {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 90e6 },
      kitCells: {
        small: { n: 20000000, work: 20000000 },
        big: { params: { n: 100000000, work: 100000000 }, timeout_s: 45 },
        held: { n: 15000000, work: 15000000 },
      },
      contract: { held_out_cells: ["held"] },
      kitVerifiers: { correctness: { cells: ["small", "held"] } },
    });
    const out = await env.service.applyCommand(env.assign);
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const ev = env.ledger.eventsAfter(0, 1000).events.find((e) => e.kind === "goal_checks");
    assert.equal(ev?.subject, "js-1");
    const checks = parseGoalChecks(ev?.body);
    assert.equal(checks?.kit?.commit, env.kitCommit);
    const fast = checks?.goals.find((g) => g.goal === "fast");
    assert.deepEqual(fast?.cells, [
      {
        name: "big",
        held_out: false,
        params: { n: 100000000, work: 100000000 },
        args: "n=100000000\nwork=100000000",
        timeout_s: 45,
      },
    ]);
    const correct = checks?.goals.find((g) => g.goal === "correct");
    assert.deepEqual(correct?.cells, [
      {
        name: "small",
        held_out: false,
        params: { n: 20000000, work: 20000000 },
        args: "n=20000000\nwork=20000000",
        timeout_s: 30,
      },
      { name: "held", held_out: true, timeout_s: 30 },
    ]);
    // A hill climb's run reports none.
    const hill = makeJudgeEnv();
    await hill.service.applyCommand(hill.assign);
    assert.ok(!hill.ledger.eventsAfter(0, 1000).events.some((e) => e.kind === "goal_checks"));
  });
});

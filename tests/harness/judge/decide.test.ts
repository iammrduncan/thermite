import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type GoalContract,
  type HillClimbContract,
  parseContract,
} from "../../../src/core/contract.ts";
import {
  type Block,
  decideConfirm,
  decideScreen,
  decideThresholdGoal,
  goalDelta,
} from "../../../src/harness/judge/decide.ts";
import { goalFixture, hillClimbFixture } from "../../helpers/fixtures.ts";
import { forCases, normals } from "../../helpers/property.ts";

function hillClimb(overrides: Record<string, unknown> = {}): HillClimbContract {
  const r = parseContract({ ...hillClimbFixture, ...overrides });
  if (!r.ok || r.contract.mode !== "hill_climb") throw new Error("fixture");
  return r.contract;
}

/** Blocks where the candidate's metric is `gain` times the reference's, with relative noise. */
function blocks(
  n: number,
  cells: string[],
  effects: Record<string, number>,
  noise = 0.002,
  seed = 1,
): Block[] {
  const z = normals(seed);
  return Array.from({ length: n }, () => {
    const b: Block = { candidate: {}, reference: {} };
    for (const [metric, gain] of Object.entries(effects)) {
      b.candidate[metric] = {};
      b.reference[metric] = {};
      for (const c of cells) {
        const base = 100 * (1 + noise * z());
        b.reference[metric][c] = base;
        b.candidate[metric][c] = base * gain * (1 + noise * z());
      }
    }
    return b;
  });
}

describe("screening", () => {
  const policy = hillClimb({
    guards: [
      {
        metric: "mem_mib",
        direction: "min",
        max_step_regression: 0.01,
        max_total_regression: 0.02,
      },
    ],
  });
  const cells = policy.cells;

  test("a no-op is neutral", () => {
    const d = decideScreen(policy, blocks(9, cells, { gflops: 1, mem_mib: 1 }, 0.0005));
    assert.equal(d.verdict, "neutral", d.reasons);
  });

  test("a clear gain with guards held is win_screened at the first look", () => {
    const d = decideScreen(policy, blocks(3, cells, { gflops: 1.05, mem_mib: 1 }));
    assert.equal(d.verdict, "win_screened", d.reasons);
  });

  test("a clear loss is regress", () => {
    assert.equal(
      decideScreen(policy, blocks(3, cells, { gflops: 0.95, mem_mib: 1 })).verdict,
      "regress",
    );
  });

  test("on a rig whose calibration showed more noise, a few agreeing blocks do not decide", () => {
    // Three blocks that agree on -5%, as a no-op change once did on a rig whose A/A showed
    // a 6% block spread: without the floor that is a regression; with it, keep measuring.
    const agreeing = blocks(3, cells, { gflops: 0.95, mem_mib: 1 });
    assert.equal(decideScreen(policy, agreeing).verdict, "regress");
    const floored = decideScreen(policy, agreeing, 0.06);
    assert.equal(floored.verdict, undefined, floored.reasons);
    assert.ok(floored.primary.low < 0 && floored.primary.high > 0);
    // A large real gain still wins through the same floor, at screening and confirmation.
    assert.equal(
      decideScreen(policy, blocks(3, cells, { gflops: 1.4, mem_mib: 1 }), 0.06).verdict,
      "win_screened",
    );
    assert.equal(
      decideConfirm(policy, blocks(5, cells, { gflops: 1.4, mem_mib: 1 }), {}, 0.06).verdict,
      "win_confirmed",
    );
  });

  test("a gain bought with a guard regression is a tradeoff", () => {
    // Memory is minimized, so 5% more memory is a 5% regression against a 1% step margin.
    const d = decideScreen(policy, blocks(3, cells, { gflops: 1.05, mem_mib: 1.05 }));
    assert.equal(d.verdict, "tradeoff", d.reasons);
  });

  test("an undecided early look continues, and the last look decides", () => {
    const noisy = blocks(9, cells, { gflops: 1.004, mem_mib: 1 }, 0.02, 3);
    assert.equal(decideScreen(policy, noisy.slice(0, 3)).verdict, undefined);
    assert.equal(decideScreen(policy, noisy).verdict, "inconclusive");
  });

  test("hard constraints make a candidate infeasible", () => {
    const p = hillClimb({
      guards: [],
      hard_constraints: [{ kind: "max", metric: "mem_mib", value: 50 }],
    });
    const d = decideScreen(p, blocks(3, p.cells, { gflops: 1.1, mem_mib: 1 }));
    assert.equal(d.verdict, "infeasible", d.reasons);
  });

  test("NaN never becomes a score", () => {
    const b = blocks(3, cells, { gflops: 1.05, mem_mib: 1 });
    (b[1] as Block).candidate.gflops = {
      ...(b[1] as Block).candidate.gflops,
      [cells[0] as string]: Number.NaN,
    };
    assert.throws(() => decideScreen(policy, b), RangeError);
  });

  test("A/A false wins stay under the screen's alpha", () => {
    const p = hillClimb({
      guards: [],
      objective: { primary: { metric: "gflops", direction: "max", min_effect: 0.001 } },
    });
    let wins = 0;
    const trials = 1500;
    for (let s = 0; s < trials; s++) {
      const all = blocks(9, p.cells, { gflops: 1 }, 0.01, 1000 + s);
      for (const look of p.acceptance.looks) {
        const v = decideScreen(p, all.slice(0, look)).verdict;
        if (v === "win_screened") wins++;
        if (v !== undefined) break;
      }
    }
    assert.ok(wins / trials < p.acceptance.alpha_screen / 2, `false win rate ${wins / trials}`);
  });
});

describe("confirmation", () => {
  const policy = hillClimb({
    guards: [
      {
        metric: "mem_mib",
        direction: "min",
        max_step_regression: 0.01,
        max_total_regression: 0.02,
      },
    ],
  });

  test("a real gain confirms on fresh data; no gain does not", () => {
    assert.equal(
      decideConfirm(policy, blocks(5, policy.cells, { gflops: 1.05, mem_mib: 1 }, 0.002, 9))
        .verdict,
      "win_confirmed",
    );
    assert.equal(
      decideConfirm(policy, blocks(5, policy.cells, { gflops: 1, mem_mib: 1 }, 0.002, 9)).verdict,
      "not_confirmed",
    );
  });

  test("a step within its margin still fails once the cumulative allowance is spent", () => {
    const fresh = blocks(5, policy.cells, { gflops: 1.05, mem_mib: 1.006 }, 0.0005, 4);
    assert.equal(decideConfirm(policy, fresh).verdict, "win_confirmed");
    const d = decideConfirm(policy, fresh, { mem_mib: -0.018 });
    assert.equal(d.verdict, "tradeoff", d.reasons);
  });

  test("against the baseline (goal 115): a step within its margin that has drifted past the total allowance from the start is a tradeoff", () => {
    // mem_mib (lower is better): 0.6% above the champion in these blocks, within the 1% step.
    const fresh = blocks(5, policy.cells, { gflops: 1.05, mem_mib: 1.006 }, 0.0005, 4);
    const now = Math.min(
      ...fresh.map((b) => b.candidate.mem_mib?.[policy.cells[0] as string] ?? 0),
    );
    // The starting point's mem_mib on every cell, `drift` below the change's values.
    const start = (drift: number, mad = 0) =>
      Object.fromEntries(
        policy.cells.map((c) => [c, { mem_mib: { median: now / (1 + drift), mad } }]),
      );
    // No step estimates to add up (they were not recorded), and 3% above the start: spent.
    const d = decideConfirm(policy, fresh, {}, 0, start(0.03));
    assert.equal(d.verdict, "tradeoff", d.reasons);
    assert.match(
      d.reasons,
      /^the guard's total allowance against the starting point is spent: mem_mib -(2\.9|3\.0)\d% against the starting point \(allowed -2\.00%, and its noise 0\.00%\)/,
    );
    assert.equal(d.vsStart?.[0]?.spent, true);
    // 1.5% above the start: within the 2% allowance.
    assert.equal(decideConfirm(policy, fresh, {}, 0, start(0.015)).verdict, "win_confirmed");
    // 2.4% above, but the start's own spread is 1% of its value: its noise never counts against
    // the change.
    const noisy = decideConfirm(policy, fresh, {}, 0, start(0.024, now / 1.024 / 100));
    assert.equal(noisy.verdict, "win_confirmed", noisy.reasons);
    assert.equal(noisy.vsStart?.[0]?.spent, false);
    // A cell the baseline has no value for: the guard is not checked against it.
    const partial = { [policy.cells[0] as string]: { gflops: { median: 1, mad: 0 } } };
    assert.deepEqual(decideConfirm(policy, fresh, {}, 0, partial).vsStart, []);
  });
});

describe("goal thresholds", () => {
  const r = parseContract(goalFixture);
  if (!r.ok || r.contract.mode !== "goal") throw new Error("fixture");
  const contract: GoalContract = r.contract;
  const goal = contract.goals.find((g) => g.verify.type === "metric_threshold");
  const verify = goal?.verify;
  if (!goal || verify?.type !== "metric_threshold")
    throw new Error("fixture has no threshold goal");
  const cells = verify.cells ?? ["c1"];
  const target = verify.value;
  const around = (centre: number, spread: number) =>
    Object.fromEntries(cells.map((c) => [c, [centre - spread, centre, centre + spread]]));

  test("met, unmet, inconclusive and not runnable", () => {
    const passSide = verify.op.startsWith(">") ? 1 : -1;
    assert.equal(
      decideThresholdGoal(goal, around(target + passSide * 10, 0.1), 0.05).status,
      "met",
    );
    assert.equal(
      decideThresholdGoal(goal, around(target - passSide * 10, 0.1), 0.05).status,
      "unmet",
    );
    assert.equal(decideThresholdGoal(goal, around(target, 1), 0.05).status, "inconclusive");
    assert.equal(decideThresholdGoal(goal, {}, 0.05).status, "not_runnable");
    const single = Object.fromEntries(cells.map((c) => [c, [target + passSide * 10]]));
    assert.equal(decideThresholdGoal(goal, single, 0.05).status, "inconclusive");
  });
});

describe("goal candidates against the champion", () => {
  test("a goal the champion meets that the candidate could not check is unknown, not lost", () => {
    const champion = new Map([
      ["a", "verified"],
      ["b", "verified"],
      ["c", "unmet"],
    ]);
    assert.deepEqual(
      goalDelta(
        [
          { goal: "a", status: "inconclusive" },
          { goal: "b", status: "unmet" },
          { goal: "c", status: "met" },
        ],
        champion,
      ),
      { gained: ["c"], lost: ["b"], unsure: ["a"] },
    );
    assert.deepEqual(goalDelta([{ goal: "a", status: "not_runnable" }], champion), {
      gained: [],
      lost: [],
      unsure: ["a"],
    });
  });

  test("all_required needs at least one required goal", () => {
    const r = parseContract({
      ...goalFixture,
      goals: goalFixture.goals.map((g) => ({ ...g, required: false })),
    });
    assert.equal(r.ok, false);
  });
});

describe("screening's properties, on seeded random cases", () => {
  // No guards: the verdict turns on the primary metric alone.
  const policy = hillClimb({ guards: [] });
  const cells = policy.cells;
  const metric = policy.objective.primary.metric;
  /** The same blocks with candidate and champion swapped. */
  const mirrored = (bs: Block[]): Block[] =>
    bs.map((b) => ({ candidate: b.reference, reference: b.candidate }));

  test("swapping candidate and champion turns a win into a regression, and back", () => {
    forCases(
      200,
      11,
      (d) => ({
        n: d.int(3, 12),
        gain: Math.exp(d.normal() * 0.2),
        noise: d.between(0.0005, 0.05),
        seed: d.int(1, 1e6),
      }),
      ({ n, gain, noise, seed }) => {
        const bs = blocks(n, cells, { [metric]: gain }, noise, seed);
        const there = decideScreen(policy, bs).verdict;
        const back = decideScreen(policy, mirrored(bs)).verdict;
        if (there === "win_screened") assert.equal(back, "regress");
        if (there === "regress" && back !== "win_screened")
          // The way back may be smaller than min_effect: then it is neutral or undecided.
          assert.notEqual(back, "regress");
      },
    );
  });

  test("a change that does nothing is never a win or a regression", () => {
    forCases(
      200,
      12,
      (d) => ({ n: d.int(3, 12), seed: d.int(1, 1e6) }),
      ({ n, seed }) => {
        const bs = blocks(n, cells, { [metric]: 1 }, 0, seed);
        const v = decideScreen(policy, bs).verdict;
        assert.ok(v !== "win_screened" && v !== "regress", String(v));
      },
    );
  });

  test("a higher noise floor never makes a win where a lower one made none", () => {
    forCases(
      200,
      13,
      (d) => ({
        n: d.int(3, 12),
        gain: Math.exp(d.normal() * 0.1),
        noise: d.between(0.0005, 0.02),
        seed: d.int(1, 1e6),
        low: d.between(0, 0.05),
        more: d.between(0, 0.1),
      }),
      ({ n, gain, noise, seed, low, more }) => {
        const bs = blocks(n, cells, { [metric]: gain }, noise, seed);
        const quiet = decideScreen(policy, bs, low).verdict;
        const loud = decideScreen(policy, bs, low + more).verdict;
        if (loud === "win_screened") assert.equal(quiet, "win_screened");
        if (loud === "regress") assert.equal(quiet, "regress");
      },
    );
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type HillClimbContract, parseContract } from "../../../../src/core/contract.ts";
import { metricPlan } from "../../../../src/core/metric-plan.ts";
import { objectiveOf } from "../../../../src/harness/agents/scheduler/context.ts";
import { hillClimbFixture } from "../../../helpers/fixtures.ts";

/**
 * Goal 209: the agents' brief says what breaks a tie on the primary, the guards a change must
 * keep and the metrics only recorded, from the run's metric plan.
 */

const hill = (o: Record<string, unknown> = {}) => {
  const r = parseContract({ ...hillClimbFixture, ...o });
  assert.ok(r.ok);
  return r.contract as HillClimbContract;
};

describe("the agents' objective (goal 209)", () => {
  test("a run's metric plan: its ties, its guards and its informational metrics", () => {
    const c = hill({ guards: [] });
    const plan = metricPlan(c, {
      prefill: { kind: "priority", priority: 2, direction: "max", min_effect: 0.01 },
      mem_gib: { kind: "guard", guards: [{ stay: "below", against: "baseline", by: 0.05 }] },
      itl_ms: { kind: "info" },
    });
    assert.equal(
      objectiveOf(c, plan),
      "increase gflops (at least 1.0% to count) on cells n256, n512, without breaking correctness. A change equal on gflops wins by prefill (higher, at least 1.0%). A change is refused, however much it gains, unless it keeps mem_gib at most 5% above the baseline. Recorded, never deciding: itl_ms",
    );
  });

  test("a guard that asks: a change past it waits for the owner's yes (goal 212)", () => {
    const c = hill({ guards: [] });
    const plan = metricPlan(c, {
      kl: {
        kind: "guard",
        guards: [
          { stay: "below", against: "value", value: 0, ask: true },
          { stay: "below", against: "value", value: 0.001 },
        ],
      },
    });
    assert.equal(
      objectiveOf(c, plan),
      "increase gflops (at least 1.0% to count) on cells n256, n512, without breaking correctness. A change is refused, however much it gains, unless it keeps kl at most 0.001. A change that does not keep kl at most 0 waits for the owner's yes",
    );
  });

  test("before the baseline, the contract's own guards; none, and the objective is as it was", () => {
    assert.match(
      objectiveOf(hill()),
      /unless it keeps max_abs_error at most the champion; max_abs_error at most the baseline$/,
    );
    assert.equal(
      objectiveOf(hill({ guards: [] })),
      "increase gflops (at least 1.0% to count) on cells n256, n512, without breaking correctness",
    );
  });
});

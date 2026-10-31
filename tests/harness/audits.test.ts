import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GOAL_CHECKED, HILL_CLIMB_CHECKED } from "../../src/harness/audits.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

const AUDIT = { looks: [3, 6], confirm_blocks: 4, audit: { ratio_to_median: 3, absolute: 0.15 } };

describe("the auditor's package says what the judge checked (goal 137)", () => {
  test("a hill climb: the kit's check, each guard's result and the hard constraints, never the held-out results", async () => {
    const env = makeJudgeEnv({
      heldOut: true,
      contract: {
        acceptance: AUDIT,
        guards: [
          {
            metric: "ops_per_s",
            direction: "max",
            max_step_regression: 0.02,
            max_total_regression: 0.03,
          },
        ],
        hard_constraints: [{ kind: "min", metric: "ops_per_s", value: 1 }],
      },
    });
    await env.start();
    const id = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "h",
          known_flaws: ["numerics were not checked in this trial"],
        },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    const pkg = (await env.service.auditPackages())[0];
    assert.ok(pkg);
    const { checked } = pkg;
    assert.ok("guards" in checked, "a hill climb's checks");
    assert.equal(checked.said, HILL_CLIMB_CHECKED);
    assert.deepEqual(checked.cells, ["small"]);
    assert.equal(checked.confirm_blocks, 4);
    const [g] = checked.guards;
    assert.ok(g);
    assert.deepEqual(
      [g.metric, g.direction, g.max_step_regression, g.max_total_regression, g.status],
      ["ops_per_s", "max", 0.02, 0.03, "ok"],
    );
    // The judge's result as fractions: the change is faster, inside its interval.
    assert.ok(g.change !== null && g.low !== null && g.high !== null);
    assert.ok(g.change > 0 && g.low <= g.change && g.change <= g.high);
    // At confirmation, against the run's starting point too (goal 115).
    assert.ok(g.vs_start && g.vs_start.spent === false && (g.vs_start.change ?? 0) > 0);
    // A named check is not run by the judge on its own, so it is not listed as held.
    assert.deepEqual(checked.hard_constraints, [{ kind: "min", metric: "ops_per_s", value: 1 }]);
    // Held-out results stay with promotion code.
    assert.ok(!JSON.stringify(pkg).includes("held_out"));
  });

  test("a goal campaign: each goal's status as the judge recorded it", async () => {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 90e6 },
      contract: { adversarial_checklist: ["no special-casing of the measured inputs"] },
    });
    await env.start();
    await env.drain();
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    const pkg = (await env.service.auditPackages())[0];
    assert.ok(pkg && "goals" in pkg.checked, "a goal campaign's checks");
    assert.equal(pkg.checked.said, GOAL_CHECKED);
    assert.ok(pkg.checked.goals.length > 0);
    assert.ok(pkg.checked.goals.some((g) => g.status === "met"));
  });
});

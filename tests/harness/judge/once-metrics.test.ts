import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type HillClimbContract, parseContract } from "../../../src/core/contract.ts";
import { KitSchema } from "../../../src/core/kit.ts";
import { planProblems } from "../../../src/core/metric-plan.ts";
import { type Block, decideScreen, type Roles } from "../../../src/harness/judge/decide.ts";
import { measuresOnce } from "../../../src/harness/judge/measure.ts";
import { hillClimbFixture } from "../../helpers/fixtures.ts";

/**
 * A kit's metric measured once a judge's job (goal 233): the change's first block of a job (the
 * starting point's in a baseline) and a run outside a job's blocks measure it; the judge checks
 * its guards on the blocks that report it; and it can be neither a priority nor compared by a
 * guard against the champion or the baseline.
 */

const kit = (metrics: Record<string, unknown>) => ({
  schema_version: 1,
  name: "k",
  target: "cpu",
  build: { command: ["make"], outputs: ["out"] },
  cells: { small: { work: 1 } },
  run: { command: ["{build:out/bench}", "{out}"] },
  metrics: { ops: { unit: "op/s", work: "work" }, ...metrics },
  check: { command: ["python3", "{kit:check.py}", "{out}"] },
});

function hillClimb(overrides: Record<string, unknown> = {}): HillClimbContract {
  const r = parseContract({ ...hillClimbFixture, ...overrides });
  if (!r.ok || r.contract.mode !== "hill_climb") throw new Error("fixture");
  return r.contract;
}

describe("a metric measured once a job", () => {
  test("the change's first block measures it, and a run outside a job's blocks", () => {
    assert.equal(measuresOnce({ block: 1, job: "evaluate" }, "candidate"), true);
    assert.equal(measuresOnce({ block: 1, job: "baseline" }, "baseline"), true);
    assert.equal(measuresOnce({ block: 1, job: "evaluate" }, "champion"), false);
    assert.equal(measuresOnce({ block: 2, job: "confirm" }, "candidate"), false);
    assert.equal(measuresOnce({ block: 1, job: "calibrate" }, "twin"), false);
    assert.equal(measuresOnce(undefined, "candidate"), true, "a held-out check measures it");
  });

  test("a kit may hold it against a value, never as a priority or against the champion", () => {
    const kl = { unit: "nats", from: "check", field: "kl", may_be_zero: true, once: true };
    KitSchema.parse(
      kit({
        kl: { ...kl, kind: "guard", guards: [{ stay: "below", against: "value", value: 0.005 }] },
      }),
    );
    assert.throws(
      () =>
        KitSchema.parse(
          kit({
            kl: { ...kl, may_be_zero: undefined, kind: "priority", priority: 2, min_effect: 0.01 },
          }),
        ),
      /measured once a job, so it can't be a priority metric/,
    );
    assert.throws(
      () =>
        KitSchema.parse(
          kit({
            kl: { ...kl, kind: "guard", guards: [{ stay: "below", against: "champion", by: 0.1 }] },
          }),
        ),
      /measured once a job, so its guard can't be against the champion/,
    );
    // A contract may not compare it block by block either.
    const roles = { kl: { once: true as const } };
    const c = hillClimb({
      guards: [
        { metric: "kl", direction: "min", max_step_regression: 0.01, max_total_regression: 0.02 },
      ],
    });
    assert.ok(
      planProblems(c, roles).some((p) =>
        /guard on kl, .* compares it block by block, and it is measured once a job/.test(p),
      ),
    );
  });

  test("the judge checks its guard on the blocks that report it, and refuses a change with none", () => {
    const policy = hillClimb({ guards: [] });
    const roles: Roles = {
      kl: {
        kind: "guard",
        once: true,
        guards: [{ stay: "below", against: "value", value: 0.005 }],
      },
    };
    const blocks = (kl: number | undefined): Block[] =>
      Array.from({ length: 3 }, (_, i) => {
        const cand: Record<string, Record<string, number>> = {};
        const ref: Record<string, Record<string, number>> = {};
        cand.gflops = {};
        ref.gflops = {};
        for (const c of policy.cells) {
          cand.gflops[c] = 105 + i * 0.01;
          ref.gflops[c] = 100;
        }
        if (i === 0 && kl !== undefined)
          cand.kl = Object.fromEntries(policy.cells.map((c) => [c, kl]));
        return { candidate: cand, reference: ref };
      });
    assert.equal(decideScreen(policy, blocks(0), 0, roles).verdict, "win_screened");
    const over = decideScreen(policy, blocks(0.01), 0, roles);
    assert.equal(over.verdict, "infeasible", over.reasons);
    assert.match(over.reasons, /kl\/n\d+: mean 0\.01 is not at most 0\.005/);
    const none = decideScreen(policy, blocks(undefined), 0, roles);
    assert.equal(none.verdict, "infeasible", none.reasons);
    assert.match(none.reasons, /kl\/n\d+: missing or non-finite/);
  });
});

/**
 * Goal 230: how many changes may wait for the judge before a run's lanes start no new trial. The
 * contract's max_open_attempts, none by default; an open_attempts rule over it, the owner's and an
 * operator's alone; and History and Live saying when the lanes wait.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseContract, sameAsStored } from "../../../../src/core/contract.ts";
import { openAttemptsLimit } from "../../../../src/harness/agents/coordinator.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { runTrial } from "../../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { hillClimbFixture } from "../../../helpers/fixtures.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("../../../../src/harness/agents/lanetool.ts", import.meta.url)),
];

describe("changes that may wait for the judge (goal 230)", () => {
  test("the contract's limit holds the lanes and says so; an owner's open_attempts rule raises it; an agent's is left out", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 4, keep_working: true },
      contract: { budget: { max_open_attempts: 2 } },
    });
    await env.start();
    const fake = await startFakeModel(({ messages, tools }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) {
        return {
          toolCalls: [
            {
              name: "submit_plan",
              args: {
                new_directions: [{ id: "loops", description: "simplify the inner loop" }],
                assignments: [
                  { lane: "lane-1", direction: "loops", focus: "remove waste", parent: "champion" },
                ],
              },
            },
          ],
        };
      }
      // Each trial writes a change of its own, so none is a duplicate.
      const content = `${FAST_KERNEL}\n// ${Math.random()}\n`;
      const steps = [
        { name: "write_file", args: { path: "src/kernel/work.mjs", content } },
        { name: "submit_experiment", args: { hypothesis: "drop waste" } },
      ];
      const done = messages.filter((m) => m.role === "tool").length;
      return steps[done] ? { toolCalls: [steps[done]] } : { text: "done" };
    });
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "scheduler-test",
      runTrial: (spec) =>
        runTrial(spec, {
          runner,
          laneTool,
          model,
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
        }),
    });
    const events = (kind: string) =>
      env.ledger.db
        .prepare("select body from event where kind = ? order by id")
        .all(kind)
        .map((r) => JSON.parse(String(r.body)));
    assert.ok(await scheduler.tick()); // round 1 planned, trial 1 starts
    await scheduler.idle();
    assert.ok(await scheduler.tick()); // trial 2: the lanes keep working
    await scheduler.idle();
    // Two changes wait for the judge: at the contract's limit, the lane starts no trial.
    assert.equal(await scheduler.tick(), false);
    assert.deepEqual(events("lanes_held"), [{ open: 2, limit: 2, from: "contract" }]);
    // Said once for the same count and limit, not at every tick.
    assert.equal(await scheduler.tick(), false);
    assert.equal(events("lanes_held").length, 1);
    // An agent's rule (the teachers' set, the planner's or an agent's token) is left out.
    env.ledger.directives.addSet(
      "js-1",
      "supervisor",
      [{ kind: "open_attempts", value: 10, rationale: "run ahead", citations: [] }],
      false,
    );
    assert.deepEqual(
      events("directives_left_out").at(-1)?.why,
      "an open_attempts rule is the owner's or an operator's to set",
    );
    assert.equal(await scheduler.tick(), false);
    // The owner's rule raises it: the lanes start again, and History says so.
    env.ledger.directives.addSet(
      "js-1",
      "control:owner:operator",
      [{ kind: "open_attempts", value: 3, rationale: "the judge is behind", citations: [] }],
      false,
    );
    assert.deepEqual(openAttemptsLimit(env.ledger, "js-1", env.service.contractFor("js-1")), {
      limit: 3,
      from: "rule",
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    assert.deepEqual(events("lanes_held_ended"), [{ open: 2 }]);
    assert.equal(await scheduler.tick(), false);
    assert.deepEqual(events("lanes_held").at(-1), { open: 3, limit: 3, from: "rule" });
    await fake.close();
  });

  test("a contract that sets no limit has none; one stored with the old default keeps it, as the same version", () => {
    const now = parseContract(hillClimbFixture);
    assert.ok(now.ok, now.ok ? "" : now.errors.join("\n"));
    if (!now.ok) return;
    assert.equal(now.contract.budget.max_open_attempts, undefined, "no default");
    // As a ledger stored it before: the old default written in.
    const stored = { ...now.contract, budget: { ...now.contract.budget, max_open_attempts: 4 } };
    assert.ok(sameAsStored(stored, now.contract));
    // A stored contract that set another value, or a given one that sets a value, is another.
    assert.ok(!sameAsStored({ ...stored, budget: { max_open_attempts: 6 } }, now.contract));
    assert.ok(
      !sameAsStored(stored, {
        ...now.contract,
        budget: { ...now.contract.budget, max_open_attempts: 8 },
      }),
    );
  });
});

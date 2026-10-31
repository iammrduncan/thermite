/**
 * The scheduler's rounds: a round planned, a trial for each lane, the judge's verdicts and the next
 * round; when a lane waits for the judge and when a round ends; and a judge-only run, which plans
 * none.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { keepsWorking } from "../../../../src/harness/agents/coordinator.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { runTrial } from "../../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../../../helpers/judge-env.ts";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("../../../../src/harness/agents/lanetool.ts", import.meta.url)),
];

describe("agent scheduler", () => {
  test("an epoch: plan, one trial per lane, judged, lane best kept, next epoch planned", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.start();
    // One fake model plays planner and workers: lane-1 writes a faster kernel, lane-2 a wrong one.
    const fake = await startFakeModel(({ messages, tools }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) {
        return {
          toolCalls: [
            {
              name: "submit_plan",
              args: {
                new_families: [{ id: "loops", description: "simplify the inner loop" }],
                assignments: [
                  {
                    lane: "lane-1",
                    family: "loops",
                    focus: "remove wasted work",
                    parent: "champion",
                  },
                  {
                    lane: "lane-2",
                    family: "loops",
                    focus: "try a closed form",
                    parent: "champion",
                  },
                ],
              },
            },
          ],
        };
      }
      const brief = JSON.stringify(messages[1] ?? messages[0]);
      const kernel = brief.includes("lane-1") ? FAST_KERNEL : WRONG_KERNEL;
      const done = messages.filter((m) => m.role === "tool").length;
      const steps = [
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: kernel } },
        {
          name: "submit",
          args: { hypothesis: brief.includes("lane-1") ? "drop waste" : "closed form" },
        },
      ];
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
      maxConcurrent: 2,
      runTrial: (spec) =>
        runTrial(spec, {
          runner,
          laneTool,
          model,
          // As over the API: the trial's token decides run, lane and parent.
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
        }),
    });
    assert.ok(await scheduler.tick()); // plans epoch 1 and starts both lanes
    await scheduler.idle();
    await env.drain(); // the judge decides both submissions
    await scheduler.tick(); // lane bests, epoch 1 ends
    await scheduler.tick(); // epoch 2 planned
    const epochs = env.ledger.db.prepare("select n, source from epoch order by n").all();
    assert.deepEqual(
      epochs.map((e) => [e.n, e.source]),
      [
        [1, "planner"],
        [2, "planner"],
      ],
    );
    const trials = env.ledger.db
      .prepare("select lane, attempt, stopped from trial where epoch = 1 order by lane")
      .all();
    assert.deepEqual(
      trials.map((t) => t.stopped),
      ["submitted", "submitted"],
    );
    const winner = String(trials[0]?.attempt);
    assert.equal(
      env.ledger.verdicts.current(winner)?.verdict,
      "win_confirmed",
      env.explain(winner),
    );
    assert.equal(env.ledger.verdicts.current(String(trials[1]?.attempt))?.verdict, "invalid");
    // The win became the champion, so it is no lane's separate best.
    assert.equal(env.ledger.champions.current("js-1").attempt, winner);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-2"), null);
    assert.equal(String(env.ledger.attempts.get(winner)?.family), "loops");
    await scheduler.idle();
    await fake.close();
  });

  test("a lane waits for the judge unless its run keeps working; a keep_working rule turns it on and off (goal 135)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 2 } });
    await env.start();
    const fake = await startFakeModel(({ messages, tools }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) {
        return {
          toolCalls: [
            {
              name: "submit_plan",
              args: {
                new_families: [{ id: "loops", description: "simplify the inner loop" }],
                assignments: [
                  { lane: "lane-1", family: "loops", focus: "remove waste", parent: "champion" },
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
        { name: "submit", args: { hypothesis: "drop waste" } },
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
    const lifecycles = () =>
      env.ledger.db
        .prepare(
          "select a.lifecycle from trial t join attempt a on a.id = t.attempt order by t.rowid",
        )
        .all()
        .map((r) => r.lifecycle);
    const rule = (value: "on" | "off") =>
      env.ledger.directives.add("js-1", "control:owner", {
        kind: "keep_working",
        value,
        rationale: "test",
        citations: [],
      });
    assert.ok(await scheduler.tick()); // round 1 planned, trial 1 starts
    await scheduler.idle();
    assert.deepEqual(lifecycles(), ["queued"]);
    // By default the lane waits for the judge's verdict on trial 1's change.
    assert.equal(await scheduler.tick(), false);
    // Kept working, trial 2 starts while the judge has not taken it.
    rule("on");
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    assert.deepEqual(lifecycles(), ["queued", "queued"]);
    await scheduler.tick(); // round 1 ends: its trials ended
    await scheduler.tick(); // round 2 planned, its first trial starts
    await scheduler.idle();
    const epochs = env.ledger.db.prepare("select n from epoch order by n").all();
    assert.deepEqual(
      epochs.map((e) => e.n),
      [1, 2],
    );
    assert.deepEqual(lifecycles(), ["queued", "queued", "queued"]);
    // Turned off, the lane waits again, until the judge works through them.
    rule("off");
    assert.equal(await scheduler.tick(), false);
    await env.drain();
    assert.ok(
      lifecycles().every((l) => l !== "queued"),
      String(lifecycles()),
    );
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    await fake.close();
  });

  test("a round ends without waiting for a lane's long trial; the judge's wait holds the round and the lane's next trial in any round (goal 136)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.start();
    const fake = await startFakeModel(({ messages, tools }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) {
        return {
          toolCalls: [
            {
              name: "submit_plan",
              args: {
                new_families: [{ id: "loops", description: "simplify the inner loop" }],
                assignments: ["lane-1", "lane-2"].map((lane) => ({
                  lane,
                  family: "loops",
                  focus: "remove waste",
                  parent: "champion",
                })),
              },
            },
          ],
        };
      }
      const content = `${FAST_KERNEL}\n// ${Math.random()}\n`;
      const steps = [
        { name: "write_file", args: { path: "src/kernel/work.mjs", content } },
        { name: "submit", args: { hypothesis: "drop waste" } },
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
    // Lane-1's first trial waits until it is released: a long trial.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let holding = true;
    const scheduler = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "scheduler-test",
      maxConcurrent: 2,
      runTrial: async (spec) => {
        if (spec.lane === "lane-1" && holding) await held;
        return runTrial(spec, {
          runner,
          laneTool,
          model,
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
        });
      },
    });
    const trials = (lane: string) =>
      (
        env.ledger.db
          .prepare("select epoch, ended_at from trial where lane = ? order by rowid")
          .all(lane) as { epoch: number; ended_at: string | null }[]
      ).map((x) => ({ epoch: Number(x.epoch), ended: x.ended_at !== null }));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(ok(), "in time");
    };
    const round = () => scheduler.registry.currentEpoch("js-1");
    assert.ok(await scheduler.tick(), "round 1: both lanes start");
    await until(() => trials("lane-2")[0]?.ended === true);
    // Lane-2's change waits for the judge: it holds the round.
    await scheduler.tick();
    assert.equal(round()?.ended_at, null);
    // Judged, lane-2 is free and lane-1 is still on its trial: the round ends, and lane-2 goes on.
    await env.drain();
    await scheduler.tick();
    assert.notEqual(round()?.ended_at, null);
    assert.ok(await scheduler.tick(), "round 2: lane-2 starts");
    assert.deepEqual(trials("lane-2")[1], { epoch: 2, ended: false });
    assert.deepEqual(trials("lane-1"), [{ epoch: 1, ended: false }]);
    await until(() => trials("lane-2")[1]?.ended === true);
    // Lane-1's trial of round 1 ends with a change: its next trial, in round 2, waits for the judge.
    holding = false;
    release();
    await until(() => trials("lane-1")[0]?.ended === true);
    assert.equal(await scheduler.tick(), false);
    assert.equal(trials("lane-1").length, 1);
    assert.equal(round()?.ended_at, null);
    await env.drain();
    assert.ok(await scheduler.tick(), "lane-1 joins round 2");
    assert.deepEqual(trials("lane-1")[1], { epoch: 2, ended: false });
    await scheduler.idle();
    await fake.close();
  });

  test("a campaign that keeps working sets it for its runs; a run's rule comes first (goal 135)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1, keep_working: true } });
    await env.start();
    const contract = env.service.contractFor("js-1");
    assert.equal(keepsWorking(env.ledger, "js-1", contract), true);
    env.ledger.directives.add("js-1", "control:owner", {
      kind: "keep_working",
      value: "off",
      rationale: "test",
      citations: [],
    });
    assert.equal(keepsWorking(env.ledger, "js-1", contract), false);
    // Without the setting or a rule, lanes wait for the judge.
    const plain = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await plain.start();
    assert.equal(keepsWorking(plain.ledger, "js-1", plain.service.contractFor("js-1")), false);
  });

  test("a judge-only run plans no epoch and starts no trial", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 }, agents: false });
    const r = await env.start();
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    assert.equal(env.ledger.runs.get("js-1")?.agents, false);
    let asked = 0;
    const fake = await startFakeModel(() => {
      asked++;
      return { text: "no" };
    });
    const s = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 1000, maxTokens: 10 },
      owner: "s",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    assert.equal(await s.tick(), false);
    await fake.close();
    assert.equal(asked, 0);
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 0);
    // The judge still works on it: a submitted attempt is judged.
    const sub = (await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "less work",
        known_flaws: [],
      },
      "proposer",
    )) as { attempt: string };
    await env.drain();
    assert.ok(env.ledger.verdicts.current(sub.attempt), "the judge gave the attempt a verdict");
  });
});

/**
 * The owner's reset_workers and pause_run commands: they stop a run's planner call and its running
 * trials.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

describe("agent scheduler", () => {
  test("reset_workers kills the running trials, clears lane bests and starts a fresh epoch", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.start();
    let aborted = 0;
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: (spec, signal) =>
        new Promise((resolve) => {
          // The worker reports its counters as it works (after each turn), then is killed.
          env.service.trialProgress.set(spec.trialId, {
            turns: 7,
            tool_calls: 12,
            tokens_in: 5000,
            tokens_out: 300,
          });
          started();
          signal.addEventListener("abort", () => {
            aborted++;
            resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 });
          });
        }),
    });
    await scheduler.tick(); // epoch 1, a trial that runs until it is killed
    await running;
    const r = await env.service.applyCommand(env.sign("reset_workers", { run: "js-1" }));
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    const refused = await env.service.applyCommand(
      env.sign("reset_workers", { run: "js-1", reseed_commit: "a".repeat(40) }),
    );
    assert.ok(refused.status === "applied" && !refused.accepted);
    await scheduler.tick(); // applies the reset, then plans epoch 2
    assert.equal(aborted, 1);
    const trial = env.ledger.db
      .prepare("select stopped, turns, tokens_in, tokens_out from trial order by started_at")
      .get();
    assert.equal(trial?.stopped, "interrupted");
    // The killed worker reported nothing at the end: its last counters are kept, not zeros.
    assert.deepEqual(
      [trial?.turns, trial?.tokens_in, trial?.tokens_out].map(Number),
      [7, 5000, 300],
    );
    const epochs = env.ledger.db.prepare("select n, ended_at from epoch order by n").all();
    assert.equal(epochs.length, 2);
    assert.ok(epochs[0]?.ended_at);
    for (const a of (
      scheduler as unknown as { sched: { aborts: Map<string, AbortController> } }
    ).sched.aborts.values())
      a.abort();
    await scheduler.idle();
  });

  test("a pause stops the run's planner call and running trials at once", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.start();
    // A model route that never answers: the planner call hangs until it is cancelled.
    let requests = 0;
    const hang = createServer(() => {
      requests++;
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as AddressInfo).port;
    const model = {
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      apiKey: "k",
      contextWindow: 1000,
      maxTokens: 10,
    };
    const runTrial = (_spec: unknown, signal: AbortSignal) =>
      new Promise<{ stopped: "error"; turns: 0; toolCalls: 0; tokensIn: 0; tokensOut: 0 }>(
        (resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          );
        },
      );
    const planning = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "s",
      runTrial,
    });
    const tick = planning.tick();
    while (requests === 0) await new Promise((r) => setTimeout(r, 50));
    const paused = await env.service.applyCommand(
      env.sign("pause_run", { run: "js-1", reason: "test" }),
    );
    assert.ok(paused.status === "applied" && paused.accepted, JSON.stringify(paused));
    const t0 = Date.now();
    await tick;
    assert.ok(Date.now() - t0 < 5000, `the planner call took ${Date.now() - t0} ms to stop`);
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from epoch").get()?.n,
      0,
      "no epoch after a pause",
    );
    hang.closeAllConnections();
    hang.close();

    // A running trial: the pause kills it without waiting for the next tick.
    const resumed = await env.service.applyCommand(env.sign("resume_run", { run: "js-1" }));
    assert.ok(resumed.status === "applied" && resumed.accepted, JSON.stringify(resumed));
    const fake = await startFakeModel(() => ({
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            assignments: [{ lane: "lane-1", family: "loops", focus: "f", parent: "champion" }],
            new_families: [{ id: "loops", description: "d" }],
          },
        },
      ],
    }));
    const s2 = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { ...model, baseUrl: fake.url },
      owner: "s",
      runTrial,
    });
    await s2.tick();
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from trial where ended_at is null").get()?.n,
      1,
    );
    await env.service.applyCommand(env.sign("pause_run", { run: "js-1", reason: "test" }));
    const t1 = Date.now();
    await s2.idle();
    assert.ok(Date.now() - t1 < 5000);
    assert.equal(env.ledger.db.prepare("select stopped from trial").get()?.stopped, "interrupted");
    await fake.close();
  });
});

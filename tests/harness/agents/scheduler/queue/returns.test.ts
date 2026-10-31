/**
 * When an experiment goes back to the queue: an interrupted trial, the provider's error or a
 * restart; and when it does not: a trial that submitted, or one that failed of itself.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../../src/harness/broker/runner.ts";
import { FAST_KERNEL } from "../../../../helpers/judge-env.ts";
import { body, command, events, RUN, setup } from "./setup.ts";

describe("the planner as the queue's coordinator", () => {
  test("an interrupted trial's experiment goes back to the top of the queue: the same row, with why (goal 079)", async (t) => {
    const s = await setup(t, {
      lanes: 1,
      trial: (_spec, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          ),
        ),
    });
    const x = await s.add("long one", { why: "big win if it works" });
    await s.add("next one");
    assert.ok(await s.scheduler.tick());
    await command(s.env, "pause_run", { run: RUN, reason: "test" });
    await s.scheduler.idle();
    // The same row, not a copy: back at the top, its author and its why as they were.
    const back = s.q.get(x);
    assert.equal(back?.state, "queued");
    assert.equal(s.q.queued(RUN)[0]?.id, x);
    assert.equal(back?.added_by, "owner");
    assert.equal(back?.why, "big win if it works");
    assert.equal(back?.returns, 1);
    assert.match(String(back?.cause), /stopped|interrupted/);
    assert.equal(s.q.all(RUN).length, 2, "no copy");
    const returned = events(s.env, "experiment_returned");
    assert.equal(returned.length, 1);
    assert.equal(body(returned[0]).id, x);
    assert.equal(body(returned[0]).result, "interrupted");
    // The planner's brief says why it came back, and its tried list is not filled with copies.
    const brief = s.q.brief(RUN);
    assert.equal(brief.up_next[0]?.id, x);
    assert.equal(brief.up_next[0]?.returned?.times, 1);
    assert.equal(brief.tried.length, 0);
  });

  test("a trial interrupted after it submitted keeps its experiment done with its attempt: it does not come back (goal 079)", async (t) => {
    // A Pi worker in its own process submits, then is stopped before it can hand its result
    // over: the scheduler learns of the submission only from the attempt linked to the trial.
    let attempt = "";
    const s = await setup(t, {
      lanes: 1,
      trial: async (spec, signal) => {
        const r = await s.env.service.submitForTrial(String(spec.token), {
          patch_base64: s.env.patch(FAST_KERNEL),
          hypothesis: "the fast kernel",
          known_flaws: [],
        });
        attempt = r.attempt;
        return new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({
              stopped: "error",
              turns: 0,
              toolCalls: 0,
              tokensIn: 0,
              tokensOut: 0,
              error: "worker process gave no result (SIGKILL): ",
            }),
          ),
        );
      },
    });
    const x = await s.add("submits, then is stopped");
    assert.ok(await s.scheduler.tick());
    while (!attempt) await new Promise((r) => setTimeout(r, 10));
    await command(s.env, "pause_run", { run: RUN, reason: "test" });
    await s.scheduler.idle();
    const done = s.q.get(x);
    assert.equal(done?.state, "done", "its attempt is with the judge: not back in the queue");
    assert.equal(done?.result, "submitted");
    assert.equal(done?.attempt, attempt);
    assert.equal(events(s.env, "experiment_returned").length, 0);
    assert.equal(
      s.env.ledger.db.prepare("select attempt from trial").get()?.attempt,
      attempt,
      "the trial keeps its attempt",
    );
  });

  test("a trial that ends on the provider's error gives its experiment back; another failure is tried, with its cause (goal 079)", async (t) => {
    let error = "503 Service Unavailable";
    // The provider's call says it was the provider's (its kind); a local failure has none.
    let errorKind: "server" | undefined = "server";
    const s = await setup(t, {
      lanes: 1,
      trial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        error,
        errorKind,
      }),
    });
    const x = await s.add("waits for the provider");
    assert.ok(await s.scheduler.tick());
    await s.scheduler.idle();
    const back = s.q.get(x);
    assert.equal(back?.state, "queued", "the provider failed: it was never really tried");
    assert.equal(back?.returns, 1);
    assert.match(String(back?.cause), /503 Service Unavailable/);
    // A failure of the trial itself (not the provider's): tried, and the brief says how it ended.
    error = "the lane's memory limit of 2048 MiB was reached";
    errorKind = undefined;
    for (let i = 0; i < 50 && s.q.get(x)?.state !== "done"; i++) {
      await s.scheduler.tick();
      await s.scheduler.idle();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(s.q.get(x)?.state, "done");
    assert.equal(s.q.get(x)?.result, "error");
    const tried = s.q.brief(RUN).tried.find((e) => e.id === x);
    assert.equal(tried?.result, "error");
    assert.match(String(tried?.cause), /memory limit of 2048 MiB/);
    assert.equal(s.q.all(RUN).length, 1, "still one row");
  });

  test("after a restart, an experiment whose trial a dead controller left open goes back to the queue", async (t) => {
    const s = await setup(t, { lanes: 1 });
    const x = await s.add("half done");
    s.scheduler.registry.startTrial({
      id: "t-dead00000000000",
      run: RUN,
      lane: "lane-1",
      epoch: 1,
      family: "general",
      parent: "p",
    });
    s.q.assign(RUN, x, { lane: "lane-1", trial: "t-dead00000000000", by: "planner" }, "planner");
    new Scheduler({
      service: s.env.service,
      runner: new LocalRunner(s.env.paths.scratchDir),
      owner: "restarted",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    // Back in the queue, the same row, with why (goal 079).
    assert.equal(s.q.get(x)?.state, "queued");
    assert.equal(s.q.get(x)?.returns, 1);
    assert.match(String(s.q.get(x)?.cause), /the harness restarted/);
    assert.deepEqual(
      s.q.queued(RUN).map((e) => e.title),
      ["half done"],
    );
  });
});

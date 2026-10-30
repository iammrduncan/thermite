/**
 * A lane's trials: the token that binds a submission to its trial, no time cap unless one is set,
 * the back-off after unproductive trials, trials a dead controller left open, and the judge's
 * reason for a crash in the lane's next brief.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { briefText } from "../../../helpers/brief-text.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

describe("agent scheduler", () => {
  test("a worker's token binds its submission to its trial, once, and only while the trial is open", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
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
      runTrial: async (spec) => {
        const req = { patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] };
        const r = await env.service.submitForTrial(String(spec.token), req);
        await assert.rejects(
          env.service.submitForTrial(String(spec.token), req),
          /already submitted/,
        );
        await assert.rejects(env.service.submitForTrial("not-a-token", req), /unknown trial/);
        tokens.push(String(spec.token));
        return {
          submitted: r,
          stopped: "submitted",
          turns: 1,
          toolCalls: 1,
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    });
    const tokens: string[] = [];
    await scheduler.tick();
    await scheduler.idle();
    const t = env.ledger.db.prepare("select lane, attempt from trial").get();
    const a = env.ledger.attempts.get(String(t?.attempt));
    assert.equal(a?.lane, "lane-1");
    assert.equal(a?.family, env.ledger.db.prepare("select family from trial").get()?.family);
    // The trial has ended: its token no longer works.
    await assert.rejects(
      env.service.submitForTrial(String(tokens[0]), {
        patch_base64: env.patch(`${FAST_KERNEL}// late\n`),
        hypothesis: "late",
        known_flaws: [],
      }),
      /has ended/,
    );
  });

  test("a trial's attempt is the one the harness linked as it submitted, never the one its worker names", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 2 } });
    await env.start();
    const fake = await startFakeModel(() => ({ text: "no plan" }));
    let first: string | undefined;
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "s",
      runTrial: async (spec) => {
        if (!first) {
          const r = await env.service.submitForTrial(String(spec.token), {
            patch_base64: env.patch(FAST_KERNEL),
            hypothesis: "h",
            known_flaws: [],
          });
          first = r.attempt;
          return {
            submitted: r,
            stopped: "submitted",
            turns: 1,
            toolCalls: 1,
            tokensIn: 0,
            tokensOut: 0,
          };
        }
        // The second trial's worker submits nothing and names the first trial's attempt.
        return {
          submitted: { attempt: first, lifecycle: "queued" },
          stopped: "submitted",
          turns: 1,
          toolCalls: 1,
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    await env.drain();
    await scheduler.tick();
    await scheduler.idle();
    const trials = env.ledger.db
      .prepare("select id, family, attempt from trial order by started_at, id")
      .all() as { id: string; family: string | null; attempt: string | null }[];
    assert.equal(trials.length, 2);
    assert.equal(trials[0]?.attempt, first);
    assert.equal(trials[1]?.attempt, null, "the worker's word links nothing");
    assert.equal(env.ledger.attempts.get(String(first))?.family, trials[0]?.family);
    const finished = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "trial_finished")
      .map((e) => (e.body as { attempt: string | null }).attempt);
    assert.deepEqual(finished, [first, null]);
    await fake.close();
  });

  test("no time cap on a round or a trial unless one is set (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    const walls: (number | undefined)[] = [];
    let release: () => void = () => undefined;
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
      backoffBaseMs: 0,
      runTrial: (spec) => {
        walls.push(spec.wallMs);
        return new Promise((resolve) => {
          release = () =>
            resolve({
              stopped: "no_submission",
              turns: 1,
              toolCalls: 0,
              tokensIn: 0,
              tokensOut: 0,
            });
        });
      },
    });
    assert.ok(await scheduler.tick());
    while (!walls.length) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(walls, [undefined], "no trial length unless set");
    // The round started four hours ago and its trial still runs: the round stays open.
    env.ledger.db
      .prepare("update epoch set started_at = ?")
      .run(new Date(Date.now() - 4 * 3_600_000).toISOString());
    await scheduler.tick();
    assert.equal(scheduler.registry.currentEpoch("js-1")?.ended_at, null);
    release();
    await scheduler.idle();
    // Its trial is done: the round ends because it is complete, not at a time.
    await scheduler.tick();
    assert.notEqual(scheduler.registry.currentEpoch("js-1")?.ended_at, null);
    // A trial length the rig sets reaches the trial.
    scheduler.configure({ trialWallMs: 45 * 60_000 });
    for (let i = 0; i < 200 && walls.length < 2; i++) {
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(walls[1], 45 * 60_000);
    release();
    await scheduler.idle();
    // A trial_minutes rule on the run comes before the rig's, as it does before the contract's.
    env.ledger.directives.add("js-1", "control:owner", {
      kind: "trial_minutes",
      value: 120,
      rationale: "trials end at their limit before they submit",
      citations: [],
    });
    for (let i = 0; i < 200 && walls.length < 3; i++) {
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(walls[2], 120 * 60_000);
    release();
    await scheduler.idle();
  });

  test("lanes back off after unproductive trials", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 5 } });
    await env.start();
    let started = 0;
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
      backoffBaseMs: 60_000,
      runTrial: async () => {
        started++;
        return {
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          error: "model down",
        };
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.tick(); // within the backoff: no new trial
    await scheduler.idle();
    assert.equal(started, 1);
  });

  test("after a restart, trials a dead controller left open are closed and their lanes go on", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 2 } });
    await env.start();
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const first = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "s1",
      runTrial: () => new Promise(() => {}),
    });
    await first.tick(); // plans (fallback: no reachable model) and starts a trial that never ends
    const open = env.ledger.db
      .prepare("select id, run, lane from trial where ended_at is null")
      .all();
    assert.equal(open.length, 1);
    // Its worker reported its counters before the controller died (goal 079).
    env.service.trialReport(
      { id: String(open[0]?.id), run: String(open[0]?.run), lane: String(open[0]?.lane) },
      { progress: { turns: 4, tool_calls: 9, tokens_in: 5000, tokens_out: 300 } },
    );
    let started = 0;
    const second = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "s2",
      runTrial: async () => {
        started++;
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    const stopped = env.ledger.db
      .prepare(
        "select stopped, turns, tool_calls, tokens_in, tokens_out from trial order by started_at",
      )
      .all()
      .map((t) => [t.stopped, t.turns, t.tool_calls, t.tokens_in, t.tokens_out]);
    // Interrupted, with the counters its worker last reported: the work it did still counts.
    assert.deepEqual(stopped, [["interrupted", 4, 9, 5000, 300]]);
    assert.ok(await second.tick()); // the lane's next trial starts
    await second.idle();
    assert.equal(started, 1);
  });

  test("a lane's next brief shows the start and the end of the judge's reason for its crash", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 2 } });
    await env.start();
    // No plan from the model: the fixed plan gives the lane its experiments.
    const fake = await startFakeModel(() => ({ text: "no plan" }));
    const noisy = `import { writeSync } from "node:fs";
export function work() {
  writeSync(2, "warning: noise\\n".repeat(400) + "fatal: index 42 is out of range\\n");
  process.exit(3);
}
`;
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "scheduler-test",
      runTrial: async (spec) => {
        briefs.push(briefText(spec.brief));
        if (briefs.length > 1)
          return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
        const r = await env.service.submitForTrial(String(spec.token), {
          patch_base64: env.patch(noisy),
          hypothesis: "a crash with a long error output",
          known_flaws: [],
        });
        return {
          stopped: "submitted",
          turns: 1,
          toolCalls: 1,
          tokensIn: 0,
          tokensOut: 0,
          submitted: { attempt: r.attempt, lifecycle: r.lifecycle },
        };
      },
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    await env.drain(); // the judge decides the crash
    await scheduler.tick(); // the lane's second trial
    await scheduler.idle();
    assert.equal(briefs.length, 2);
    const judge = /\. Judge: (exit 3: [^\n]*(?:\n[^\n-][^\n]*)*)/.exec(String(briefs[1]))?.[1];
    assert.ok(judge, String(briefs[1]));
    assert.match(judge, /^exit 3: warning: noise/);
    assert.match(judge, /fatal: index 42 is out of range/);
    assert.ok(judge.length <= 1200, `${judge.length} characters`);
    await fake.close();
  });
});

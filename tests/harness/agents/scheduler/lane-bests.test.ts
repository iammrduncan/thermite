/**
 * A lane's best: a win measured against the current champion, dropped when the champion moves or
 * when a fork round sends every lane back to the champion.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

describe("agent scheduler", () => {
  test("a lane best is a win measured against the current champion, and is dropped when it moves", async () => {
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
      runTrial: async () => ({
        stopped: "no_submission",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    const a = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          lane: "lane-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "a",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    env.ledger.verdicts.record({
      attempt: a,
      verdict: "win_screened",
      delta: 0.1,
      reasons: "t",
      judgedBy: "t",
    });
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), a);
    // Another attempt becomes the champion: a's delta was measured against the old one.
    const b = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: env.patch(`${FAST_KERNEL}// b\n`),
          hypothesis: "b",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    env.ledger.verdicts.record({
      attempt: b,
      verdict: "win_confirmed",
      delta: 0.1,
      reasons: "t",
      judgedBy: "t",
    });
    env.ledger.champions.promote({
      run: "js-1",
      expectedSeq: 1,
      attempt: b,
      commitSha: String(env.ledger.attempts.get(b)?.commit_sha),
      by: "t",
    });
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
    await scheduler.idle();
  });

  test("a change the owner declined stops being its lane's best, and never becomes one", async () => {
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
      runTrial: async () => ({
        stopped: "no_submission",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    const win = async (code: string, delta: number) => {
      const id = (
        await env.service.submitAttempt(
          {
            run: "js-1",
            lane: "lane-1",
            patch_base64: env.patch(code),
            hypothesis: code.slice(-8),
            known_flaws: [],
          },
          "t",
        )
      ).attempt;
      env.ledger.verdicts.record({
        attempt: id,
        verdict: "win_screened",
        delta,
        reasons: "t",
        judgedBy: "t",
      });
      return id;
    };
    const a = await win(FAST_KERNEL, 0.1);
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), a);
    // The owner declines it: the lane no longer builds on it.
    env.ledger.attempts.setLifecycle(a, "declined", "owner:api");
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
    // A larger win the owner declined is passed over; the next one the owner left alone is kept.
    const b = await win(`${FAST_KERNEL}// b\n`, 0.3);
    env.ledger.attempts.setLifecycle(b, "declined", "owner:api");
    const c = await win(`${FAST_KERNEL}// c\n`, 0.2);
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), c);
    await scheduler.idle();
  });

  test("a fork round at a third of the wall budget sends every lane back to the champion", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: { budget: { wall_hours: 1, max_open_attempts: 4 } },
    });
    await env.start();
    const a = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          lane: "lane-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "a",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    env.ledger.verdicts.record({
      attempt: a,
      verdict: "win_screened",
      delta: 0.1,
      reasons: "t",
      judgedBy: "t",
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
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    scheduler.registry.setLaneBest("js-1", "lane-1", a, "t");
    // 40% of the hour has passed.
    env.ledger.db
      .prepare("update run set created_at = ? where id = 'js-1'")
      .run(new Date(Date.now() - 0.4 * 3_600_000).toISOString());
    await scheduler.tick();
    await scheduler.idle();
    const rounds = env.ledger.eventsAfter(0, 10_000).events.filter((e) => e.kind === "fork_round");
    assert.equal(rounds.length, 1);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { workedTime } from "../../src/harness/run-clock.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

/**
 * Goal 198 (issue 50): a run's wall-time budget counts the time it worked, in every mode, as a
 * research run's clock does: paused time is left out, and so is time the harness did not run.
 * The ledger's clock is moved by hand, from now (a signed command's time must not be in its
 * future), so each check is exact.
 */

const H = 3_600_000;

/** A hill climb on a clock the test moves: `pass(hours)` moves it. */
async function onClock(budget?: { wall_hours: number }) {
  let at = Date.now();
  const env = makeJudgeEnv({
    lanes: { count: 1, trials_per_epoch: 1 },
    clock: () => new Date(at),
    ...(budget ? { contract: { budget: { ...budget, max_open_attempts: 4 } } } : {}),
  });
  await env.start();
  const pass = (hours: number) => {
    at += hours * H;
  };
  const status = (s: "paused" | "running") =>
    env.ledger.runs.setStatus("js-1", s, s === "paused" ? "a look" : null, "owner");
  return { env, pass, status, now: () => at };
}

/** A scheduler whose trials end at once: one tick applies the run's budget. */
function schedulerOf(env: ReturnType<typeof makeJudgeEnv>) {
  return new Scheduler({
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
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
  });
}

describe("a run's clock counts the time it worked (goal 198)", () => {
  test("paused time and the harness's downtime are left out", async () => {
    const { env, pass, status, now } = await onClock();
    pass(0.5);
    status("paused");
    pass(1.5);
    status("running");
    pass(1);
    assert.equal(workedTime(env.ledger, "js-1").elapsed_ms, 1.5 * H);
    // Ten minutes the harness did not run, while the run ran.
    env.ledger.appendEvent("harness", "harness_gap", null, {
      since: new Date(now() - 0.5 * H).toISOString(),
      until: new Date(now() - 0.5 * H + 600_000).toISOString(),
      restarted: true,
    });
    assert.deepEqual(workedTime(env.ledger, "js-1"), {
      elapsed_ms: 1.5 * H - 600_000,
      waited_ms: 600_000,
    });
  });

  test("a hill climb's wall-time budget counts only the time it worked", async () => {
    // Two hours since it started, all of them at work: its budget of one hour is spent.
    const spent = await onClock({ wall_hours: 1 });
    spent.pass(2);
    const one = schedulerOf(spent.env);
    await one.tick();
    await one.idle();
    assert.equal(spent.env.ledger.runs.get("js-1")?.pause_reason, "the wall-time budget is spent");
    // Two hours too, paused for one and a half of them: it worked half an hour, and goes on.
    const paused = await onClock({ wall_hours: 1 });
    paused.pass(0.2);
    paused.status("paused");
    paused.pass(1.5);
    paused.status("running");
    paused.pass(0.3);
    const two = schedulerOf(paused.env);
    await two.tick();
    await two.idle();
    const r = paused.env.ledger.runs.get("js-1");
    assert.notEqual(r?.pause_reason, "the wall-time budget is spent");
    assert.equal(r?.status, "running");
  });
});

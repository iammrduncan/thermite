import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { endDrainAtStart } from "../../../src/harness/service/drain.ts";
import { AWAKE_EVERY_MS, AwakeWatch, gapAtStart } from "../../../src/harness/service/gaps.ts";
import { researchEnv } from "../../helpers/research-run.ts";

/**
 * A research run's clock: running time only, from the run's start, without the time
 * it was paused, its agents could not run, its rig drained or its harness did not run. The harness's clock is moved by
 * hand, so each check is exact.
 */
describe("the research clock", () => {
  /**
   * A research run on a clock the test moves by hand, from now (a signed command's time must not
   * be in its future): `now()` is its time, `pass(ms)` moves it.
   */
  const onClock = async (over: Record<string, unknown>) => {
    let at = Date.now();
    const r = await researchEnv(over, true, () => new Date(at));
    const pass = (ms: number) => {
      at += ms;
    };
    return { ...r, now: () => at, pass, clock: () => r.research.clock("r-1", at) };
  };

  test("paused time does not count on the research clock", async () => {
    const { env, clock, pass } = await onClock({ min_duration: "1h", max_duration: "2h" });
    pass(1000);
    env.service.ledger.runs.setStatus("r-1", "paused", "t", "t");
    pass(300);
    const paused = clock().elapsed_ms;
    assert.equal(paused, 1000);
    pass(300);
    assert.equal(clock().elapsed_ms, paused);
  });

  test("time the agents could not run does not count, and the minimum is never a stop (goal 079)", async () => {
    // No maximum: the minimum is a floor; the run never ends by its clock.
    const { env, clock, pass, now } = await onClock({
      min_duration: "1s",
      max_duration: undefined,
    });
    const ledger = env.service.ledger;
    pass(1100);
    const c0 = clock();
    assert.equal(c0.elapsed_ms, 1100);
    assert.equal(c0.max_ms, null);
    assert.equal(c0.done, false, "past its minimum, a run with no maximum goes on");
    // The agents stop (no credits): the clock stops with them, until they go on.
    ledger.appendEvent("scheduler", "agents_stopped", "r-1", {
      kind: "credits",
      words: "402",
      by: "trial t-1",
      said: "no credits",
    });
    pass(300);
    const stopped = clock();
    assert.equal(stopped.elapsed_ms, c0.elapsed_ms, "the clock stopped");
    assert.equal(stopped.waited_ms, 300);
    ledger.appendEvent("scheduler", "agents_resumed", "r-1", { why: "a model check passed" });
    pass(200);
    const going = clock();
    assert.equal(going.elapsed_ms - stopped.elapsed_ms, 200, "it runs again");
    // A wait for the provider's rate limit does not count either, until the time it named.
    ledger.appendEvent("scheduler", "agents_wait_for_limit", "r-1", {
      until: new Date(now() + 60_000).toISOString(),
      trial: "t-1",
      reason: "rate limit",
    });
    pass(300);
    assert.equal(clock().elapsed_ms, going.elapsed_ms, "waiting: stopped");
    // A wait for the MCP servers (goal 068) recorded after it ended is taken off the clock.
    const r3 = await onClock({ min_duration: "1s", max_duration: undefined });
    r3.pass(1200);
    const before = r3.clock();
    r3.env.service.ledger.appendEvent("scheduler", "mcp_servers_wait", "r-1", {
      since: new Date(r3.now() - 1000).toISOString(),
      waited_s: 0,
      missing: [],
    });
    const after = r3.clock();
    assert.equal(before.elapsed_ms - after.elapsed_ms, 1000, "the wait is taken off the clock");
    assert.equal(after.waited_ms, 1000);
    // With a maximum, the clock (not the minimum) ends it.
    const r2 = await onClock({ min_duration: "1s", max_duration: "2s" });
    assert.equal(r2.clock().done, false);
    assert.equal(r2.clock().max_ms, 2000);
    r2.pass(2000);
    assert.equal(r2.clock().done, true);
  });

  test("time the rig drained does not count, nor in the progress rule's time since (goal 136)", async () => {
    const { env, research, clock, pass, now } = await onClock({
      min_duration: "1s",
      max_duration: undefined,
    });
    const ledger = env.service.ledger;
    pass(300);
    const before = now();
    const c0 = clock();
    // The rig drains for an image update: no trial or plan starts, so the clock stops.
    ledger.appendEvent("owner", "rig_drain", null, { drain: true, reason: "new images" });
    pass(300);
    const drained = clock();
    assert.equal(drained.elapsed_ms, c0.elapsed_ms, "the clock stopped while it drained");
    assert.equal(drained.waited_ms, 300);
    // The progress rule's time since a moment is the clock's difference: the drain is not in it.
    assert.equal(drained.elapsed_ms - research.clock("r-1", before).elapsed_ms, 0);
    // The harness starts again, which ends the drain: the clock runs again.
    endDrainAtStart(ledger, "harness");
    pass(200);
    assert.equal(clock().elapsed_ms - drained.elapsed_ms, 200, "it runs again");
  });

  test("time the harness did not run does not count, in a wait for a rate limit too (issue #45)", async () => {
    const { env, clock, pass, now } = await onClock({ min_duration: "2h", max_duration: "6h" });
    const ledger = env.service.ledger;
    // The awake loop's rounds while the harness runs; a new harness process starts a new one.
    let awake = new AwakeWatch(ledger, now());
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += AWAKE_EVERY_MS) {
        pass(AWAKE_EVERY_MS);
        awake.note(now());
      }
    };
    run(60_000);
    const worked = clock();
    assert.equal(worked.elapsed_ms, 60_000);
    // The provider's free cap is reached: the agents wait for the ten minutes it names.
    ledger.appendEvent("scheduler", "agents_wait_for_limit", "r-1", {
      until: new Date(now() + 10 * 60_000).toISOString(),
      trial: "t-1",
      reason: "Free usage limit reached",
      in_trial: true,
    });
    run(10 * 60_000);
    assert.equal(clock().elapsed_ms, worked.elapsed_ms, "the wait does not count");
    // The host sleeps as the wait ends, for three and a half hours: the next round finds it.
    pass(3.5 * 3_600_000);
    awake.note(now());
    const slept = clock();
    assert.equal(slept.elapsed_ms, worked.elapsed_ms, "the sleep does not count");
    // The stack is stopped overnight, and started again: the start finds that gap.
    pass(10 * 3_600_000);
    gapAtStart(ledger, now());
    awake = new AwakeWatch(ledger, now());
    const restarted = clock();
    assert.equal(restarted.elapsed_ms, worked.elapsed_ms, "the night does not count");
    assert.equal(restarted.done, false, "the run did not reach its maximum while away");
    assert.ok(restarted.waited_ms >= 13.5 * 3_600_000);
    // The cap has lifted: the agents work again, and the clock runs with them.
    run(60_000);
    assert.equal(clock().elapsed_ms - worked.elapsed_ms, 60_000, "it runs again");
  });
});

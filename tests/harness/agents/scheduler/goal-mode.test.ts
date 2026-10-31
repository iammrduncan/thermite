/**
 * A goal campaign's rounds: planned from the judge's goal report on the champion, or without it
 * after the wait, and held while the judge confirms a champion that meets every goal.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { briefText } from "../../../helpers/brief-text.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

describe("agent scheduler", () => {
  /**
   * A goal campaign with one lane, a planner that records its input, and trials that record their
   * brief. With `hold`, each trial runs until `release(n)` (or an abort) ends it.
   */
  async function goalSetup(
    goalReportWaitMs?: number,
    o: { trialsPerEpoch?: number; hold?: boolean } = {},
  ) {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 90e6 },
      contract: { lanes: { count: 1, trials_per_epoch: o.trialsPerEpoch ?? 1 } },
    });
    await env.start();
    const planned: string[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      if (!tools.some((t) => t.function.name === "submit_plan")) return { text: "done" };
      planned.push(JSON.stringify(messages));
      return {
        toolCalls: [
          {
            name: "submit_plan",
            args: {
              new_families: [{ id: "speed", description: "make the sum faster" }],
              assignments: [
                {
                  lane: "lane-1",
                  family: "speed",
                  focus: "reach the fast goal",
                  parent: "champion",
                },
              ],
            },
          },
        ],
      };
    });
    const briefs: string[] = [];
    const waiting: (() => void)[] = [];
    let aborted = 0;
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "scheduler-test",
      goalReportWaitMs,
      // A trial that submits nothing would make the lane wait before its next one.
      backoffBaseMs: 0,
      runTrial: async (spec, signal) => {
        if (o.hold) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            briefs.push(briefText(spec.brief));
            signal.addEventListener("abort", () => {
              aborted++;
              resolve();
            });
          });
        } else briefs.push(briefText(spec.brief));
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    const live = () =>
      env.service.live
        .since(0)
        .entries.map((e) => e.text)
        .join("\n");
    /** Ends the trials that are running, once `n` trials in all have reached their worker. */
    const release = async (n: number) => {
      while (briefs.length < n) await new Promise((r) => setTimeout(r, 10));
      for (const r of waiting.splice(0)) r();
    };
    return { env, fake, planned, briefs, scheduler, live, release, aborted: () => aborted };
  }

  test("goal mode: an epoch is planned from the judge's goal report on the champion", async () => {
    const { env, fake, planned, briefs, scheduler, live } = await goalSetup();
    assert.equal(await scheduler.tick(), false); // the seed is not validated yet: no plan
    assert.equal(planned.length, 0);
    assert.match(live(), /round 1 waits for the judge's goal report on champion #1/);
    await env.drain(); // the judge validates the seed
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    assert.equal(planned.length, 1);
    assert.match(live(), /^planning round 1 \(1 lane\)$/m);
    // The planner and the worker both see what the champion meets.
    assert.match(String(planned[0]), /\\"goal_report\\"/);
    assert.match(String(planned[0]), /\\"goal\\":\\"fast\\",[^}]*\\"status\\":\\"unmet\\"/);
    assert.match(String(briefs[0]), /# What the champion meets/);
    // A met goal's reasons too: a code goal's values on its public cases (goal 086).
    assert.match(
      String(briefs[0]),
      // Then the other numbers the check printed at its top level.
      /- correct: met\. verifier correctness passed on small: small: ops_per_s \d\.\d{5}e\+\d+, value \d\.\d{5}e\+\d+\n/,
    );
    assert.match(String(briefs[0]), /- fast: unmet\. /);
    await fake.close();
  });

  test("goal mode: no new trial while a champion that met every goal is confirmed; a trial at work goes on; trials start again when the confirmation fails (goal 086)", async () => {
    const { env, fake, scheduler, live, release, aborted } = await goalSetup(undefined, {
      trialsPerEpoch: 3,
      hold: true,
    });
    await env.drain(); // the seed's goal report: fast is not met
    assert.ok(await scheduler.tick()); // round 1, and its first trial
    assert.equal(scheduler.trialsRunning, 1);
    // A validation found every required goal met: the judge's confirming validation is queued.
    const confirm = env.ledger.jobs.enqueue({
      kind: "validate",
      priority: 40,
      spec: { run: "js-1", champion_seq: 1, confirm: true },
      actor: "judge-test",
    });
    assert.equal(await scheduler.tick(), false);
    assert.match(
      live(),
      /no new trial starts: the judge is confirming that champion #1 meets every required goal; if it does, the run closes \(a trial at work goes on until then\)/,
    );
    // The trial at work goes on; when it ends, the lane's next trial still waits.
    assert.equal(scheduler.trialsRunning, 1);
    await release(1);
    await scheduler.idle();
    assert.equal(aborted(), 0, "the trial at work ended as it would");
    // Leased by the judge is still pending.
    env.ledger.db.prepare("update job set state = 'leased' where id = ?").run(confirm);
    assert.equal(await scheduler.tick(), false);
    const trials = () => Number(env.ledger.db.prepare("select count(*) as n from trial").get()?.n);
    assert.equal(trials(), 1);
    // Said once, however many ticks it waits.
    assert.equal(live().match(/no new trial starts: the judge is confirming/g)?.length, 1);
    // The confirmation failed: the lanes go on.
    env.ledger.db
      .prepare("update job set state = 'failed', result = '{}' where id = ?")
      .run(confirm);
    assert.ok(await scheduler.tick());
    assert.equal(trials(), 2);
    assert.match(
      live(),
      /trials start again: the judge's confirmation of champion #1 did not close the run/,
    );
    await release(2);
    await scheduler.idle();
    await fake.close();
  });

  test("goal mode: a confirmation queued for another champion does not hold the lanes (goal 086)", async () => {
    const { env, fake, scheduler } = await goalSetup(undefined, { trialsPerEpoch: 2 });
    await env.drain();
    env.ledger.jobs.enqueue({
      kind: "validate",
      priority: 40,
      spec: { run: "js-1", champion_seq: 7, confirm: true },
      actor: "judge-test",
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    await fake.close();
  });

  test("goal mode: with no goal report in time, the epoch is planned anyway", async () => {
    const { env, fake, planned, scheduler, live } = await goalSetup(0);
    assert.ok(await scheduler.tick()); // nothing validated, the wait is over: planned
    await scheduler.idle();
    assert.equal(planned.length, 1);
    assert.doesNotMatch(String(planned[0]), /\\"goal_report\\"/);
    assert.match(
      live(),
      /planning round 1 without a goal report on champion #1 \(none after 0 min\)/,
    );
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 1);
    await fake.close();
  });
});

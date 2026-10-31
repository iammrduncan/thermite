import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { briefText } from "../../../helpers/brief-text.ts";
import {
  CRASH_KERNEL,
  FAST_KERNEL,
  makeJudgeEnv,
  WRONG_KERNEL,
} from "../../../helpers/judge-env.ts";

/**
 * A hill climb's rounds wait for the judge's baseline of the starting point (goal 115), and a
 * starting point the judge can't measure gives setup rounds: each lane works to make it build
 * and run, and the first change the judge can measure becomes the starting point.
 */

/** A scheduler whose planner has no reachable model (the fixed rules plan) and whose trials run `trial`. */
function schedulerFor(
  env: ReturnType<typeof makeJudgeEnv>,
  trial: (spec: TrialSpec) => Promise<string | undefined>,
) {
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
    runTrial: async (spec) => {
      const kernel = await trial(spec);
      if (!kernel)
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 1, tokensOut: 1 };
      const r = await env.service.submitForTrial(String(spec.token), {
        patch_base64: env.patch(kernel),
        hypothesis: "make it run",
        known_flaws: [],
      });
      return {
        stopped: "submitted",
        turns: 1,
        toolCalls: 1,
        tokensIn: 1,
        tokensOut: 1,
        submitted: { attempt: r.attempt, lifecycle: r.lifecycle },
      };
    },
  });
}

const planner = (env: ReturnType<typeof makeJudgeEnv>) =>
  env.service.live
    .since(0, 1000)
    .entries.filter((e) => e.source === "planner")
    .map((e) => e.text);

describe("a hill climb's rounds and its baseline (goal 115)", () => {
  test("round 1 waits for the judge's baseline of the starting point, then is planned", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const briefs: string[] = [];
    const scheduler = schedulerFor(env, async (spec) => {
      briefs.push(briefText(spec.brief));
      return undefined;
    });
    assert.equal(await scheduler.tick(), false);
    assert.equal(await scheduler.tick(), false);
    const epochs = () => env.ledger.db.prepare("select n from epoch").all();
    assert.deepEqual(epochs(), []);
    assert.deepEqual(
      planner(env).filter((t) => t.includes("baseline")),
      ["round 1 waits for the judge's baseline of the starting point (champion #1)"],
    );
    assert.equal(await env.judge.tick(), true); // the baseline
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    assert.equal(epochs().length, 1);
    assert.equal(briefs.length, 1);
    assert.doesNotMatch(briefs[0] ?? "", /can't be measured yet/);
  });

  test("setup: the brief gives the judge's reasons; a change it can't measure gets its verdict, one it can becomes the starting point", async () => {
    const env = makeJudgeEnv({
      seedKernel: CRASH_KERNEL,
      lanes: { count: 1, trials_per_epoch: 2 },
    });
    await env.service.applyCommand(env.assign);
    await env.drain(); // the baseline fails: the seed crashes
    const briefs: string[] = [];
    const kernels = [WRONG_KERNEL, FAST_KERNEL];
    const scheduler = schedulerFor(env, async (spec) => {
      briefs.push(briefText(spec.brief));
      return kernels.shift();
    });

    // Round 1 is a setup round: one trial for the lane, on a setup experiment.
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    const round1 = env.ledger.latestEventBody("epoch_started", "js-1");
    assert.equal(round1?.plan, "setup");
    const brief = briefs[0] ?? "";
    assert.match(brief, /# The starting point can't be measured yet \(setup\)/);
    assert.match(brief, /champion #1 \(commit [0-9a-f]{12}\)/);
    assert.match(brief, /cell small: exit 3/);
    assert.match(brief, /change the project, never the kit/);
    assert.match(brief, /Direction: setup/);
    assert.ok(
      planner(env).some((t) =>
        t.startsWith(
          "the judge could not measure the starting point (champion #1): the run is in setup",
        ),
      ),
    );
    const setupJobs = () =>
      env.ledger.db
        .prepare("select kind from job where attempt is not null order by id")
        .all()
        .map((r) => r.kind);
    assert.deepEqual(setupJobs(), ["baseline"]);
    await env.drain();
    const first = env.ledger.db.prepare("select attempt from trial where epoch = 1").get() as {
      attempt: string;
    };
    assert.equal(env.ledger.verdicts.current(first.attempt)?.verdict, "invalid");

    // The round ends with its one trial; round 2 is a setup round again, and its brief has the
    // judge's words on the lane's last change.
    assert.equal(await scheduler.tick(), false); // round 1 ends
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    assert.equal(env.ledger.latestEventBody("epoch_started", "js-1")?.plan, "setup");
    assert.match(
      briefs[1] ?? "",
      /Judge: the judge could not measure this setup change, so the run is still in setup/,
    );
    await env.drain();
    const second = env.ledger.db.prepare("select attempt from trial where epoch = 2").get() as {
      attempt: string;
    };
    assert.equal(env.ledger.verdicts.current(second.attempt)?.verdict, "starting_point");
    assert.equal(env.ledger.champions.current("js-1").attempt, second.attempt);

    // Setup is over: round 3 is a round of the plan, from the new starting point.
    assert.equal(await scheduler.tick(), false); // round 2 ends
    await scheduler.tick();
    await scheduler.idle();
    const round3 = env.ledger.latestEventBody("epoch_started", "js-1");
    assert.equal(round3?.n, 3);
    assert.equal(round3?.plan, undefined);
    assert.ok(
      planner(env).some((t) =>
        t.startsWith("the judge measured the starting point (champion #2): ops_per_s small"),
      ),
    );
    assert.doesNotMatch(briefs[2] ?? "", /can't be measured yet/);
    assert.match(briefs[2] ?? "", /Starting point: the champion \(seq 2\)/);
  });
});

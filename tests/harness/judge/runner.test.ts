import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RigRunner } from "../../../src/harness/judge/runner.ts";
import { RunnerAway } from "../../../src/harness/judge/runner-link.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * Goal 206, step 2a: the judge builds and measures only through its runner. With the core's own
 * runner wrapped, every build, run, throttle reading and baseline folder of a hill climb's start
 * and of a candidate's judging reaches the wrapper, and the verdict is as before.
 */

/** The core's runner, with every call counted by its name. */
function counting(core: RigRunner, calls: Record<string, number>): RigRunner {
  const count = <T>(k: string, call: () => T): T => {
    calls[k] = (calls[k] ?? 0) + 1;
    return call();
  };
  return {
    name: core.name,
    driver: core.driver,
    separated: core.separated,
    build: (i) => count("build", () => core.build(i)),
    measure: (s, a, c) => count("measure", () => core.measure(s, a, c)),
    throttle: () => count("throttle", () => core.throttle()),
    baselineWork: (j) => count("baselineWork", () => core.baselineWork(j)),
    keepBaseline: (w, t) => count("keepBaseline", () => core.keepBaseline(w, t)),
    remove: (d) => count("remove", () => core.remove(d)),
  };
}

describe("the judge's runner (goal 206)", () => {
  test("a hill climb's start and a candidate's judging build and measure through it", async () => {
    const calls: Record<string, number> = {};
    const env = makeJudgeEnv({ wrapRunner: (core) => counting(core, calls) });
    await env.start();
    // The starting point's baseline: its folder, a build, its runs, and the folder kept.
    assert.equal(calls.baselineWork, 1);
    assert.equal(calls.keepBaseline, 1);
    assert.ok((calls.build ?? 0) >= 1, JSON.stringify(calls));
    const before = { build: calls.build ?? 0, measure: calls.measure ?? 0 };
    const r = await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "a faster kernel",
        known_flaws: [],
      },
      "proposer",
    );
    await env.drain();
    assert.ok(env.ledger.verdicts.current(r.attempt), env.explain(r.attempt));
    // The candidate is built there, and both arms measured there, block by block.
    assert.ok((calls.build ?? 0) > before.build, JSON.stringify(calls));
    assert.ok((calls.measure ?? 0) > before.measure + 1, JSON.stringify(calls));
    assert.ok((calls.throttle ?? 0) >= 2, JSON.stringify(calls));
  });

  test("a job whose runner went away goes back to the queue, and never counts against the change (3c)", async () => {
    let away = false;
    const env = makeJudgeEnv({
      wrapRunner: (core) => ({
        ...counting(core, {}),
        measure: (s, a, c) => {
          if (away) {
            away = false;
            return Promise.reject(new RunnerAway("the runner box-2 stopped answering"));
          }
          return core.measure(s, a, c);
        },
      }),
    });
    await env.start();
    away = true;
    const r = await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "a faster kernel",
        known_flaws: [],
      },
      "proposer",
    );
    await env.drain();
    assert.equal(away, false, "its first measurement went away");
    const verdicts = env.ledger.db
      .prepare("select verdict from verdict where attempt = ?")
      .all(r.attempt) as { verdict: string }[];
    assert.ok(verdicts.length >= 1, env.explain(r.attempt));
    assert.ok(
      verdicts.every((v) => v.verdict !== "crash_infra"),
      `no infrastructure failure is recorded: ${JSON.stringify(verdicts)}`,
    );
    const requeued = env.ledger.db
      .prepare("select count(*) as n from event where kind = 'crash_infra'")
      .get() as { n: number };
    assert.equal(requeued.n, 1, "its job went back to the queue once");
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recordInfraFailure } from "../../../src/harness/judge/failure.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

async function setup() {
  const env = makeJudgeEnv({ realRuns: true });
  await env.start();
  const id = (
    await env.service.submitAttempt(
      { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "faster", known_flaws: [] },
      "proposer",
    )
  ).attempt;
  return { ...env, id };
}

describe("the judge's failures (goal 163)", () => {
  test("a job whose run's contract can't be read stops as an infrastructure failure, with no held-out mask guessed", async () => {
    const env = await setup();
    // Only the read that sets the held-out mask fails, as one read of a file may: every other
    // read of the job succeeds, so nothing but that read can stop it.
    const real = env.service.contractFor.bind(env.service);
    env.service.contractFor = (run: string) => {
      if (/at JudgeContext\.context /.test(new Error().stack ?? ""))
        throw new Error("the contract could not be read");
      return real(run);
    };
    await env.judge.tick();
    const verdicts = env.ledger.db
      .prepare("select verdict, reasons from verdict where attempt = ? order by id")
      .all(env.id) as { verdict: string; reasons: string }[];
    assert.equal(verdicts[0]?.verdict, "crash_infra", env.explain(env.id));
    assert.match(verdicts[0]?.reasons ?? "", /the contract could not be read/);
    // Tried once more, as any infrastructure failure: the change itself is never judged on it.
    assert.equal(env.ledger.attempts.get(env.id)?.lifecycle, "queued");
  });

  test("a failure recorded under a lost lease records nothing, and never throws", async () => {
    const env = await setup();
    const job = env.ledger.jobs.lease("executor-0", 60_000);
    assert.ok(job);
    const stale = { ...job, fence: job.fence - 1 };
    recordInfraFailure(env.ledger, stale, "a build tool went missing", {
      owner: "judge-test",
      spec: {},
    });
    const n = env.ledger.db
      .prepare("select count(*) as n from verdict where attempt = ? and verdict = 'crash_infra'")
      .get(env.id) as { n: number };
    assert.equal(n.n, 0);
    assert.equal(env.ledger.jobs.get(job.id)?.state, "leased");
  });
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InvalidationReach } from "../../src/core/invalidation.ts";
import { type HarnessEnv, makeHarnessEnv } from "./harness-env.ts";

/**
 * A hill climb's run with attempts the judge's records stand on, for the tests of withdrawing
 * evidence (goal 174): changes submitted as a worker submits them, each screened as the judge
 * records a screen (its job, then a verdict on it), and champions promoted one on the other.
 */

export const RUN = "smoke-1";

export type Applied = { status: string; accepted?: boolean; result?: unknown; reason?: string };
/** The harness's answer to `invalidate_evidence`. */
export type Answer = { preview?: boolean; sha: string; reach: InvalidationReach; words: string[] };

export async function assigned(): Promise<HarnessEnv> {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.equal((out as Applied).accepted, true, JSON.stringify(out));
  return env;
}

/** A change adding one file to the kernel, built on `parent` (the champion by default). */
export async function submit(env: HarnessEnv, file: string, parent?: string) {
  const patch = env.patchFrom((dir) =>
    writeFileSync(join(dir, "src", "kernel", file), `int ${file.replace(".c", "")};\n`),
  );
  return env.service.submitAttempt(
    { run: RUN, parent, patch_base64: patch, hypothesis: `adds ${file}`, known_flaws: [] },
    "test",
  );
}

/** The judge's screen of an attempt, as the judge records it: its job, then a verdict on it. */
export function judge(env: HarnessEnv, attempt: string, verdict: string): number {
  const ledger = env.service.ledger;
  const job = ledger.jobs.lease("judge", 60_000, ["evaluate"]);
  assert.equal(job?.attempt, attempt);
  ledger.jobs.complete(job.id, job.fence, "done", {});
  ledger.verdicts.record({
    attempt,
    verdict,
    dependsOnJobs: [job.id],
    reasons: "measured",
    judgedBy: "judge",
  });
  ledger.attempts.setLifecycle(attempt, "judged", "judge");
  return job.id;
}

export function promote(env: HarnessEnv, attempt: string, expectedSeq: number, commitSha: string) {
  const r = env.service.ledger.champions.promote({
    run: RUN,
    expectedSeq,
    attempt,
    commitSha,
    by: "judge",
  });
  assert.equal(r.ok, true);
}

/** A hill climb with two champions built one on the other, a change on the newest, and another. */
export async function twoChampions() {
  const env = await assigned();
  const a = await submit(env, "a.c");
  const jobA = judge(env, a.attempt, "win_confirmed");
  promote(env, a.attempt, 1, a.commit);
  const b = await submit(env, "b.c", a.commit);
  judge(env, b.attempt, "win_confirmed");
  promote(env, b.attempt, 2, b.commit);
  const c = await submit(env, "c.c", env.seedCommit);
  judge(env, c.attempt, "neutral");
  // On the newest champion, still waiting for the judge.
  const d = await submit(env, "d.c");
  return { env, a, b, c, d, jobA };
}

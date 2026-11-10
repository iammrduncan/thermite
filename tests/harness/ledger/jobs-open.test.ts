import assert from "node:assert/strict";
import { test } from "node:test";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * The judge's work as the lanes and a shared runner see it (goal 201): what the judge is doing or
 * can take. A paused run's queued jobs wait until it is resumed, and the judge never takes them
 * (its lease takes a running run's jobs alone), so they hold up nothing: a lane's dev run on a
 * device the judge shares (agents/devrun.ts) and the judge's hold on a shared runner
 * (judge/judge.ts) both count by `jobs.open`.
 */

const KINDS = ["evaluate", "confirm", "calibrate", "validate"];

test("open counts the jobs the judge has under way or can take, never a paused or closed run's queued ones", async () => {
  const env = makeJudgeEnv({});
  await env.service.applyCommand(env.assign);
  const { db, jobs } = env.ledger;
  db.prepare("update job set state = 'done' where state in ('queued', 'leased')").run();
  const run = (id: string, status: string) =>
    db
      .prepare(
        `insert into run (id, campaign, version, contract_sha, mode, seed_repo, seed_commit, status, created_at, updated_at)
         select ?, campaign, version, contract_sha, mode, seed_repo, seed_commit, ?, created_at, updated_at
         from run where id = 'js-1'`,
      )
      .run(id, status);
  run("paused-1", "paused");
  run("closed-1", "closed");
  const job = (r: string) => jobs.enqueue({ kind: "calibrate", spec: { run: r }, actor: "t" });
  assert.equal(jobs.open(KINDS), 0);

  // A paused run's queued job, and a closed run's that is not yet cancelled: nothing to take.
  job("paused-1");
  job("closed-1");
  assert.equal(jobs.open(KINDS), 0);

  // A running run's queued job counts, and so does a job with no run.
  job("js-1");
  assert.equal(jobs.open(KINDS), 1);
  jobs.enqueue({ kind: "validate", spec: {}, actor: "t" });
  assert.equal(jobs.open(KINDS), 2);

  // A paused run's job the judge took before the pause goes on, and counts.
  const taken = job("paused-1");
  db.prepare("update job set state = 'leased', lease_owner = 'executor-0' where id = ?").run(taken);
  assert.equal(jobs.open(KINDS), 3);

  // Its run resumed, the paused run's queued job can be taken again, and counts.
  db.prepare("update run set status = 'running' where id = 'paused-1'").run();
  assert.equal(jobs.open(KINDS), 4);
  // Only the kinds asked about.
  assert.equal(jobs.open(["validate"]), 1);
});

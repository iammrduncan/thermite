import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { JudgeContext } from "../../../src/harness/judge/context.ts";
import { jobsAtStart, whileLeased } from "../../../src/harness/judge/lease.ts";
import { Ledger, MAX_LEASE_EXPIRIES } from "../../../src/harness/ledger/index.ts";
import { hillClimbFixture } from "../../helpers/fixtures.ts";

test("a long build keeps its job's lease: renewed while it runs, and no more once it ends", async () => {
  let renewed = 0;
  const out = await whileLeased(
    () => {
      renewed++;
    },
    10,
    () => new Promise<string>((r) => setTimeout(() => r("built"), 75)),
  );
  assert.equal(out, "built");
  assert.ok(renewed >= 4, `renewed ${renewed} times`);
  const after = renewed;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(renewed, after, "no renewal after the build");
  // A lost lease stops the renewals; the build ends as it will.
  let tries = 0;
  await whileLeased(
    () => {
      tries++;
      throw new Error("lease lost");
    },
    5,
    () => new Promise((r) => setTimeout(r, 40)),
  );
  assert.equal(tries, 1);
  // A build that fails ends the renewals too.
  await assert.rejects(
    whileLeased(
      () => {},
      5,
      () => Promise.reject(new Error("build failed")),
    ),
    /build failed/,
  );
});

/** A ledger with one run, one attempt and its job of `kind`, on a clock the test moves. */
function oneJob(kind = "evaluate") {
  let now = new Date("2026-10-25T00:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "thermite-lease-"));
  const ledger = Ledger.open(join(dir, "ledger.db"), () => now);
  const parsed = parseContract(hillClimbFixture);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  ledger.contracts.store(parsed.contract, parsed.sha, "t");
  const seed = "a".repeat(40);
  ledger.runs.create({
    id: "r",
    contract: parsed.contract,
    contractSha: parsed.sha,
    seedRepo: "s",
    seedCommit: seed,
    actor: "t",
  });
  ledger.attempts.record(
    {
      id: "a-1",
      run: "r",
      parentRef: "seed",
      parentCommit: seed,
      baselineChampionSeq: 1,
      commitSha: "b".repeat(40),
      ref: "refs/thermite/attempts/a-1",
      diffSha: "d",
      normalizedDiffSha: "d",
      lifecycle: "queued",
    },
    "t",
  );
  const job = ledger.jobs.enqueue({ attempt: "a-1", kind, actor: "t" });
  const tick = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const lose = () => {
    assert.ok(ledger.jobs.lease("executor-0", 1_000));
    tick(2_000);
    ledger.jobs.expireLeases();
  };
  return { ledger, job, lose, tick };
}

/** The attempt's newest verdict and its reasons, as a plain object (node:sqlite's rows have no prototype). */
function verdictOf(ledger: Ledger, attempt: string) {
  const row = ledger.db
    .prepare("select verdict, reasons from verdict where attempt = ? order by id desc limit 1")
    .get(attempt) as { verdict: string; reasons: string } | undefined;
  return row && { verdict: row.verdict, reasons: row.reasons };
}

test("a measurement run longer than the lease keeps it while it goes on, and no more once it ends (goal 240)", async () => {
  const { ledger, job, tick } = oneJob();
  const leaseMs = 90;
  const held = ledger.jobs.lease("executor-0", leaseMs);
  assert.ok(held);
  const expired: number[] = [];
  // The run goes on for more than three leases on the ledger's clock, in steps.
  const target = {
    measure: async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 40));
        tick(30);
        expired.push(...ledger.jobs.expireLeases());
      }
      return { run: { kind: "ok" }, throttled: undefined };
    },
  };
  const judge = new JudgeContext({
    service: { ledger } as never,
    runner: undefined as never,
    driver: undefined as never,
    owner: "executor-0",
    leaseMs,
    target: target as never,
  });
  judge.holding = held;
  const m = await judge.measureRun({} as never, { name: "candidate" } as never, "bench");
  assert.equal(m.run.kind, "ok");
  assert.deepEqual(expired, [], "the lease never ran out while the run went on");
  assert.equal(ledger.jobs.get(job)?.state, "leased");
  assert.equal(ledger.jobs.get(job)?.fence, held.fence);
  // Once the run ends, nothing renews it: a judge that stops loses the job as before.
  tick(2 * leaseMs);
  assert.deepEqual(ledger.jobs.expireLeases(), [job]);
  ledger.close();
});

test("a job blocked by lost leases ends its attempt, and gets one more try at the harness's start", () => {
  const { ledger, job, lose } = oneJob();
  const lifecycle = () => ledger.attempts.get("a-1")?.lifecycle;
  for (let i = 0; i < MAX_LEASE_EXPIRIES; i++) lose();
  assert.equal(ledger.jobs.get(job)?.state, "blocked");
  // Its attempt is settled, so the lane's round can end without it.
  assert.equal(lifecycle(), "errored");
  // It says why, with no verdict on the change (goal 240).
  assert.deepEqual(verdictOf(ledger, "a-1"), {
    verdict: "crash_infra",
    reasons:
      "the judge lost this job 3 times (the judge that held it did not renew its lease in time): no verdict on the change. The job is blocked; the harness tries it once more when it starts again",
  });
  const said: string[] = [];
  jobsAtStart(ledger, (msg) => said.push(msg));
  assert.deepEqual(said, ["blocked jobs queued again at start"]);
  assert.equal(ledger.jobs.get(job)?.state, "queued");
  assert.equal(lifecycle(), "queued");
  const event = ledger.db
    .prepare("select body from event where kind = 'job_unblocked' and subject = ?")
    .get(String(job)) as { body: string };
  assert.equal(JSON.parse(event.body).expiries, MAX_LEASE_EXPIRIES);
  // One more lost lease blocks it again; nothing is blocked, nothing is queued again.
  lose();
  assert.equal(ledger.jobs.get(job)?.state, "blocked");
  assert.equal(lifecycle(), "errored");
  assert.deepEqual(ledger.jobs.unblock("t"), [job]);
  assert.deepEqual(ledger.jobs.unblock("t"), []);
  ledger.close();
});

test("a blocked parent screen leaves its change's verdict and lifecycle as they are (goals 135, 240)", () => {
  const { ledger, job, lose } = oneJob("parent_screen");
  ledger.attempts.setLifecycle("a-1", "judged", "t");
  for (let i = 0; i < MAX_LEASE_EXPIRIES; i++) lose();
  assert.equal(ledger.jobs.get(job)?.state, "blocked");
  assert.equal(ledger.attempts.get("a-1")?.lifecycle, "judged");
  assert.equal(verdictOf(ledger, "a-1"), undefined);
  ledger.close();
});

test("a job whose third lost lease is the start's own reclaim stays blocked (goal 163)", () => {
  const { ledger, job, lose } = oneJob();
  for (let i = 0; i < MAX_LEASE_EXPIRIES - 1; i++) lose();
  // Its third try kills the controller: the harness starts again with the job still leased.
  assert.ok(ledger.jobs.lease("executor-0", 60_000));
  jobsAtStart(ledger, () => {});
  assert.equal(ledger.jobs.get(job)?.state, "blocked", "never retried for ever");
  assert.equal(ledger.attempts.get("a-1")?.lifecycle, "errored");
  assert.match(
    verdictOf(ledger, "a-1")?.reasons ?? "",
    /^the judge lost this job 3 times \(the harness stopped, or its runner left the rig, while the job ran\)/,
  );
  // The next start gives it its one more try, as for any blocked job.
  jobsAtStart(ledger, () => {});
  assert.equal(ledger.jobs.get(job)?.state, "queued");
  ledger.close();
});

test("at the start, a job a runner's executor held goes back to the queue, its runner gone or not (goal 206)", () => {
  const { ledger, job } = oneJob();
  // The core stopped while the executor on box-2's first runner held the job; box-2 left meanwhile.
  assert.ok(ledger.jobs.lease("executor-box-2-0", 60_000));
  const said: string[] = [];
  jobsAtStart(ledger, (msg) => said.push(msg));
  assert.deepEqual(said, ["reclaimed leases at start"]);
  assert.equal(ledger.jobs.get(job)?.state, "queued");
  ledger.close();
});

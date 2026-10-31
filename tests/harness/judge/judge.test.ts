import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { Judge } from "../../../src/harness/judge/judge.ts";
import { clipReason, REASON_CHARS } from "../../../src/harness/judge/reasons.ts";
import { CpuDriver } from "../../../src/harness/targets/cpu.ts";
import { CRASH_KERNEL, FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../../helpers/judge-env.ts";

/** Verdict history with reasons, for assertion messages. */
function why(
  env: { ledger: { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } } } },
  id: string,
): string {
  return JSON.stringify(
    env.ledger.db
      .prepare("select verdict, reasons from verdict where attempt = ? order by id")
      .all(id),
  );
}

async function setup(opts: Parameters<typeof makeJudgeEnv>[0] = {}) {
  const env = makeJudgeEnv({ realRuns: true, ...opts });
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  return { ...env, submit };
}

describe("judge pipeline (local runner, Node test kit)", () => {
  test("a faster correct kernel is screened, confirmed and promoted", async () => {
    const env = await setup();
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const history = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
    assert.deepEqual(history, ["win_screened", "win_confirmed"], why(env, id));
    const champ = env.ledger.champions.current("js-1");
    assert.equal(champ.seq, 2);
    assert.equal(champ.attempt, id);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "promoted");
    // Measurements name their arm (the starting point's baseline first), and receipts exist for
    // every block.
    const arms = env.ledger.db
      .prepare("select distinct arm from measurement order by arm")
      .all()
      .map((r) => r.arm);
    assert.deepEqual(arms, ["baseline", "candidate", "champion"]);
    const receipts = env.ledger.db.prepare("select count(*) as n from receipt").get();
    // The baseline's 3 blocks, at least the first screening look (3 blocks) and 4 confirmation
    // blocks.
    assert.ok(Number(receipts?.n) >= 10, `receipts ${receipts?.n}`);
  });

  test("two judge cards: each calibrates itself, and a win screened on one is confirmed on the other", async () => {
    const env = await setup();
    const card = (index: number) =>
      new Judge({
        service: env.service,
        runner: new LocalRunner(env.paths.scratchDir),
        driver: new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY }),
        owner: `executor-${index}`,
        promotion: "auto",
        readyRetries: 0,
        calibrationBlocks: 2,
        card: { index, uuid: `GPU-${"ab"[index]}`, count: 2 },
      });
    const [a, b] = [card(0), card(1)];
    // The run's baseline first, on either card; then each card schedules and runs its own
    // calibration.
    assert.equal(await a.tick(), true);
    assert.equal(env.ledger.latestEventBody("baseline", "js-1")?.champion_seq, 1);
    assert.equal(await a.tick(), true);
    assert.equal(await b.tick(), true);
    const cals = env.ledger.db
      .prepare(
        "select json_extract(body, '$.card') as card from event where kind = 'calibration' order by id",
      )
      .all()
      .map((r) => r.card);
    assert.deepEqual([...cals].sort(), ["GPU-a", "GPU-b"]);
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    // Card A screens it; the confirmation is then not A's to take.
    assert.equal(await a.tick(), true);
    const confirm = env.ledger.db
      .prepare("select id, spec from job where kind = 'confirm' and attempt = ?")
      .get(id) as { id: number; spec: string };
    assert.equal(JSON.parse(confirm.spec).avoid_card, "GPU-a");
    assert.equal(await a.tick(), false);
    assert.equal(await b.tick(), true);
    const leased = env.ledger.db
      .prepare("select actor from event where kind = 'job_leased' and subject = ?")
      .all(String(confirm.id))
      .map((r) => r.actor);
    assert.deepEqual(leased, ["executor-1"]);
    assert.equal(
      (
        env.ledger.db.prepare("select state from job where id = ?").get(confirm.id) as {
          state: string;
        }
      ).state,
      "done",
    );
    assert.deepEqual(
      env.ledger.db
        .prepare("select verdict from verdict where attempt = ? order by id")
        .all(id)
        .map((r) => r.verdict),
      ["win_screened", "win_confirmed"],
      why(env, id),
    );
    assert.equal(env.ledger.champions.current("js-1").attempt, id);
  });

  test("a score from the judge's clock as plain time: a faster kernel wins on lower seconds", async () => {
    const env = await setup({
      kitMetrics: { seconds: { unit: "s", from: "time" } },
      contract: {
        objective: { primary: { metric: "seconds", direction: "min", min_effect: 0.1 } },
      },
    });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const history = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
    assert.deepEqual(history, ["win_screened", "win_confirmed"], why(env, id));
    const m = env.ledger.db
      .prepare("select distinct metric from measurement")
      .all()
      .map((r) => r.metric);
    assert.deepEqual(m, ["seconds"]);
  });

  test("a score the check works out from the output: measured as the check reports it", async () => {
    // The test kit's check reports the result it read as `value`: the same for both arms.
    const env = await setup({
      kitMetrics: { value: { unit: "", from: "check", field: "value" } },
      contract: { objective: { primary: { metric: "value", direction: "max", min_effect: 0.1 } } },
    });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const last = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id desc limit 1")
      .get(id) as { verdict: string };
    assert.equal(last.verdict, "neutral", why(env, id));
    const values = env.ledger.db
      .prepare("select distinct value from measurement where metric = 'value'")
      .all()
      .map((r) => Number(r.value));
    assert.deepEqual(values, [values[0]]);
    assert.ok((values[0] ?? 0) > 0);
  });

  test("a run driver from run.copy is copied into each run, and a win still promotes", async () => {
    const env = await setup({ runCopy: true });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "promoted", why(env, id));
    assert.equal(env.ledger.champions.current("js-1").attempt, id);
  });

  test("a project in a folder of its repository: the run starts from that folder, and a win there promotes", async () => {
    const env = await setup({ folder: "examples/sum" });
    const mirror = env.service.mirrorFor("proj");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", mirror, ...args], { encoding: "utf8" }).trim();
    const start = env.ledger.runs.get("js-1")?.seed_commit ?? "";
    assert.notEqual(start, env.seed, "the run starts from the folder, not the whole repository");
    // Only the folder's files, at the folder's own tree, with no history of the repository.
    assert.deepEqual(git("ls-tree", "-r", "--name-only", start).split("\n"), [
      "README.md",
      "src/kernel/work.mjs",
    ]);
    assert.equal(git("rev-parse", `${start}^{tree}`), git("rev-parse", `${env.seed}:examples/sum`));
    assert.doesNotMatch(git("cat-file", "-p", start), /^parent /m);
    assert.equal(env.ledger.champions.current("js-1").commit_sha, start);
    const created = env.ledger.eventsAfter(0, 1000).events.find((e) => e.kind === "run_created");
    assert.deepEqual((created?.body as { seed?: unknown } | undefined)?.seed, {
      repo: "proj",
      commit: start,
      folder: "examples/sum",
      source_commit: env.seed,
    });
    // A change from the folder's root is judged there, and promoted.
    const id = await env.submit(FAST_KERNEL, "drop the wasted wait");
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "promoted", why(env, id));
    const champion = env.ledger.champions.current("js-1");
    assert.equal(git("rev-parse", `${champion.commit_sha}^`), start);

    // Another rig makes the same starting commit from the same signed commit and folder.
    const share = { root: env.root, seed: env.seed, kitCommit: env.kitCommit };
    const other = makeJudgeEnv({ realRuns: true, folder: "examples/sum", rig: "rig-b", share });
    const out = await other.service.applyCommand(other.assign);
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    assert.equal(other.ledger.runs.get("js-1")?.seed_commit, start);
    // A folder the commit does not have is refused, and no run is made.
    const none = makeJudgeEnv({ realRuns: true, folder: "examples/none", rig: "rig-c", share });
    const refused = await none.service.applyCommand(none.assign);
    assert.match(
      JSON.stringify(refused),
      new RegExp(`commit ${env.seed} has no folder examples/none`),
    );
    assert.equal(none.ledger.runs.get("js-1"), undefined);
  });

  test("a wrong kernel is invalid and a crashing one is crash_candidate; the champion stays", async () => {
    const env = await setup();
    const wrong = await env.submit(WRONG_KERNEL, "return early");
    const crash = await env.submit(CRASH_KERNEL, "exit");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(wrong)?.verdict, "invalid");
    assert.equal(env.ledger.verdicts.current(crash)?.verdict, "crash_candidate");
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
  });

  test("a crash's reason keeps the end of a long error output, within its bound", async () => {
    const env = await setup();
    // Much more output than a reason keeps, with the error that matters at its end.
    const noisy = `import { writeSync } from "node:fs";
export function work() {
  writeSync(2, "warning: noise\\n".repeat(400) + "fatal: index 42 is out of range\\n");
  process.exit(3);
}
`;
    const id = await env.submit(noisy, "a crash with a long error output");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "crash_candidate", why(env, id));
    const { reasons } = env.ledger.db
      .prepare("select reasons from verdict where attempt = ? order by id desc limit 1")
      .get(id) as { reasons: string };
    assert.match(reasons, /^exit 3: warning: noise/);
    assert.match(reasons, /fatal: index 42 is out of range\n$/);
    assert.ok(reasons.length <= REASON_CHARS, `${reasons.length} characters`);
    assert.ok(reasons.length > 1000, "far more than the 400 characters it kept before");
    // Control gets the same reason with the verdict.
    const event = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "verdict" && e.subject === id)
      .at(-1);
    assert.equal((event?.body as { reasons?: string } | undefined)?.reasons, reasons);
  });

  test("a cell's own time limit ends a run that the kit's limit would allow", async () => {
    // small has a 2 s limit of its own; big keeps the kit's 30 s.
    const env = await setup({
      kitCells: {
        small: { params: { n: 20000000, work: 20000000 }, timeout_s: 2 },
        held: { n: 15000000, work: 15000000 },
        big: { n: 100000000, work: 100000000 },
      },
    });
    // Correct, but it idles 6 s: past small's own limit, well within the kit's.
    const slow = `export function work(n) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;
    const id = await env.submit(slow, "idle before the work");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "crash_candidate", why(env, id));
    const { reasons } = env.ledger.db
      .prepare("select reasons from verdict where attempt = ? order by id desc limit 1")
      .get(id) as { reasons: string };
    assert.match(reasons, /^killed: timeout/);
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
  });

  test("a change that does not build is invalid", async () => {
    const env = await setup();
    const id = await env.submit("export function work( {\n", "syntax error");
    await env.drain();
    // The build only copies files, so the syntax error surfaces when the run imports it.
    assert.ok(
      ["invalid", "crash_candidate"].includes(String(env.ledger.verdicts.current(id)?.verdict)),
    );
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
  });

  test("without an auto policy a confirmed win waits for approval", async () => {
    const env = await setup({ promotion: "owner_approval" });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "win_confirmed", why(env, id));
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_approval");
    const pending = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "promotion_pending");
    assert.equal(pending.length, 1);
  });

  test("a target that never becomes ready ends in crash_infra, retried once, then errored", async () => {
    const env = await setup();
    await env.drain(); // the baseline of the starting point, while the target is ready
    const judge = new Judge({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      driver: new CpuDriver("test", { load: () => Number.POSITIVE_INFINITY }),
      owner: "judge-test",
      promotion: "auto",
      readyRetries: 0,
      calibrationBlocks: 0,
    });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    for (let i = 0; i < 10 && (await judge.tick()); i++);
    const history = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
    assert.deepEqual(history, ["crash_infra", "crash_infra"]);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "errored");
  });

  test("a target never ready for the baseline: the job fails in the judge, is tried again at once, then the run waits, and nothing is in setup", async () => {
    const env = await setup({ neverReady: true });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const jobs = env.ledger.db
      .prepare("select kind, state from job order by id")
      .all()
      .map((r) => `${r.kind}:${r.state}`);
    // The baseline's try failed in the judge, its second try at once too, and the change's job
    // waits for a baseline: the next try comes after BASELINE_RETRY_MS.
    assert.deepEqual(jobs, ["evaluate:queued", "baseline:failed", "baseline:failed"]);
    assert.equal(env.ledger.latestEventBody("baseline_failed", "js-1"), undefined);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "queued");
    assert.equal(env.ledger.verdicts.current(id), undefined);
  });

  test("a win screened against a champion that has since moved is screened again", async () => {
    const env = await setup();
    const a = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    const b = await env.submit(`${FAST_KERNEL}// same idea, restated\n`, "the same, restated");
    assert.ok(await env.judge.tick()); // the baseline of the starting point
    assert.ok(await env.judge.tick()); // screens a
    assert.equal(env.ledger.verdicts.current(a)?.verdict, "win_screened");
    // Meanwhile b becomes the champion by another path.
    env.ledger.verdicts.record({
      attempt: b,
      verdict: "win_confirmed",
      reasons: "t",
      judgedBy: "t",
    });
    const commit = String(env.ledger.attempts.get(b)?.commit_sha);
    assert.deepEqual(
      env.ledger.champions.promote({
        run: "js-1",
        expectedSeq: 1,
        attempt: b,
        commitSha: commit,
        by: "t",
      }),
      { ok: true, seq: 2 },
    );
    assert.ok(await env.judge.tick()); // a's confirm job: the champion moved
    assert.equal(String(env.ledger.attempts.get(a)?.lifecycle), "queued");
    const queued = env.ledger.db
      .prepare(
        "select count(*) as n from job where attempt = ? and kind = 'evaluate' and state = 'queued'",
      )
      .get(a);
    assert.equal(Number(queued?.n), 1);
  });

  test("goal mode: the seed is validated; an attempt that meets a new goal completes the campaign", async () => {
    const env = await setup({ goal: { opsPerSecond: 90e6 }, promotion: "auto" });
    await env.drain(); // validates the seed
    const status = () =>
      Object.fromEntries(
        env.ledger.db
          .prepare("select id, status from goal where run = 'js-1'")
          .all()
          .map((g) => [g.id, g.status]),
      );
    assert.deepEqual(status(), { correct: "verified", fast: "unmet", readable: "not_runnable" });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(
      env.ledger.verdicts.current(id)?.verdict,
      "goal_progress",
      JSON.stringify(
        env.ledger.db.prepare("select goal, attempt, result, detail from goal_check").all(),
      ),
    );
    assert.equal(env.ledger.champions.current("js-1").seq, 2);
    assert.equal(status().fast, "verified");
    assert.equal(env.ledger.runs.get("js-1")?.status, "closed");
    const report = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "goal_complete");
    assert.equal(report.length, 1);
    // Screened, then confirmed in fresh runs; completion needed two agreeing validations.
    const verdicts = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((v) => v.verdict);
    assert.deepEqual(verdicts, ["goal_screened", "goal_progress"]);
    const complete = env.ledger.db
      .prepare(
        "select count(*) as n from job where kind = 'validate' and state = 'done' and json_extract(result, '$.complete') = 1",
      )
      .get();
    assert.equal(Number(complete?.n), 2);
  });

  test("goal mode: priority gates skip a goal whose gate did not pass", async () => {
    const env = await setup({
      goal: { opsPerSecond: 90e6 },
      promotion: "auto",
      kitVerifiers: {
        correctness: { cells: ["small"], priority: 1 },
        heavy: { cells: ["big"], priority: 2, requires: ["correctness"] },
      },
      contract: {
        // The gated goal comes first in the contract: priority, not order, decides what runs first.
        goals: [
          // Unmet by the seed, so the campaign stays open for the attempt below.
          {
            id: "fast",
            description: "fast enough",
            verify: {
              type: "metric_threshold",
              metric: "ops_per_s",
              op: ">=",
              value: 90e6,
              cells: ["big"],
            },
          },
          {
            id: "heavy-goal",
            description: "the big case",
            verify: { type: "code", verifier: "heavy" },
          },
          {
            id: "correct",
            description: "still correct",
            verify: { type: "code", verifier: "correctness" },
          },
        ],
      },
    });
    await env.drain(); // validates the seed: correct, so both gates open
    const checks = (attempt: string | null) =>
      env.ledger.db
        .prepare(
          `select goal, result, detail from goal_check where ${attempt ? "attempt = ?" : "attempt is null"} order by id`,
        )
        .all(...(attempt ? [attempt] : [])) as { goal: string; result: string; detail: string }[];
    const seed = checks(null);
    assert.ok(
      seed.some((c) => c.goal === "heavy-goal" && c.result === "met"),
      JSON.stringify(seed),
    );
    // A wrong kernel fails the gate, so the heavy goal is not run at all.
    const wrong = await env.submit(WRONG_KERNEL, "return early");
    await env.drain();
    const got = checks(wrong);
    const heavy = got.find((c) => c.goal === "heavy-goal");
    assert.ok(heavy, env.explain(wrong));
    assert.match(String(heavy?.detail), /not run: it requires correctness, which did not pass/);
    assert.ok(
      got.some((c) => c.goal === "correct" && c.result !== "met"),
      JSON.stringify(got),
    );
  });

  test("goal mode: a failed validation is tried again, a few times, spaced out", async () => {
    const env = await setup({ goal: { opsPerSecond: 90e6 }, promotion: "auto" });
    // A validation that failed for an infrastructure reason.
    const jobId = env.ledger.jobs.enqueue({
      kind: "validate",
      spec: { run: "js-1", champion_seq: 1 },
      actor: "t",
    });
    env.ledger.db.prepare("update job set state = 'failed', result = '{}' where id = ?").run(jobId);
    const queued = () =>
      Number(
        env.ledger.db
          .prepare("select count(*) as n from job where kind = 'validate' and state = 'queued'")
          .get()?.n,
      );
    env.judge.tick = env.judge.tick.bind(env.judge);
    // Too soon after the failure: nothing new.
    (env.judge as unknown as { maybeScheduleValidation(): void }).maybeScheduleValidation();
    assert.equal(queued(), 0);
    env.ledger.db
      .prepare("update job set updated_at = ? where id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), jobId);
    (env.judge as unknown as { maybeScheduleValidation(): void }).maybeScheduleValidation();
    assert.equal(queued(), 1);
  });

  test("held-out results stay out of measurements and exports; only the owner's event names a held-out case", async () => {
    const env = await setup({ heldOut: true });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "win_confirmed", why(env, id));
    const rows = env.ledger.db.prepare("select count(*) as n from held_out").get();
    assert.equal(Number(rows?.n), 1);
    // The held-out case is named only in the owner's held_out_checked event (goal 082).
    const naming = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => JSON.stringify(e.body).includes('"held"'))
      .map((e) => e.kind);
    assert.deepEqual(naming, ["held_out_checked"]);
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from measurement where cell = 'held'").get()?.n,
      0,
    );
    const exp = await env.service.export("test");
    const { DatabaseSync } = await import("node:sqlite");
    const snap = new DatabaseSync(`${exp.dir}/ledger.sqlite`);
    const tables = snap
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((r) => r.name);
    snap.close();
    assert.ok(!tables.includes("held_out"));
    // The owner's record of it does go into the export, as it reaches control (goal 082).
    const { readFileSync } = await import("node:fs");
    const exported = readFileSync(`${exp.dir}/events.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; body: { cells?: { cell: string }[] } });
    assert.deepEqual(
      exported.filter((e) => e.kind === "held_out_checked").map((e) => e.body.cells?.[0]?.cell),
      ["held"],
    );
  });
});

describe("failure reasons", () => {
  test("a long reason keeps its start and its end, within the bound", () => {
    assert.equal(clipReason("short"), "short");
    const exact = "x".repeat(REASON_CHARS);
    assert.equal(clipReason(exact), exact);
    const long = `exit 1: ${"a".repeat(5000)}${"b".repeat(5000)}the error`;
    const cut = clipReason(long);
    assert.equal(cut.length, REASON_CHARS);
    assert.ok(cut.startsWith("exit 1: aaa"));
    assert.ok(cut.endsWith("bbbthe error"));
    assert.match(cut, / … /);
    assert.equal(clipReason(long, 100).length, 100);
  });
});

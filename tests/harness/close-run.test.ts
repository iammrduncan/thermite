import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type CommandKind, signEnvelope } from "../../src/core/commands.ts";
import { parseContract } from "../../src/core/contract.ts";
import { Scheduler } from "../../src/harness/agents/scheduler/index.ts";
import { Audits } from "../../src/harness/audits.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import type { Finish, JudgeContext } from "../../src/harness/judge/context.ts";
import { promotion } from "../../src/harness/judge/jobs/confirm.ts";
import { Research } from "../../src/harness/research/research/index.ts";
import { startFakeModel } from "../helpers/fake-model.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

/**
 * The owner closes a run by hand (goal 087): close_run ends it for good, as goal completion does,
 * with the owner's reason. Its trials stop as for a pause, nothing new starts, its jobs waiting
 * for the judge are cancelled (their changes not judged), it can't be paused or resumed again,
 * and its records and export stay.
 */

type Applied = { status: string; accepted?: boolean; result?: unknown; reason?: string };

/** A trial that runs until it is stopped. */
const heldTrial = (_spec: unknown, signal: AbortSignal) =>
  new Promise<{ stopped: "error"; turns: 0; toolCalls: 0; tokensIn: 0; tokensOut: 0 }>(
    (resolve) => {
      signal.addEventListener("abort", () =>
        resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
      );
    },
  );

const count = (env: { ledger: { db: { prepare(s: string): { get(): unknown } } } }, sql: string) =>
  Number((env.ledger.db.prepare(sql).get() as { n: number }).n);

describe("close_run (goal 087)", () => {
  test("the owner closes a running run: its trial stops, nothing new starts, its judge jobs never run, and it stays closed", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    // With its baseline (goal 115): the run's rounds wait for it.
    await env.start();
    // A change waiting for the judge when the run closes.
    const sub = (await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "less work",
        known_flaws: [],
      },
      "proposer",
    )) as { attempt: string };
    const fake = await startFakeModel(() => ({
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            assignments: [{ lane: "lane-1", family: "loops", focus: "f", parent: "champion" }],
            new_families: [{ id: "loops", description: "d" }],
          },
        },
      ],
    }));
    const s = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 200 },
      owner: "s",
      runTrial: heldTrial,
    });
    await s.tick();
    assert.equal(count(env, "select count(*) as n from trial where ended_at is null"), 1);
    const apply = (
      kind: "close_run" | "resume_run" | "pause_run",
      payload: unknown,
      by = "owner",
    ) =>
      env.service.applyCommand(
        signEnvelope(
          {
            v: 1,
            id: randomUUID(),
            rig: "rig-a",
            kind,
            issued_by: by,
            issued_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload,
          },
          env.keys.privateKeyPem,
        ),
      ) as Promise<Applied>;
    const why = "another run finished the work";

    // Only the owner closes a run.
    const byAgent = await apply("close_run", { run: "js-1", reason: why }, "agent:mcp");
    assert.equal(byAgent.accepted, false);
    assert.match(
      JSON.stringify(byAgent.result),
      /close_run is the owner's to issue, not agent:mcp's/,
    );
    assert.equal(env.ledger.runs.get("js-1")?.status, "running");
    // A reason of spaces alone is no reason: the payload is refused before anything changes.
    const blank = await apply("close_run", { run: "js-1", reason: "   " });
    assert.equal(blank.status, "rejected");
    assert.match(String(blank.reason), /bad payload: reason/);

    const closed = await apply("close_run", { run: "js-1", reason: why }, "owner:ui");
    assert.equal(closed.accepted, true, JSON.stringify(closed));
    assert.deepEqual(closed.result, { run: "js-1", status: "closed", was: "running" });
    const run = env.ledger.runs.get("js-1");
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", why]);
    assert.deepEqual(env.ledger.latestEventBody("run_status", "js-1"), {
      status: "closed",
      reason: why,
    });
    const ev = env.ledger.db
      .prepare("select actor from event where kind = 'run_status' order by id desc limit 1")
      .get() as { actor: string };
    assert.equal(ev.actor, "control:owner:ui");

    // Its trial stops at once, as for a pause; no new round or trial starts.
    const t0 = Date.now();
    await s.idle();
    assert.ok(Date.now() - t0 < 5000, `the trial took ${Date.now() - t0} ms to stop`);
    assert.equal(env.ledger.db.prepare("select stopped from trial").get()?.stopped, "interrupted");
    assert.ok(
      env.ledger.db
        .prepare("select 1 from event where kind = 'trial_stopped' and subject = 'js-1'")
        .get(),
      "the trial's stop is recorded",
    );
    const epochs = count(env, "select count(*) as n from epoch");
    assert.equal(await s.tick(), false);
    assert.equal(count(env, "select count(*) as n from trial"), 1, "no new trial");
    assert.equal(count(env, "select count(*) as n from epoch"), epochs, "no new round");

    // Its job waiting for the judge is cancelled, so the rig counts nothing queued; the change
    // is not judged, and its attempt stays.
    assert.equal(await env.judge.tick(), false);
    assert.equal(
      env.ledger.db.prepare("select state from job where attempt = ?").get(sub.attempt)?.state,
      "cancelled",
    );
    assert.equal(count(env, "select count(*) as n from job where state = 'queued'"), 0);
    assert.equal(env.ledger.attempts.get(sub.attempt)?.lifecycle, "not_judged");
    assert.equal(
      env.ledger.latestEventBody("attempt_lifecycle", sub.attempt)?.lifecycle,
      "not_judged",
    );
    assert.equal(env.ledger.verdicts.current(sub.attempt), undefined);
    assert.ok(env.ledger.attempts.get(sub.attempt), "the attempt stays");
    assert.equal(env.ledger.champions.current("js-1").seq, 1, "the champion stays");

    // It stays closed: no resume, no pause, no second close.
    const resumed = await apply("resume_run", { run: "js-1" });
    assert.equal(resumed.accepted, false);
    assert.deepEqual(resumed.result, { error: "run js-1 is closed" });
    const paused = await apply("pause_run", { run: "js-1", reason: "then resume it" });
    assert.equal(paused.accepted, false);
    assert.deepEqual(paused.result, { error: "run js-1 is closed" });
    const again = await apply("close_run", { run: "js-1", reason: "twice" });
    assert.equal(again.accepted, false);
    assert.deepEqual(again.result, {
      error: `run js-1 is already closed (${why}): there is nothing to close`,
    });
    assert.deepEqual(
      [env.ledger.runs.get("js-1")?.status, env.ledger.runs.get("js-1")?.pause_reason],
      ["closed", why],
    );
    const unknown = await apply("close_run", { run: "js-9", reason: why });
    assert.deepEqual(unknown.result, { error: "no run js-9" });

    // The export after it closes carries the end, and the run's attempt.
    const out = await env.service.export("test");
    const events = readFileSync(join(out.dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; subject: string; body: unknown });
    assert.ok(
      events.some(
        (e) =>
          e.kind === "run_status" &&
          e.subject === "js-1" &&
          JSON.stringify(e.body) === JSON.stringify({ reason: why, status: "closed" }),
      ),
      "the export has the run's close",
    );
    assert.ok(events.some((e) => e.kind === "attempt_recorded" && e.subject === sub.attempt));
    await fake.close();
  });

  test("a paused run closes too, and a job the judge had already taken ends without reopening it", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1 } });
    await env.service.applyCommand(env.assign);
    // A validation the judge took while the run was running, which would close it as complete.
    env.ledger.jobs.enqueue({ kind: "validate", priority: 1, spec: { run: "js-1" }, actor: "t" });
    const job = env.ledger.jobs.lease("judge-test", 60_000, ["validate"]);
    assert.ok(job);
    await env.service.applyCommand(env.sign("pause_run", { run: "js-1", reason: "seen enough" }));
    const closed = (await env.service.applyCommand(
      env.sign("close_run", { run: "js-1", reason: "done elsewhere" }),
    )) as Applied;
    assert.deepEqual(closed.result, { run: "js-1", status: "closed", was: "paused" });
    // The judge's finish of that job keeps the owner's reason.
    const judge = env.judge as unknown as {
      finish(j: unknown, fin: { result: unknown; close: { run: string; reason: string } }): void;
    };
    judge.finish(job, {
      result: {},
      close: { run: "js-1", reason: "every required goal is met" },
    });
    assert.deepEqual(
      [env.ledger.runs.get("js-1")?.status, env.ledger.runs.get("js-1")?.pause_reason],
      ["closed", "done elsewhere"],
    );
  });

  test("at start, a run closed before closes cancelled its jobs gets them cancelled; a paused run's, a running run's and a taken job stay", async () => {
    const env = makeJudgeEnv({});
    await env.service.applyCommand(env.assign);
    const sub = (await env.service.submitAttempt(
      { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
      "proposer",
    )) as { attempt: string };
    const validate = env.ledger.jobs.enqueue({
      kind: "validate",
      spec: { run: "js-1" },
      actor: "t",
    });
    const taken = env.ledger.jobs.enqueue({ kind: "validate", spec: { run: "js-1" }, actor: "t" });
    env.ledger.db
      .prepare("update job set state = 'leased', lease_owner = 'executor-0' where id = ?")
      .run(taken);
    // Closed as before this change: the status alone, its jobs left queued.
    env.ledger.db.prepare("update run set status = 'closed' where id = 'js-1'").run();
    const state = (id: number) =>
      String(env.ledger.db.prepare("select state from job where id = ?").get(id)?.state);
    const attemptJob = Number(
      env.ledger.db.prepare("select id from job where attempt = ?").get(sub.attempt)?.id,
    );
    assert.equal(state(attemptJob), "queued");

    assert.deepEqual(
      env.ledger.jobs.endClosedRuns("controller-start").sort(),
      [attemptJob, validate].sort(),
    );
    assert.deepEqual(
      [state(attemptJob), state(validate), state(taken)],
      ["cancelled", "cancelled", "leased"],
    );
    assert.equal(env.ledger.attempts.get(sub.attempt)?.lifecycle, "not_judged");
    assert.deepEqual(env.ledger.jobs.endClosedRuns("controller-start"), [], "once is enough");

    // A paused or running run's jobs wait as before.
    for (const status of ["paused", "running"]) {
      env.ledger.db.prepare("update run set status = ? where id = 'js-1'").run(status);
      const j = env.ledger.jobs.enqueue({ kind: "validate", spec: { run: "js-1" }, actor: "t" });
      assert.deepEqual(env.ledger.jobs.endClosedRuns("controller-start"), []);
      assert.equal(state(j), "queued", status);
    }
  });

  test("a win the judge confirms after its run closed does not become the champion (the owner, 2026-10-22)", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const sub = (await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "less work",
        known_flaws: [],
      },
      "proposer",
    )) as { attempt: string };
    await env.service.applyCommand(
      env.sign("close_run", { run: "js-1", reason: "done elsewhere" }),
    );
    // The judge's job on it was under way when the run closed: its confirmation now ends.
    const judge = (env.judge as unknown as { judge: JudgeContext }).judge;
    const out = promotion(
      judge,
      { result: {}, verdict: { verdict: "win_confirmed", delta: 0.5 } } as unknown as Finish,
      sub.attempt,
      "js-1",
      1,
      env.ledger.attempts.get(sub.attempt) as Record<string, unknown>,
    );
    assert.equal(out.promote, undefined);
    assert.equal(out.lifecycle, "awaiting_approval");
    assert.deepEqual(out.result, { promoted: false, waiting: "run_closed" });
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
  });

  test("a closed run's waiting decisions are refused in words, and its held audit is no one's to decide (the owner, 2026-10-22)", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const submit = async (kernel: string, flaws: string[] = []) =>
      (
        (await env.service.submitAttempt(
          { run: "js-1", patch_base64: env.patch(kernel), hypothesis: "h", known_flaws: flaws },
          "proposer",
        )) as { attempt: string }
      ).attempt;
    // A confirmed win that waits for the owner, as the judge leaves one the run asks about.
    const waiting = await submit(FAST_KERNEL);
    env.ledger.attempts.setLifecycle(waiting, "awaiting_approval", "judge");
    env.ledger.appendEvent("judge", "promotion_pending", waiting, {
      run: "js-1",
      expected_seq: 1,
      commit: env.ledger.attempts.get(waiting)?.commit_sha,
      reason: "you asked to decide every change (promotion: owner approval)",
    });
    // A win held for an audit, as the judge holds one with declared flaws.
    const held = await submit(`${FAST_KERNEL}\n// another way\n`, ["only tested on small inputs"]);
    new Audits(env.ledger).request({
      attempt: held,
      job: 1,
      run: "js-1",
      trigger: "known_flaws",
      reason: "declared flaws",
      expectedSeq: 1,
      by: "judge",
    });
    env.ledger.attempts.setLifecycle(held, "awaiting_audit", "judge");
    // A review the panel passed, and a "not possible" proposal, each waiting for the owner.
    const at = new Date().toISOString();
    const review = Number(
      env.ledger.db
        .prepare(
          "insert into review (run, goal, attempt, commit_sha, package, requested_at, panel_result, panel_at) values ('js-1', 'readable', null, 'c0ffee', '{}', ?, 'review_passed', ?)",
        )
        .run(at, at).lastInsertRowid,
    );
    const proposal = Number(
      env.ledger.db
        .prepare(
          "insert into conclusion (run, kind, evidence, proposed_at) values ('js-1', 'not_possible', '{\"approaches\":[]}', ?)",
        )
        .run(at).lastInsertRowid,
    );
    assert.deepEqual(
      (await env.service.auditPackages()).map((p) => p.attempt),
      [held],
      "the auditor gets it while the run is open",
    );

    const closed = (await env.service.applyCommand(
      env.sign("close_run", { run: "js-1", reason: "another run finished the work" }),
    )) as Applied;
    assert.equal(closed.accepted, true, JSON.stringify(closed));

    // The owner's decisions on it are refused, in words, and change nothing.
    const refused = async (kind: CommandKind, payload: unknown, words: string) => {
      const r = (await env.service.applyCommand(env.sign(kind, payload))) as Applied;
      assert.equal(r.accepted, false, kind);
      assert.deepEqual(r.result, { error: `run js-1 is closed: ${words}` }, kind);
    };
    await refused(
      "approve_promotion",
      { run: "js-1", attempt: waiting },
      "none of its changes can become the champion",
    );
    await refused(
      "approve_promotion",
      { run: "js-1", attempt: held },
      "none of its changes can become the champion",
    );
    await refused(
      "decline_promotion",
      { run: "js-1", attempt: waiting },
      "its changes stay as they were when it closed",
    );
    await refused(
      "accept_review",
      { run: "js-1", review, accept: true },
      "its goals are not checked again",
    );
    await refused(
      "conclude",
      { run: "js-1", proposal, accept: false },
      "it can't end as not possible or go on",
    );
    assert.equal(String(env.ledger.attempts.get(waiting)?.lifecycle), "awaiting_approval");
    assert.equal(
      env.ledger.db.prepare("select owner_decision from review where id = ?").get(review)
        ?.owner_decision,
      null,
    );
    assert.equal(
      env.ledger.db.prepare("select decision from conclusion where id = ?").get(proposal)?.decision,
      null,
    );

    // The auditor gets no package of it, and its late answer is refused and not recorded.
    assert.deepEqual(await env.service.auditPackages(), []);
    await assert.rejects(
      env.service.decideAudit({
        attempt: held,
        decision: "clear",
        reasons: "fine",
        citations: [],
        auditor: "supervisor:a",
      }),
      /run js-1 is closed: none of its changes can become the champion/,
    );
    assert.equal(new Audits(env.ledger).get(held)?.decision, null);
    // A rig that says it has no auditor lets no held audit of it go on.
    assert.deepEqual(
      await env.service.setAdvisors({ auditor: false, review_panel: 0 }, "supervisor"),
      [],
    );
    assert.equal(String(env.ledger.attempts.get(held)?.lifecycle), "awaiting_audit");
    assert.equal(env.ledger.champions.current("js-1").seq, 1, "the champion stays");
  });

  test("a research run closed by the owner gets its final report once its trial ends", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({ ...researchFixture, lanes: { count: 1, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const s = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      research,
      runTrial: heldTrial,
      runResearchTrial: heldTrial,
    });
    const finals = () =>
      Number(
        (
          env.service.ledger.db
            .prepare("select count(*) as n from event where kind = 'research_final'")
            .get() as { n: number }
        ).n,
      );
    await s.tick();
    assert.equal(
      Number(
        (
          env.service.ledger.db
            .prepare("select count(*) as n from trial where ended_at is null")
            .get() as { n: number }
        ).n,
      ),
      1,
    );
    const closed = (await env.service.applyCommand(
      env.sign("close_run", { run: "r-1", reason: "the question is answered elsewhere" }),
    )) as Applied;
    assert.equal(closed.accepted, true, JSON.stringify(closed));
    // The trial stops at the scheduler's next check, each second. That check's timer does not
    // keep a process open, and nothing else in this harness does, so the test holds it open while
    // it waits (on Node.js 22 the wait was otherwise cancelled).
    const hold = setTimeout(() => {}, 5000);
    await s.idle();
    clearTimeout(hold);
    assert.equal(await s.tick(), false);
    assert.equal(finals(), 1, "its final report is written");
    const report = env.service.ledger.db
      .prepare("select body from report_version where kind = 'final'")
      .get() as { body: string };
    assert.match(report.body, /^# /);
    await s.tick();
    assert.equal(finals(), 1, "once");
    assert.equal(env.service.ledger.runs.get("r-1")?.status, "closed");
  });
});

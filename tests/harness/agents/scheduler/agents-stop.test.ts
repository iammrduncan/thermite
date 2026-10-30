import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { signEnvelope } from "../../../../src/core/commands.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/**
 * When the agents stop (goal 079): no credits, a failing model check, a rate limit and the owner's
 * end of its wait, calls that fail for half an hour, a local failure in a provider's words, and a
 * rig that drains.
 */
describe("agent scheduler: the agents stop", () => {
  /** A scheduler whose trials return `result`, counting the trials it starts (goal 079). */
  function provider(
    env: ReturnType<typeof makeJudgeEnv>,
    result: () => Awaited<
      ReturnType<NonNullable<ConstructorParameters<typeof Scheduler>[0]["runTrial"]>>
    >,
    more: Partial<ConstructorParameters<typeof Scheduler>[0]> = {},
  ) {
    const started = { n: 0 };
    const scheduler = new Scheduler({
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
      backoffBaseMs: 0,
      runTrial: async () => {
        started.n++;
        return result();
      },
      ...more,
    });
    const round = async () => {
      await scheduler.tick();
      await scheduler.idle();
      await new Promise((r) => setTimeout(r, 5));
    };
    const events = (kind: string) =>
      env.ledger.db
        .prepare("select body from event where kind = ? order by id")
        .all(kind)
        .map((e) => JSON.parse(String(e.body)) as Record<string, unknown>);
    return { scheduler, started, round, events };
  }

  test("a trial that finds no credits stops the run's agents until a model check passes (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 10 } });
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    let checks = 0;
    let checkPasses = false;
    env.service.rigChecks.model = {
      run: async () => {
        checks++;
        return checkPasses
          ? { ok: true, summary: "m answered with a tool call" }
          : { ok: false, summary: "m failed the check: 404 insufficient_credits_for_paid_model" };
      },
    };
    let credits = false;
    const { started, round, events } = provider(env, () =>
      credits
        ? { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 }
        : {
            stopped: "error",
            turns: 0,
            toolCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
            error: "404 insufficient_credits_for_paid_model",
            errorKind: "credits",
          },
    );
    await round();
    const first = started.n;
    assert.ok(first >= 1);
    const stop = events("agents_stopped");
    assert.equal(stop.length, 1);
    assert.equal(stop[0]?.kind, "credits");
    assert.match(String(stop[0]?.words), /insufficient_credits_for_paid_model/);
    // Stopped: no trial and no new plan, however many ticks; the model is not checked again
    // before its first pause (a minute).
    await round();
    await round();
    assert.equal(started.n, first, "no trial starts while the agents are stopped");
    assert.equal(checks, 0);
    // The owner resumes the run: the model is checked at once. It still fails: still stopped.
    env.ledger.appendEvent("control:owner", "run_status", run, { status: "running", reason: null });
    await round();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(checks, 1);
    await round();
    assert.equal(started.n, first, "a failing check keeps them stopped");
    assert.equal(events("agents_stopped").length, 1, "the stop is recorded once");
    // Credits added: the next check passes, the agents go on.
    credits = true;
    checkPasses = true;
    env.ledger.appendEvent("control:owner", "run_status", run, { status: "running", reason: null });
    await round();
    await new Promise((r) => setTimeout(r, 20));
    await round();
    assert.equal(events("agents_resumed").length, 1);
    assert.ok(started.n > first, "a passing check lets trials start again");
  });

  test("no trial starts while the workers' model check fails; a new route ends it (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    const { started, round, events } = provider(env, () => ({
      stopped: "no_submission",
      turns: 1,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
    }));
    // The route was set, and its check failed after it (as at 03:02:49 in the audit).
    env.ledger.appendEvent("supervisor", "model_route_set", null, {
      source: "control",
      model: "m",
    });
    env.ledger.appendEvent("harness", "rig_check_finished", null, {
      id: "chk-1",
      check: "model",
      ok: false,
      summary: "m failed the tool-call check: 404 insufficient_credits_for_paid_model",
    });
    await round();
    await round();
    assert.equal(started.n, 0, "no trial on a failing check");
    assert.equal(events("agents_stopped")[0]?.kind, "credits");
    // A check of another kind of failure stops them too, as "check".
    // The owner gives the rig another model: the stop ends at once.
    env.ledger.appendEvent("supervisor", "model_route_set", null, {
      source: "control",
      model: "m2",
    });
    await round();
    assert.ok(started.n >= 1, "a new route ends the stop");
    assert.equal(events("agents_resumed")[0]?.why, "the rig's model route changed");
  });

  test("a rate limit with a time makes the agents wait until then; a passing fault does not stop them (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    let error = "429 Rate limit reached. Please try again in 30s.";
    // The kind comes from the provider's call (Pi's worker, the model proxy), never the words.
    const { started, round, events } = provider(env, () => ({
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error,
      errorKind: "rate_limit",
    }));
    await round();
    assert.equal(started.n, 1);
    const wait = events("agents_wait_for_limit")[0];
    const ms = Date.parse(String(wait?.until)) - Date.now();
    assert.ok(ms > 25_000 && ms <= 30_000, `waits about 30 s (${ms})`);
    await round();
    assert.equal(started.n, 1, "no trial before the provider's time");
    // A provider's 5xx ends no run and stops no agents: the lane's own backoff alone.
    const env2 = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env2.start();
    error = "503 Service Unavailable";
    const two = provider(env2, () => ({
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error,
      errorKind: "server",
    }));
    for (let i = 0; i < 8; i++) await two.round();
    assert.ok(two.started.n >= 8, `trials go on (${two.started.n})`);
    assert.equal(two.events("agents_stopped").length, 0);
    assert.equal(two.events("agents_cooldown").length, 0, "no cooldown after failures in a row");
  });

  test("a wait a trial asks for lasts at most one of its run's trials, and holds only its own run", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    // A reset time a month away, as a program's words at the trial's end may give one.
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const result = () => ({
      stopped: "error" as const,
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error: "the usage window is full",
      errorKind: "rate_limit" as const,
      retryAfter: far,
    });
    // The run sets no trial length, nor does the rig: at most 24 hours, the longest a trial may be.
    const { started, round, events } = provider(env, result);
    await round();
    const day = Date.parse(String(events("agents_wait_for_limit")[0]?.until)) - Date.now();
    assert.ok(day > 23.9 * 3_600_000 && day <= 24 * 3_600_000, `about a day (${day} ms)`);
    await round();
    assert.equal(started.n, 1, "the run waits");
    // With the rig's trial length (30 minutes), at most that.
    const env2 = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env2.start();
    const two = provider(env2, result, { trialWallMs: 30 * 60_000 });
    await two.round();
    const half = Date.parse(String(two.events("agents_wait_for_limit")[0]?.until)) - Date.now();
    assert.ok(half > 29 * 60_000 && half <= 30 * 60_000, `about 30 minutes (${half} ms)`);
    // A hold of another run on the same rig leaves this one working.
    const env3 = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env3.start();
    env3.ledger.appendEvent("scheduler", "agents_wait_for_limit", `${run}-other`, {
      until: far,
      trial: "t-other",
      reason: "another run's limit",
    });
    const three = provider(env3, () => ({
      stopped: "no_submission",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
    }));
    await three.round();
    assert.equal(three.started.n, 1, "another run's hold does not hold this run");
  });

  test("the owner ends a run's wait now: its trials start again at once, and the end is recorded", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    let limited = true;
    const { started, round, events } = provider(env, () =>
      limited
        ? {
            stopped: "error" as const,
            turns: 0,
            toolCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
            error: "429 the usage window is full",
            errorKind: "rate_limit" as const,
            retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
          }
        : { stopped: "no_submission" as const, turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
    );
    await round();
    await round();
    assert.equal(started.n, 1, "the run waits for its provider");
    const until = String(events("agents_wait_for_limit")[0]?.until);
    // An agent's token may not end it; the operator's may, for the owner.
    const as = (issuedBy: string) =>
      env.service.applyCommand(
        signEnvelope(
          {
            v: 1,
            id: randomUUID(),
            rig: env.service.rig,
            kind: "end_wait",
            issued_by: issuedBy,
            issued_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload: { run },
          },
          env.keys.privateKeyPem,
        ),
      );
    const agent = await as("agent:mcp");
    assert.ok(agent.status === "applied" && !agent.accepted, JSON.stringify(agent));
    assert.equal(
      (agent.result as { error?: string }).error,
      "end_wait is the owner's to issue, not agent:mcp's",
    );
    limited = false;
    const out = await as("owner:operator");
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    assert.deepEqual(out.result, { run, ended: true, until });
    assert.deepEqual(events("agents_wait_ended"), [{ until }]);
    await round();
    assert.equal(started.n, 2, "a trial starts at once");
    // Nothing waits now: the same command ends nothing and records nothing.
    const again = await env.service.applyCommand(env.sign("end_wait", { run }));
    assert.ok(again.status === "applied" && again.accepted, JSON.stringify(again));
    assert.deepEqual(again.result, { run, ended: false });
    assert.equal(events("agents_wait_ended").length, 1);
  });

  test("model calls that fail for 30 minutes with no call that worked stop the run's agents as no credits does (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    let checks = 0;
    env.service.rigChecks.model = {
      run: async () => {
        checks++;
        return { ok: true, summary: "m answered with a tool call" };
      },
    };
    let failing = true;
    const { started, round, events } = provider(env, () =>
      failing
        ? {
            stopped: "error",
            turns: 3,
            toolCalls: 2,
            tokensIn: 900,
            tokensOut: 90,
            error: "no model call worked for 30 minutes (the provider failed for now): 503",
            errorKind: "server",
            failing: {
              since: new Date(Date.now() - 31 * 60_000).toISOString(),
              kind: "server",
              words: "503 Service Unavailable",
            },
          }
        : { stopped: "no_submission", turns: 1, toolCalls: 1, tokensIn: 10, tokensOut: 1 },
    );
    await round();
    assert.equal(started.n, 1);
    const stop = events("agents_stopped");
    assert.equal(stop.length, 1);
    assert.equal(stop[0]?.kind, "server");
    assert.equal(stop[0]?.words, "503 Service Unavailable");
    assert.equal(
      stop[0]?.said,
      "no model call worked for 30 minutes (the provider failed for now)",
    );
    // The trial never really tried its experiment: it goes back to the queue.
    assert.equal(events("experiment_returned").length, 1);
    await round();
    await round();
    assert.equal(started.n, 1, "no trial starts while the agents are stopped");
    // The owner resumes the run: the model is checked at once; it passes, and a fresh trial starts.
    failing = false;
    env.ledger.appendEvent("control:owner", "run_status", run, { status: "running", reason: null });
    await round();
    await new Promise((r) => setTimeout(r, 20));
    await round();
    assert.equal(checks, 1);
    assert.equal(events("agents_resumed").length, 1);
    assert.ok(started.n > 1, "a passing check lets trials start again");
  });

  test("model calls that keep failing over trials that end at their own time limit stop the agents once 30 minutes pass; a call that worked starts the count again (goal 079)", async () => {
    // Each trial ends at its own limit while its calls fail since `ago` before its end.
    const wall = (agoMs: number) => ({
      stopped: "wall" as const,
      turns: 2,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error: "the trial reached its 20-minute limit before a submission",
      failing: {
        since: new Date(Date.now() - agoMs).toISOString(),
        kind: "model" as const,
        words: "400 the provider refused the request",
      },
    });
    const almost = 30 * 60_000 - 300;
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    // Each result is made when its trial ends, so a slow round does not use up the 300 ms.
    const results = [() => wall(almost), () => wall(60_000)];
    const one = provider(env, () => (results.shift() ?? (() => wall(60_000)))());
    await one.round();
    assert.equal(one.events("agents_stopped").length, 0, "not yet 30 minutes");
    await new Promise((r) => setTimeout(r, 400));
    await one.round();
    assert.equal(one.started.n, 2);
    const stop = one.events("agents_stopped");
    assert.equal(stop.length, 1, "the run's calls have failed for 30 minutes over two trials");
    assert.equal(stop[0]?.kind, "model");
    // A trial between them whose calls worked: the run's count starts again.
    const env2 = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env2.start();
    const worked = {
      stopped: "no_submission" as const,
      turns: 4,
      toolCalls: 3,
      tokensIn: 500,
      tokensOut: 50,
    };
    const results2 = [wall(almost), worked, wall(60_000)];
    const two = provider(env2, () => results2.shift() ?? worked);
    await two.round();
    await two.round();
    await new Promise((r) => setTimeout(r, 400));
    await two.round();
    assert.equal(two.started.n, 3);
    assert.equal(two.events("agents_stopped").length, 0);
  });

  test("a local failure in a provider's words neither stops the agents nor makes them wait; its experiment was tried (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.start();
    const errors = [
      // The workspace could not be set up.
      "EACCES: permission denied, mkdir '/scratch/lanes/lane-1'",
      // Pi's worker process died: its stderr is not the provider's answer.
      "worker process gave no result (1): fetch failed: 429 Too Many Requests, try again in 30s",
      // A program that exited.
      "OpenCode exited 1: access denied to the network",
    ];
    const { started, round, events } = provider(env, () => ({
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error: errors.shift() ?? "the lane's memory limit was reached",
    }));
    for (let i = 0; i < 4; i++) await round();
    assert.ok(started.n >= 3, `trials go on (${started.n})`);
    assert.equal(events("agents_stopped").length, 0, "not a refused key");
    assert.equal(events("agents_wait_for_limit").length, 0, "not the provider's rate limit");
    assert.equal(events("experiment_returned").length, 0, "each experiment was tried");
    assert.ok(events("experiment_finished").length >= 3);
  });

  test("a draining rig starts no trial and no plan; shutdown stops trials and keeps their counters (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.start();
    let draining = true;
    let id = "";
    const scheduler = new Scheduler({
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
      draining: () => draining,
      runTrial: (spec, signal) =>
        new Promise((resolve) => {
          id = spec.trialId;
          // The worker reports its counters as it goes.
          env.service.trialReport(
            { id: spec.trialId, run: spec.run, lane: spec.lane },
            { progress: { turns: 7, tool_calls: 12, tokens_in: 9000, tokens_out: 800 } },
          );
          signal.addEventListener("abort", () =>
            resolve({ stopped: "interrupted", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          );
        }),
    });
    assert.equal(await scheduler.tick(), false);
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 0);
    draining = false;
    assert.ok(await scheduler.tick());
    assert.equal(scheduler.trialsRunning, 1);
    // Its workspace is ready and its worker at work.
    while (!id) await new Promise((r) => setTimeout(r, 10));
    await scheduler.shutdown("the harness is stopping");
    const t = env.ledger.db
      .prepare("select stopped, turns, tool_calls, tokens_in, tokens_out from trial where id = ?")
      .get(id);
    assert.deepEqual(
      [t?.stopped, t?.turns, t?.tool_calls, t?.tokens_in, t?.tokens_out],
      ["interrupted", 7, 12, 9000, 800],
    );
    assert.equal(await scheduler.tick(), false, "no new work after shutdown");
  });

  test("a drain that begins while the planner works: the round is recorded, and no trial starts (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 3 } });
    await env.start();
    // Not draining when the step starts; draining from the planner's call on.
    let asked = 0;
    const { scheduler, started } = provider(
      env,
      () => ({ stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
      { draining: () => ++asked > 1 },
    );
    assert.equal(await scheduler.tick(), false);
    await scheduler.idle();
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 1);
    assert.equal(started.n, 0, "no trial starts once the rig drains");
    assert.equal(env.ledger.db.prepare("select count(*) as n from trial").get()?.n, 0);
  });
});

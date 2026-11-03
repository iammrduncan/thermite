import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { signEnvelope } from "../../../../src/core/commands.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/** A rig with one lane whose trial runs until it is stopped, keeping the counters it reported. */
async function oneTrial() {
  const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
  await env.start();
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
    runTrial: (spec, signal) =>
      new Promise((resolve) => {
        env.service.trialReport(
          { id: spec.trialId, run: spec.run, lane: spec.lane },
          { progress: { turns: 7, tool_calls: 12, tokens_in: 9000, tokens_out: 800 } },
        );
        id = spec.trialId;
        signal.addEventListener("abort", () =>
          resolve({
            stopped: "interrupted",
            turns: 7,
            toolCalls: 12,
            tokensIn: 9000,
            tokensOut: 800,
          }),
        );
      }),
  });
  assert.ok(await scheduler.tick());
  while (!id) await new Promise((r) => setTimeout(r, 10));
  const trial = () =>
    env.ledger.db
      .prepare("select stopped, turns, tool_calls, ended_at from trial where id = ?")
      .get(id) as {
      stopped: string | null;
      turns: number;
      tool_calls: number;
      ended_at: string | null;
    };
  /** Until the trial ends: the scheduler's check every second doesn't keep the process alive. */
  const ended = async () => {
    for (let i = 0; i < 100 && !trial().ended_at; i++) await new Promise((r) => setTimeout(r, 50));
    await scheduler.idle();
  };
  return { env, scheduler, id, trial, ended };
}

const events = (env: ReturnType<typeof makeJudgeEnv>, kind: string) =>
  env.ledger.db
    .prepare("select actor, subject, body from event where kind = ? order by id")
    .all(kind)
    .map((r) => ({ actor: String(r.actor), subject: r.subject, ...JSON.parse(String(r.body)) }));

describe("stop_trial: the owner stops one trial (goal 136)", () => {
  test("the trial ends as interrupted with its counters, and its experiment goes back to the top of the queue", async () => {
    const { env, scheduler, id, trial, ended } = await oneTrial();
    const x = env.ledger.db.prepare("select id from experiment where trial = ?").get(id) as
      | { id: string }
      | undefined;
    const out = await env.service.applyCommand(
      env.sign("stop_trial", { run: "js-1", trial: id, reason: "it repeats a refused request" }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    assert.deepEqual(out.result, { run: "js-1", trial: id, lane: "lane-1", stopping: true });
    // The service tells the scheduler at once, and the trial's abort ends it.
    await ended();
    const t = trial();
    assert.deepEqual([t.stopped, t.turns, t.tool_calls], ["interrupted", 7, 12]);
    assert.deepEqual(
      events(env, "trial_stopped").map((e) => [e.actor, e.subject, e.lane, e.trial, e.reason]),
      [["control:owner", "js-1", "lane-1", id, "it repeats a refused request"]],
    );
    assert.ok(x, "the trial took an experiment");
    const back = env.ledger.db
      .prepare("select state, place from experiment where id = ?")
      .get(x.id) as { state: string; place: number | null };
    assert.deepEqual([back.state, back.place], ["queued", 0], "back at the top of the queue");
    await scheduler.shutdown("test over");
  });

  test("refused for a trial that ended, one of another run, and from a token that isn't the owner's", async () => {
    const { env, scheduler, id, trial, ended } = await oneTrial();
    const refused = async (payload: unknown, issuedBy = "owner") => {
      const out = await env.service.applyCommand(
        signEnvelope(
          {
            v: 1,
            id: randomUUID(),
            rig: env.service.rig,
            kind: "stop_trial",
            issued_by: issuedBy,
            issued_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload,
          },
          env.keys.privateKeyPem,
        ),
      );
      assert.ok(out.status === "applied" && !out.accepted, JSON.stringify(out));
      return String((out.result as { error?: unknown }).error);
    };
    assert.equal(
      await refused({ run: "js-1", trial: id }, "agent:mcp"),
      "stop_trial is the owner's to issue, not agent:mcp's",
    );
    assert.equal(await refused({ run: "other", trial: id }), `run other has no trial ${id}`);
    assert.equal(trial().ended_at, null, "none of them stopped it");
    // An operator acts for the owner: its stop is taken.
    const out = await env.service.applyCommand(
      signEnvelope(
        {
          v: 1,
          id: randomUUID(),
          rig: env.service.rig,
          kind: "stop_trial",
          issued_by: "owner:operator",
          issued_at: new Date(Date.now() - 1000).toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          payload: { run: "js-1", trial: id },
        },
        env.keys.privateKeyPem,
      ),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    await ended();
    assert.equal(trial().stopped, "interrupted");
    assert.equal(events(env, "trial_stopped")[0]?.reason, "stopped by control:owner:operator");
    assert.equal(await refused({ run: "js-1", trial: id }), `trial ${id} has ended already`);
    await scheduler.shutdown("test over");
  });
});

describe("stops and resets reach the scheduler at once (goal 125)", () => {
  const kinds = (env: ReturnType<typeof makeJudgeEnv>) =>
    env.ledger.db
      .prepare(
        "select kind from event where kind in ('trial_stop_asked', 'trial_stopped', 'workers_reset') order by id",
      )
      .all()
      .map((r) => String(r.kind));

  test("a stop is acted on as the command is applied, with no wait, and its ask is kept first", async () => {
    const { env, scheduler, id, trial, ended } = await oneTrial();
    const out = await env.service.applyCommand(env.sign("stop_trial", { run: "js-1", trial: id }));
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    // No poll in between: the trial's stop is recorded when the command's answer comes.
    assert.deepEqual(kinds(env), ["trial_stop_asked", "trial_stopped"]);
    await ended();
    assert.equal(trial().stopped, "interrupted");
    await scheduler.shutdown("test over");
  });

  test("a reset stops the run's trial as it is applied; its lane bests and round end at the next step", async () => {
    const { env, scheduler, trial, ended } = await oneTrial();
    const out = await env.service.applyCommand(env.sign("reset_workers", { run: "js-1" }));
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    await ended();
    assert.equal(trial().stopped, "interrupted", "stopped before any step");
    assert.equal(env.ledger.db.prepare("select ended_at from epoch").get()?.ended_at, null);
    await scheduler.tick();
    const reset = Number(
      env.ledger.db.prepare("select id from event where kind = 'workers_reset'").get()?.id,
    );
    assert.ok(env.ledger.db.prepare("select ended_at from epoch where n = 1").get()?.ended_at);
    assert.equal(env.ledger.trials.resetsApplied(), reset, "the ledger records it applied");
    assert.deepEqual(kinds(env), ["workers_reset"]);
    await scheduler.shutdown("test over");
  });

  test("after a restart, a stop and a reset recorded while no scheduler ran are acted on", async () => {
    const { env, id, trial } = await oneTrial();
    // The harness goes down with its trial open: nothing hears the commands applied now.
    env.service.agents = undefined;
    await env.service.applyCommand(
      env.sign("stop_trial", { run: "js-1", trial: id, reason: "it loops" }),
    );
    await env.service.applyCommand(env.sign("reset_workers", { run: "js-1" }));
    assert.equal(trial().ended_at, null);
    assert.deepEqual(kinds(env), ["trial_stop_asked", "workers_reset"]);
    const again = () =>
      new Scheduler({
        service: env.service,
        runner: new LocalRunner(env.paths.scratchDir),
        owner: "s",
        runTrial: () => new Promise(() => undefined),
      });
    const restarted = again();
    // The stop: recorded by whoever asked, with their reason, and the trial ends as interrupted.
    assert.deepEqual(
      events(env, "trial_stopped").map((e) => [e.actor, e.trial, e.reason]),
      [["control:owner", id, "it loops"]],
    );
    assert.equal(trial().stopped, "interrupted");
    // The reset: finished at its first step, once.
    await restarted.tick();
    assert.ok(env.ledger.db.prepare("select ended_at from epoch where n = 1").get()?.ended_at);
    const reset = Number(
      env.ledger.db.prepare("select id from event where kind = 'workers_reset'").get()?.id,
    );
    assert.equal(env.ledger.trials.resetsApplied(), reset);
    // Another restart finds nothing left to do: no second trial_stopped, the reset not again.
    const epochEnds = () =>
      Number(
        env.ledger.db.prepare("select count(*) as n from event where kind = 'epoch_ended'").get()
          ?.n,
      );
    const ends = epochEnds();
    const third = again();
    await third.tick();
    assert.equal(events(env, "trial_stopped").length, 1);
    assert.equal(epochEnds(), ends);
    await third.shutdown("test over");
  });
});

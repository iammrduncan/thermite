import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MCP_WAIT_MS, Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/** A kit that gives the workers two MCP servers, and the planner one of them. */
const USES = [
  { name: "gbrain", agents: ["workers", "planner"] },
  { name: "papers", agents: ["workers"] },
];

/** A server as the supervisor hands it to the harness (no call reaches it here). */
const held = (name: string) => ({
  name,
  url: "https://mcp.example.com/mcp",
  headers: {},
  revision: "r1",
  agents: ["workers", "planner"] as ("workers" | "planner")[],
});

/** A run whose kit names the servers, and a scheduler whose trials note what the rig held. */
async function setup(waitMs: number) {
  const env = makeJudgeEnv({
    kitMcpServers: USES,
    assign: { mcp_servers: USES },
    lanes: { count: 1, trials_per_epoch: 1 },
  });
  // With the judge's baseline of the starting point (goal 115), which the run's rounds wait for.
  const out = (await env.start()) as { accepted?: boolean };
  assert.equal(out.accepted, true);
  const started: { spec: TrialSpec; held: string[] }[] = [];
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: {
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      apiKey: "k",
      contextWindow: 0,
      maxTokens: 0,
    },
    owner: "mcp-wait-test",
    // The fixed rules give out the round: no planner call.
    plannerOn: () => false,
    mcpWaitMs: waitMs,
    runTrial: async (spec) => {
      started.push({ spec, held: env.service.mcp.info().servers.map((s) => s.name) });
      return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    },
  });
  const live = () =>
    env.service.live
      .since(0, 1000)
      .entries.filter((l) => l.run === "js-1" && l.source === "planner")
      .map((l) => l.text);
  const waits = () =>
    (
      env.ledger.db
        .prepare("select body from event where kind = 'mcp_servers_wait' and subject = 'js-1'")
        .all() as { body: string }[]
    ).map((r) => JSON.parse(r.body) as { waited_s: number; since?: string; missing: unknown[] });
  return { env, scheduler, started, live, waits };
}

describe("a run waits for the MCP servers its kit names before its first plan or trial (goal 068)", () => {
  test("no trial starts before control hands the servers over; then it starts with them", async () => {
    const { env, scheduler, started, live, waits } = await setup(60_000);
    // Control has handed the rig nothing yet: no round, no trial.
    assert.equal(await scheduler.tick(), false);
    assert.equal(await scheduler.tick(), false);
    assert.equal(started.length, 0);
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 0);
    assert.deepEqual(live(), [
      "waiting for the MCP servers gbrain, papers: control has not handed them to this rig yet. No plan or trial starts until they come, for up to 60 s.",
    ]);
    // The supervisor hands one over; control says why it can't give the other. The trial starts
    // with the one the rig holds, and History and Live say which is missing and why.
    env.service.mcp.set(
      [held("gbrain")],
      [{ name: "papers", why: "control can't sign in to it: its sign-in ended" }],
    );
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.spec.mcpServers, ["gbrain", "papers"]);
    assert.deepEqual(started[0]?.held, ["gbrain"]);
    const w = waits();
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]?.missing, [
      { name: "papers", why: "control can't sign in to it: its sign-in ended" },
    ]);
    assert.ok(w[0]?.since, "since when it waited, for a research run's clock");
    assert.match(
      String(live().find((t) => t.startsWith("the run goes on without"))),
      /^the run goes on without the MCP server papers \(control can't sign in to it: its sign-in ended\), after waiting \d+ s\. A later trial gets each one once the rig has it\.$/,
    );
  });

  test("all handed over: the run starts with them, and History says how long it waited", async () => {
    const { env, scheduler, started, live, waits } = await setup(60_000);
    assert.equal(await scheduler.tick(), false);
    env.service.mcp.set([held("gbrain"), held("papers")], []);
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    assert.deepEqual(started[0]?.held, ["gbrain", "papers"]);
    assert.deepEqual(waits()[0]?.missing, []);
    assert.equal(
      live().find((t) => t.startsWith("the run's MCP servers")),
      "the run's MCP servers reached this rig: its plans and trials start with their tools.",
    );
  });

  test("servers never handed over: the wait ends, and the run goes on without them, saying which", async () => {
    const { scheduler, started, live, waits } = await setup(200);
    assert.equal(await scheduler.tick(), false);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.held, []);
    assert.deepEqual(waits()[0]?.missing, [
      { name: "gbrain", why: "control has not given it to this rig yet" },
      { name: "papers", why: "control has not given it to this rig yet" },
    ]);
    assert.match(
      String(live().find((t) => t.startsWith("the run goes on without"))),
      /^the run goes on without the MCP servers gbrain \(control has not given it to this rig yet\); papers \(control has not given it to this rig yet\), after waiting \d+ s\./,
    );
    // Once over, the wait does not come back for the run's later rounds and trials.
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.tick();
    await scheduler.idle();
    assert.equal(waits().length, 1);
    assert.equal(live().filter((t) => t.startsWith("waiting for the MCP")).length, 1);
  });

  test("a run whose kit names no MCP server never waits; the bound is two minutes", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    let trials = 0;
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m",
        apiKey: "k",
        contextWindow: 0,
        maxTokens: 0,
      },
      owner: "mcp-wait-test",
      plannerOn: () => false,
      runTrial: async () => {
        trials++;
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    assert.equal(trials, 1);
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from event where kind = 'mcp_servers_wait'").get()
        ?.n,
      0,
    );
    assert.equal(MCP_WAIT_MS, 120_000);
  });
});

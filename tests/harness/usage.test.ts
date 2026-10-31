import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { callUsage } from "../../src/core/usage.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { routeOf } from "../../src/harness/usage.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const RUN = "smoke-1";
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
const TRIAL = "t-0123456789abcdef";

const call = (o: Partial<Parameters<typeof callUsage>[0]> = {}) =>
  callUsage({
    at: Date.parse("2026-10-21T10:00:00Z"),
    calls: 1,
    tokensIn: 1000,
    cachedIn: 400,
    tokensOut: 50,
    reasoning: null,
    firstTokenMs: 300,
    callMs: 2500,
    ...o,
  });

async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const api = createHarnessApi(env.service, { supervisor: "sup", proposer: "prop" });
  const token = randomBytes(16).toString("hex");
  const registry = new Registry(env.service.ledger);
  registry.startTrial({
    id: TRIAL,
    run: RUN,
    lane: "lane-1",
    epoch: 1,
    family: "f",
    parent: env.seedCommit,
    token,
  });
  const post = (path: string, body: unknown, bearer = `trial.${token}`) =>
    api.request(path, { method: "POST", headers: auth(bearer), body: JSON.stringify(body) });
  const events = () =>
    env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === "model_call");
  return { env, registry, post, events };
}

describe("model usage on the harness (goal 075)", () => {
  test("a Pi worker hands its records over with its trial's token; the harness names the run, the trial and the route", async () => {
    const s = await setup();
    s.env.service.usage.open(
      { id: TRIAL, run: RUN },
      routeOf(
        {
          baseUrl: "u",
          model: "qwen-test",
          apiKey: "k",
          contextWindow: 0,
          maxTokens: 0,
          provider: "lab",
        },
        "pi",
      ),
    );
    const r = await s.post("/v1/trial/usage", { calls: [call(), call({ cachedIn: null })] });
    assert.equal(r.status, 201, await r.clone().text());
    assert.deepEqual(await r.json(), { recorded: 2 });
    const [a, b] = s.events();
    assert.equal(a?.subject, RUN);
    assert.equal(a?.actor, "harness");
    assert.deepEqual(a?.body, {
      trial: TRIAL,
      round: null,
      agent: "workers",
      harness: "pi",
      provider: "lab",
      model: "qwen-test",
      ...call(),
    });
    assert.equal((b?.body as { cached_in?: unknown } | undefined)?.cached_in, null);
    // Nothing in the body names another run, trial or model.
    const forged = await s.post("/v1/trial/usage", {
      calls: [call()],
      run: "other",
    });
    assert.equal(forged.status, 400);
    // A record whose figures do not add up is refused whole.
    const bad = await s.post("/v1/trial/usage", { calls: [{ ...call(), uncached_in: 1 }] });
    assert.equal(bad.status, 400);
    assert.equal(s.events().length, 2);
  });

  test("a trial whose program reports its own usage hands none over; an ended trial's token stops working", async () => {
    const s = await setup();
    // Not opened: an OpenCode, Codex or Claude Code trial, whose output the harness reads.
    const refused = await s.post("/v1/trial/usage", { calls: [call()] });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /recorded by the harness/);
    s.env.service.usage.open(
      { id: TRIAL, run: RUN },
      { harness: "pi", provider: null, model: "m" },
    );
    s.registry.finishTrial(
      TRIAL,
      { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 1, tokensOut: 1 },
      "test",
    );
    const ended = await s.post("/v1/trial/usage", { calls: [call()] });
    assert.equal(ended.status, 409);
    assert.match(await ended.text(), /has ended/);
    assert.equal(s.events().length, 0);
  });

  test("the supervisor records its advisors' calls, by role and round; never a worker's or the planner's", async () => {
    const s = await setup();
    const body = {
      run: RUN,
      round: "audit a-1",
      agent: "auditor",
      harness: "claude-code",
      provider: "my-claude",
      model: "claude-opus-5-5",
      calls: [call({ calls: null, firstTokenMs: null })],
    };
    const r = await s.post("/v1/model-calls", body, "sup");
    assert.equal(r.status, 201, await r.clone().text());
    const [e] = s.events();
    assert.equal(e?.actor, "supervisor");
    const b = (e?.body ?? {}) as Record<string, unknown>;
    assert.deepEqual([b.agent, b.round, b.calls], ["auditor", "audit a-1", null]);
    assert.equal(
      (await s.post("/v1/model-calls", { ...body, agent: "workers" }, "sup")).status,
      400,
    );
    assert.equal((await s.post("/v1/model-calls", { ...body, run: "nope" }, "sup")).status, 404);
    // Only the supervisor's token: a trial's is refused.
    assert.equal((await s.post("/v1/model-calls", body)).status, 401);
    assert.equal(s.events().length, 1);
  });

  test("what the harness measures itself is recorded with the agent's context", async () => {
    const s = await setup();
    const record = s.env.service.usage.recorder(
      RUN,
      { round: "epoch 3", agent: "planner" },
      { harness: "codex", provider: null, model: "gpt-test" },
    );
    record(call({ calls: null, callMs: null, firstTokenMs: null }));
    const [e] = s.events();
    const b = e?.body as Record<string, unknown>;
    assert.deepEqual(
      [b.trial, b.round, b.agent, b.harness, b.provider, b.calls, b.call_ms],
      [null, "epoch 3", "planner", "codex", null, null, null],
    );
    // The ledger reads the events of one kind by an index (a run's many model calls).
    const index = s.env.service.ledger.db
      .prepare("select name from sqlite_master where type = 'index' and name = 'event_kind'")
      .get();
    assert.ok(index);
  });
});

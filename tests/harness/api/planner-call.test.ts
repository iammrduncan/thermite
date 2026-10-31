import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TrialConsole } from "../../../src/agents/cli/index.ts";
import { plannerCallId } from "../../../src/core/terminal-input.ts";
import { PiConsole } from "../../../src/harness/agents/pi-view/index.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import type { OwnCall } from "../../../src/harness/service/index.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * A planner's own process in Pi (goal 169) reaches a worker's session routes with its call's
 * credential, and gives its answer at its own route. Each route takes only what is the caller's:
 * a call's credential with no own process reaches none of them, a trial's token never answers for
 * a planner, and neither keeps the other's later turns.
 */

const RUN = "smoke-1";

async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  new Registry(env.service.ledger).startTrial({
    id: "t-0123456789abcdef",
    run: RUN,
    lane: "lane-1",
    epoch: 1,
    family: "f",
    parent: env.seedCommit,
    token: "tok-1",
  });
  const api = createHarnessApi(env.service, { supervisor: "s" });
  const call = async (method: string, path: string, bearer: string, body?: unknown) => {
    const r = await api.request(path, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, text: await r.text() };
  };
  const got: { live: unknown[]; answers: unknown[]; given: unknown[] } = {
    live: [],
    answers: [],
    given: [],
  };
  const own: OwnCall = {
    run: RUN,
    call: "epoch 2",
    live: (entries) => got.live.push(...entries),
    messages: {
      waiting: () => [{ id: 7, text: "spread wider" }],
      given: (ids, how) => got.given.push({ ids, how }),
    },
    answer: (a) => got.answers.push(a),
  };
  const caller = { run: RUN, kind: "planner" as const, source: "planner" };
  const id = plannerCallId(RUN, 2);
  return { env, call, got, own, caller, id };
}

const SECTIONS = [{ id: "owner", source: "owner", part: "message", text: "spread wider" }];

describe("a planner's own process on the harness's routes", () => {
  test("its credential reaches its session's routes and its answer; with no own process, none", async () => {
    const s = await setup();
    const auth = s.env.service.mintCallToken({ id: s.id, caller: s.caller, own: s.own });
    const bare = s.env.service.mintCallToken({ id: s.id, caller: s.caller });

    const live = { entries: [{ kind: "text", text: "reading the queue" }] };
    assert.equal((await s.call("POST", "/v1/trial/live", auth, live)).status, 200);
    assert.deepEqual(s.got.live, live.entries);
    const counters = await s.call("POST", "/v1/trial/live", auth, {
      entries: [],
      progress: { turns: 1, tool_calls: 0, tokens_in: 0, tokens_out: 0 },
    });
    assert.equal(counters.status, 409);
    assert.match(counters.text, /gives only its session's lines/);

    const waiting = await s.call("GET", "/v1/trial/messages", auth);
    assert.deepEqual(JSON.parse(waiting.text), { messages: [{ id: 7, text: "spread wider" }] });
    assert.equal((await s.call("POST", "/v1/trial/messages/read", auth, { ids: [7] })).status, 200);
    assert.deepEqual(s.got.given, [{ ids: [7], how: "next-call" }]);

    // Its later turns are a planner's, kept as its call's; a worker's are not its own to keep.
    const turn = { role: "planner", program: "pi", turn: 1, sections: SECTIONS };
    assert.equal((await s.call("POST", "/v1/trial/prompt", auth, turn)).status, 201);
    const kept = s.env.service.ledger.db
      .prepare("select role, call, lane, trial from prompt where turn = 1")
      .get();
    assert.deepEqual({ ...kept }, { role: "planner", call: "epoch 2", lane: null, trial: null });
    const asWorker = await s.call("POST", "/v1/trial/prompt", auth, { ...turn, role: "worker" });
    assert.equal(asWorker.status, 400);
    assert.match(asWorker.text, /a call keeps no worker's turns/);
    const asPlanner = await s.call("POST", "/v1/trial/prompt", "trial.tok-1", turn);
    assert.equal(asPlanner.status, 400);
    assert.match(asPlanner.text, /a trial keeps no planner's turns/);

    // No usage recorder and no place for compactions given: refused in words.
    const usage = await s.call("POST", "/v1/trial/usage", auth, {
      calls: [
        {
          calls: 1,
          at: new Date().toISOString(),
          tokens_in: 1,
          cached_in: null,
          uncached_in: null,
          tokens_out: 1,
          reasoning: null,
          first_token_ms: null,
          call_ms: null,
        },
      ],
    });
    assert.equal(usage.status, 409, usage.text);
    const snap = await s.call("POST", "/v1/trial/snapshot", auth, { number: 1, markdown: "x" });
    assert.equal(snap.status, 404);

    // Its answer: a plan's arguments, or a cause the harness knows.
    const plan = { assignments: [] };
    assert.equal((await s.call("POST", "/v1/planner/answer", auth, { plan })).status, 200);
    assert.equal(
      (await s.call("POST", "/v1/planner/answer", auth, { cause: "won", detail: "" })).status,
      400,
    );
    assert.equal((await s.call("POST", "/v1/planner/answer", auth, { plan: [1] })).status, 400);
    assert.deepEqual(s.got.answers, [{ plan }]);
    // A trial's token never answers for a planner.
    assert.equal((await s.call("POST", "/v1/planner/answer", "trial.tok-1", { plan })).status, 401);

    // A call's credential with no own process reaches none of these.
    for (const [method, path, body] of [
      ["POST", "/v1/trial/live", live],
      ["GET", "/v1/trial/messages", undefined],
      ["POST", "/v1/trial/prompt", turn],
      ["POST", "/v1/planner/answer", { plan }],
    ] as const)
      assert.equal((await s.call(method, path, bare, body)).status, 401, path);

    // Ended: its credential no longer works.
    s.env.service.endCall(auth);
    assert.equal((await s.call("POST", "/v1/trial/live", auth, live)).status, 401);
    assert.equal((await s.call("POST", "/v1/planner/answer", auth, { plan })).status, 401);
  });

  test("its Pi view's console routes find its call's Pi view, and only its own", async () => {
    const s = await setup();
    const auth = s.env.service.mintCallToken({ id: s.id, caller: s.caller, own: s.own });
    const next = () => s.call("POST", "/v1/trial/console/next", auth, { wait_ms: 0 });
    // No Pi view under its id yet.
    const none = await next();
    assert.equal(none.status, 409);
    assert.match(none.text, /has no Pi view/);
    const view = new PiConsole();
    s.env.service.consoles.setCall(
      s.id,
      { run: RUN, lane: "planner", source: "planner" },
      new TrialConsole(view),
      view,
    );
    assert.deepEqual(JSON.parse((await next()).text), { input: null });
    // The owner's words wait for the planner's process, which takes them over its route.
    const typed = view.ownerInput({ text: "look at the queue first" });
    const taken = JSON.parse((await next()).text) as { input: { id: string; call: unknown } };
    assert.deepEqual(taken.input.call, { kind: "steer", text: "look at the queue first" });
    // A trial's token reaches its own trial's Pi view, never the planner's.
    const trial = await s.call("POST", "/v1/trial/console/next", "trial.tok-1", { wait_ms: 0 });
    assert.equal(trial.status, 409);
    assert.equal(
      (
        await s.call("POST", "/v1/trial/console/done", auth, {
          id: taken.input.id,
          outcome: "typed",
        })
      ).status,
      200,
    );
    await typed;
    const [frame] = await s.env.service.consoles.screens([s.id]);
    assert.equal(frame?.pi_view, true, "Live draws it as a Pi view");
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { signEnvelope } from "../../../src/core/commands.ts";
import { advisorCallId } from "../../../src/core/terminal-input.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { AdvisorInputs } from "../../../src/harness/service/advisor-inputs.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * The advisors' terminals as the harness knows them (goal 169): the supervisor runs each advisor's
 * call in its terminal and says which run now; the owner's input to one is checked and recorded as
 * a trial's, then waits for the supervisor, which takes it over its own routes, types it and says
 * what became of it; the harness records that too, and a later outcome of one that was queued.
 */

/** A rig with run js-1, its API as the supervisor calls it, and the owner's input to a terminal. */
async function setup() {
  const env = makeJudgeEnv();
  await env.service.applyCommand(env.assign);
  const api = createHarnessApi(env.service, { supervisor: "s" });
  const call = async (method: string, path: string, body?: object) => {
    const r = await api.request(path, {
      method,
      headers: { authorization: "Bearer s", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const type = (trial: string, payload: Record<string, unknown>) =>
    env.service.applyCommand(
      signEnvelope(
        {
          v: 1,
          id: randomUUID(),
          rig: "rig-a",
          kind: "terminal_input",
          issued_by: "owner:ui",
          issued_at: new Date(Date.now() - 1000).toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          payload: { run: "js-1", trial, ...payload },
        },
        env.keys.privateKeyPem,
      ),
    );
  const records = () =>
    env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "terminal_input")
      .map((e) => e.body as Record<string, unknown>);
  return { env, call, type, records };
}

/** What a command's application gave: its result, or its refusal. */
const outcomeOf = (out: unknown): Record<string, unknown> =>
  (out as { result?: Record<string, unknown> }).result ?? (out as Record<string, unknown>);

describe("the advisors' terminals, as the harness knows them", () => {
  test("the supervisor's calls in their terminals: in the rig's report, and only an advisor's call's id", async () => {
    const s = await setup();
    const id = advisorCallId("auditor", "js-1", 1);
    const put = await s.call("PUT", "/v1/advisor-terminals", {
      calls: [
        { id, run: "js-1", role: "auditor" },
        { id: "planner-js-1-9", run: "js-1", role: "planner" },
      ],
    });
    assert.equal(put.status, 200);
    assert.deepEqual(s.env.service.work().terminals, [{ id, run: "js-1", role: "auditor" }]);
    // Its screens are the supervisor's: the harness has none.
    const [frame] = await s.env.service.consoles.screens([id]);
    assert.equal(frame?.state, "none");
    // Left out: ended.
    await s.call("PUT", "/v1/advisor-terminals", { calls: [] });
    assert.equal(s.env.service.work().terminals, undefined);
    const gone = await s.type(id, { text: "hello" });
    assert.match(String(outcomeOf(gone).error), /has no trial or call advisor-auditor-js-1-1/);
    // Only the supervisor's token reaches these routes.
    const r = await createHarnessApi(s.env.service, { supervisor: "s" }).request(
      "/v1/advisor-terminals/inputs",
      { headers: { authorization: "Bearer other" } },
    );
    assert.equal(r.status, 401);
  });

  test("the owner's input: recorded, taken by the supervisor, typed, and recorded with what became of it", async () => {
    const s = await setup();
    const id = advisorCallId("reviewer-2", "js-1", 4);
    await s.call("PUT", "/v1/advisor-terminals", {
      calls: [{ id, run: "js-1", role: "reviewer-2" }],
    });
    const typing = s.type(id, { text: "Read the claims first." });
    const { body } = await s.call("GET", "/v1/advisor-terminals/inputs?wait=5");
    const inputs = body.inputs as { id: string; call: string; text?: string; wait: string }[];
    assert.equal(inputs.length, 1);
    assert.deepEqual(
      { call: inputs[0]?.call, text: inputs[0]?.text, wait: inputs[0]?.wait },
      { call: id, text: "Read the claims first.", wait: "queue" },
    );
    // Each is handed over once.
    assert.deepEqual((await s.call("GET", "/v1/advisor-terminals/inputs?wait=0")).body, {
      inputs: [],
    });
    const told = await s.call("POST", "/v1/advisor-terminals/outcomes", {
      outcomes: [{ id: inputs[0]?.id, outcome: "typed" }],
    });
    assert.deepEqual(told.body, { taken: 1 });
    assert.deepEqual(outcomeOf(await typing), {
      run: "js-1",
      trial: id,
      lane: "reviewer-2",
      outcome: "typed",
    });
    assert.deepEqual(
      s.records().map((x) => [x.trial, x.lane, x.text, x.outcome]),
      [[id, "reviewer-2", "Read the claims first.", "typed"]],
    );
    const lines = s.env.service.live.since(0).entries.filter((e) => e.source === "supervisor");
    assert.ok(lines.some((e) => /the owner's input went into its terminal/.test(e.text)));
  });

  test("queued for the usage window's reset, then typed after it; refused by the supervisor, in words", async () => {
    const s = await setup();
    const id = advisorCallId("teacher-1", "js-1", 2);
    await s.call("PUT", "/v1/advisor-terminals", {
      calls: [{ id, run: "js-1", role: "teacher-1" }],
    });
    const queued = s.type(id, { keys: ["esc"] });
    const first = (await s.call("GET", "/v1/advisor-terminals/inputs?wait=5")).body.inputs as {
      id: string;
      keys?: string[];
    }[];
    assert.deepEqual(first[0]?.keys, ["esc"]);
    const until = "2026-10-31T13:00:00.000Z";
    await s.call("POST", "/v1/advisor-terminals/outcomes", {
      outcomes: [{ id: first[0]?.id, outcome: "queued", until }],
    });
    assert.equal(outcomeOf(await queued).outcome, "queued");
    await s.call("POST", "/v1/advisor-terminals/outcomes", {
      outcomes: [{ id: first[0]?.id, outcome: "typed_after_reset" }],
    });
    const refused = s.type(id, { text: "Stop." });
    const second = (await s.call("GET", "/v1/advisor-terminals/inputs?wait=5")).body.inputs as {
      id: string;
    }[];
    await s.call("POST", "/v1/advisor-terminals/outcomes", {
      outcomes: [{ id: second[0]?.id, outcome: "refused", why: "teacher-1 is being ended" }],
    });
    assert.match(String(outcomeOf(await refused).error), /teacher-1 is being ended/);
    assert.deepEqual(
      s.records().map((x) => [x.outcome, x.until ?? x.why ?? null]),
      [
        ["queued", until],
        ["typed_after_reset", null],
        ["refused", "not typed into advisor-teacher-1-js-1-2's terminal: teacher-1 is being ended"],
      ],
    );
  });

  test("an input the supervisor does not take in time is refused in words; a follow_up goes on to it", async () => {
    const inputs = new AdvisorInputs({ untakenMs: 50, unansweredMs: 50 });
    const later = () => undefined;
    await assert.rejects(
      inputs.forward("advisor-a-r-1", { text: "hi", wait: "queue" }, later),
      /did not take it: it may be restarting/,
    );
    const taken = inputs.forward("advisor-a-r-1", { text: "hi", wait: "now" }, later);
    const [one] = await inputs.take(1000);
    assert.equal(one?.wait, "now");
    await assert.rejects(taken, /did not say in 0 seconds whether it typed it/);
    assert.equal(inputs.outcome({ id: one?.id ?? "", outcome: "typed" }), false, "too late");
    // The supervisor decides: an advisor in Pi's view takes it, the other programs refuse it.
    void inputs
      .forward("advisor-a-r-1", { text: "later", wait: "queue", follow_up: true }, later)
      .catch(() => undefined);
    const [follow] = await inputs.take(1000);
    assert.equal(follow?.follow_up, true);
    assert.equal(follow?.text, "later");
  });
});

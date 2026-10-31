import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { TrialConsole } from "../../../src/agents/cli/index.ts";
import { type CommandKind, signEnvelope } from "../../../src/core/commands.ts";
import { plannerCallId, TERMINAL_INPUTS_PER_MINUTE } from "../../../src/core/terminal-input.ts";
import { PiConsole } from "../../../src/harness/agents/pi-view/index.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { LAST_SCREENS_KEPT } from "../../../src/harness/service/consoles.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * terminal_input (goal 169) as the harness applies it: the owner's alone, never an operator's, an
 * agent's or a reader's; refused, in words, for a trial that has ended, runs headless or has no
 * terminal; typed into the trial's console, or queued while its program waits for its usage
 * window, then typed after the reset, sent at once when the owner says, or dropped at the end; each
 * input recorded word for word with its outcome. And the screens the supervisor asks for: a running
 * trial's now, an ended one's last, kept in memory, the newest LAST_SCREENS_KEPT.
 */

/** A stand-in for the trial loop's terminal: what was typed, and a usage limit to show or not. */
function fakeTerminal() {
  const typed: { text?: string | undefined; keys?: readonly string[] | undefined }[] = [];
  const t = {
    typed,
    limit: undefined as { resetsAt?: string } | undefined,
    screenNow: { cols: 80, rows: 24, data: "\x1b[1mfake\x1b[0m screen" },
    last: undefined as { cols: number; rows: number; data: string } | undefined,
    ownerInput: async (i: { text?: string | undefined; keys?: readonly string[] | undefined }) => {
      typed.push(i);
    },
    limitShown: () => t.limit,
    screen: async () => t.screenNow,
    lastScreen: () => t.last,
  };
  return t;
}

let n = 0;
/** A rig with run js-1, a trial of lane-1 open in it, and a signer for any issuer. */
async function setup() {
  const env = makeJudgeEnv();
  await env.service.applyCommand(env.assign);
  const trial = `t-${String(++n).padStart(16, "0")}`;
  new Registry(env.ledger).startTrial({
    id: trial,
    run: "js-1",
    lane: "lane-1",
    epoch: 1,
    family: "f",
    parent: "p",
    token: `tok-${n}`,
  });
  const as = (issuedBy: string, kind: CommandKind, payload: unknown) =>
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: issuedBy,
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    );
  const type = async (payload: Record<string, unknown>, issuedBy = "owner:ui") =>
    env.service.applyCommand(as(issuedBy, "terminal_input", { run: "js-1", trial, ...payload }));
  const records = () =>
    env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "terminal_input")
      .map((e) => e.body as Record<string, unknown>);
  return { env, trial, token: `tok-${n}`, as, type, records };
}

const result = (
  out: Awaited<ReturnType<ReturnType<typeof makeJudgeEnv>["service"]["applyCommand"]>>,
) => (out.status === "applied" ? (out.result as Record<string, unknown>) : { status: out.status });

describe("terminal_input, as the harness applies it", () => {
  test("only the owner's: an operator's, an agent's, a reader's or control's own is refused, and nothing is typed", async () => {
    const s = await setup();
    const t = fakeTerminal();
    s.env.service.consoles.set(s.trial, new TrialConsole(t));
    for (const by of ["owner:operator", "agent:mcp", "reader:mcp", "control"]) {
      const out = await s.type({ text: "/compact" }, by);
      assert.equal(out.status, "applied", by);
      assert.equal(out.status === "applied" && out.accepted, false, by);
      assert.match(String(result(out).error), /owner/, by);
    }
    assert.equal(t.typed.length, 0);
    for (const by of ["owner", "owner:ui", "owner:api", "owner:mcp"]) {
      const out = await s.type({ text: `from ${by}` }, by);
      assert.equal(out.status === "applied" && out.accepted, true, by);
    }
    assert.deepEqual(
      t.typed.map((x) => x.text),
      ["from owner", "from owner:ui", "from owner:api", "from owner:mcp"],
    );
  });

  test("typed into the trial's console, recorded word for word with its outcome", async () => {
    const s = await setup();
    const t = fakeTerminal();
    s.env.service.consoles.set(s.trial, new TrialConsole(t));
    const text = "Look at the cache misses first.\n\tThen /compact.";
    const out = await s.type({ text });
    assert.equal(out.status === "applied" && out.accepted, true);
    assert.deepEqual(result(out), {
      run: "js-1",
      trial: s.trial,
      lane: "lane-1",
      outcome: "typed",
    });
    const keys = await s.type({ keys: ["down", "down", "enter"] });
    assert.equal(result(keys).outcome, "typed");
    assert.deepEqual(t.typed, [
      { text, keys: undefined },
      { text: undefined, keys: ["down", "down", "enter"] },
    ]);
    const r = s.records();
    assert.deepEqual(
      r.map((x) => [x.text ?? x.keys, x.outcome, x.wait, x.lane, x.trial]),
      [
        [text, "typed", "queue", "lane-1", s.trial],
        [["down", "down", "enter"], "typed", "queue", "lane-1", s.trial],
      ],
    );
    // The command itself is kept as it was signed, with its result.
    const row = s.env.ledger.db
      .prepare("select envelope, accepted, result from command where kind = 'terminal_input'")
      .get() as { envelope: string; accepted: number; result: string };
    assert.equal(JSON.parse(row.envelope).payload.text, text);
    assert.equal(JSON.parse(row.result).outcome, "typed");
  });

  test("refused, in words and on the record, for a trial that has ended, runs headless or has no terminal", async () => {
    const s = await setup();
    const none = await s.type({ text: "hello" });
    assert.match(
      String(result(none).error),
      /has no terminal to type into: its program has not started yet/,
    );
    s.env.service.consoles.set(s.trial, "headless");
    const headless = await s.type({ text: "hello" });
    assert.match(String(result(headless).error), /runs headless, with no terminal/);
    const other = await s.env.service.applyCommand(
      s.as("owner", "terminal_input", { run: "js-1", trial: "t-unknown", text: "hello" }),
    );
    assert.match(String(result(other).error), /has no trial or call t-unknown/);
    s.env.service.consoles.set(s.trial, new TrialConsole(fakeTerminal()));
    s.env.service.trialEnded(s.trial, true);
    new Registry(s.env.ledger).finishTrial(
      s.trial,
      { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 1, tokensOut: 1 },
      "test",
    );
    const ended = await s.type({ text: "hello" });
    assert.match(String(result(ended).error), /has ended: nothing more goes into its terminal/);
    assert.deepEqual(
      s.records().map((x) => x.outcome),
      ["refused", "refused", "refused"],
      "each refusal of a trial of the run is on the record, with its words",
    );
  });

  test("while the program waits for its usage window: queued for after the reset by default, typed at once when the owner says so, dropped at the trial's end", async () => {
    const s = await setup();
    const t = fakeTerminal();
    const c = new TrialConsole(t);
    s.env.service.consoles.set(s.trial, c);
    t.limit = { resetsAt: "2026-10-29T23:00:00.000Z" };
    const queued = await s.type({ text: "first" });
    assert.deepEqual(result(queued), {
      run: "js-1",
      trial: s.trial,
      lane: "lane-1",
      outcome: "queued",
      until: "2026-10-29T23:00:00.000Z",
    });
    await s.type({ text: "second" });
    const now = await s.type({ text: "at once", wait: "now" });
    assert.equal(result(now).outcome, "typed");
    assert.deepEqual(
      t.typed.map((x) => x.text),
      ["at once"],
    );
    // Its frame says it waits, and how many inputs wait.
    const [frame] = await s.env.service.consoles.screens([s.trial]);
    assert.deepEqual(
      { state: frame?.state, limit: frame?.limit, queued: frame?.queued },
      { state: "running", limit: { resets_at: "2026-10-29T23:00:00.000Z" }, queued: 2 },
    );
    // The log shows the program at work again: what waited goes in, in order.
    c.flush();
    assert.equal(c.queued, 2, "nothing goes in while the limit shows");
    t.limit = undefined;
    c.flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      t.typed.map((x) => x.text),
      ["at once", "first", "second"],
    );
    // Queued again, then the trial ends before the reset: dropped, with why.
    t.limit = {};
    await s.type({ text: "too late" });
    c.close("the trial ended before the program's usage window reset");
    assert.deepEqual(
      s.records().map((x) => [x.text, x.outcome, x.until ?? null]),
      [
        ["first", "queued", "2026-10-29T23:00:00.000Z"],
        ["second", "queued", "2026-10-29T23:00:00.000Z"],
        ["at once", "typed", null],
        ["first", "typed_after_reset", null],
        ["second", "typed_after_reset", null],
        ["too late", "queued", null],
        ["too late", "dropped", null],
      ],
    );
    assert.match(
      String(s.records().at(-1)?.why),
      /the trial ended before the program's usage window reset/,
    );
  });

  test("what waits for the reset goes in only once the reset has come: a turn begun before it, by an input sent now, does not take it", async () => {
    const s = await setup();
    const t = fakeTerminal();
    const c = new TrialConsole(t);
    s.env.service.consoles.set(s.trial, c);
    const reset = new Date(Date.now() + 400).toISOString();
    t.limit = { resetsAt: reset };
    assert.equal(result(await s.type({ text: "after the reset" })).outcome, "queued");
    assert.equal(result(await s.type({ text: "now", wait: "now" })).outcome, "typed");
    // The input sent now began a turn before the reset: the log shows no limit.
    t.limit = undefined;
    c.flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      t.typed.map((x) => x.text),
      ["now"],
    );
    // The reset has come, and the program is at work: it goes in.
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(reset) - Date.now()) + 20));
    c.flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      t.typed.map((x) => x.text),
      ["now", "after the reset"],
    );
    assert.deepEqual(
      s.records().map((x) => [x.text, x.outcome]),
      [
        ["after the reset", "queued"],
        ["now", "typed"],
        ["after the reset", "typed_after_reset"],
      ],
    );
  });

  test("a trial takes at most TERMINAL_INPUTS_PER_MINUTE inputs in a minute; more are refused in words", async () => {
    const s = await setup();
    const t = fakeTerminal();
    s.env.service.consoles.set(s.trial, new TrialConsole(t));
    for (let i = 0; i < TERMINAL_INPUTS_PER_MINUTE; i++) await s.type({ keys: ["down"] });
    const over = await s.type({ keys: ["down"] });
    assert.match(String(result(over).error), /took 30 inputs in the last minute/);
    assert.equal(t.typed.length, TERMINAL_INPUTS_PER_MINUTE);
  });

  test("the screens asked for: a running trial's now, an ended one's last kept in memory, the newest LAST_SCREENS_KEPT", async () => {
    const s = await setup();
    const t = fakeTerminal();
    s.env.service.consoles.set(s.trial, new TrialConsole(t));
    const [running, unknown] = await s.env.service.consoles.screens([s.trial, "t-nobody"]);
    assert.deepEqual(
      { state: running?.state, cols: running?.cols, rows: running?.rows, data: running?.data },
      { state: "running", cols: 80, rows: 24, data: "\x1b[1mfake\x1b[0m screen" },
    );
    assert.equal(unknown?.state, "none");
    assert.equal(unknown?.data, undefined);
    // Its end: the last screen stays, and no frame is ever an event.
    t.last = { cols: 80, rows: 24, data: "the last screen" };
    s.env.service.trialEnded(s.trial, true);
    const [ended] = await s.env.service.consoles.screens([s.trial]);
    assert.deepEqual([ended?.state, ended?.data], ["ended", "the last screen"]);
    const kinds = new Set(s.env.ledger.eventsAfter(0, 10_000).events.map((e) => e.kind));
    assert.ok(![...kinds].some((k) => /screen|frame/.test(k)), [...kinds].join(", "));
    // The newest LAST_SCREENS_KEPT ended trials keep theirs; the oldest goes first.
    for (let i = 0; i < LAST_SCREENS_KEPT; i++) {
      const id = `t-later-${i}`;
      const other = fakeTerminal();
      other.last = { cols: 80, rows: 24, data: `screen ${i}` };
      s.env.service.consoles.set(id, new TrialConsole(other));
      s.env.service.trialEnded(id, true);
    }
    const [gone, newest] = await s.env.service.consoles.screens([
      s.trial,
      `t-later-${LAST_SCREENS_KEPT - 1}`,
    ]);
    assert.equal(gone?.state, "none");
    assert.equal(newest?.data, `screen ${LAST_SCREENS_KEPT - 1}`);
  });

  test("a worker in Pi's Pi view: its worker takes each input over its trial's routes, and says what became of it", async () => {
    const s = await setup();
    const pi = new PiConsole();
    s.env.service.consoles.set(s.trial, new TrialConsole(pi), pi);
    const api = createHarnessApi(s.env.service, { supervisor: "s" });
    const post = async (path: string, body: object, token = s.token) => {
      const r = await api.request(path, {
        method: "POST",
        headers: { authorization: `Bearer trial.${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    // The worker, as worker-main's Pi view asks: the next input, then what became of it.
    const worker = async (outcome: "typed" | "refused", why?: string) => {
      const next = await post("/v1/trial/console/next", { wait_ms: 2_000 });
      assert.equal(next.status, 200);
      const input = next.body.input as { id: string; call: Record<string, unknown> };
      const done = await post("/v1/trial/console/done", { id: input.id, outcome, why });
      assert.equal(done.status, 200);
      return input.call;
    };
    const [out, call] = await Promise.all([
      s.type({ text: "then run the tests", follow_up: true }),
      worker("typed"),
    ]);
    assert.deepEqual(call, { kind: "follow_up", text: "then run the tests" });
    assert.equal(result(out).outcome, "typed");
    const [stopped, esc] = await Promise.all([
      s.type({ keys: ["esc"] }),
      worker("refused", "the agent has no reply under way to stop"),
    ]);
    assert.deepEqual(esc, { kind: "interrupt" });
    assert.match(String(result(stopped).error), /the agent has no reply under way to stop/);
    // One it makes no call for is refused here, and never reaches the worker.
    const model = await s.type({ text: "/model gpt-x" });
    assert.match(String(result(model).error), /not a command of the Pi view/);
    const skill = await s.type({ text: "/skill:profile" });
    assert.match(String(result(skill).error), /this run's kit carries no skills/);
    assert.deepEqual(
      s.records().map((x) => [x.text ?? x.keys, x.follow_up ?? null, x.outcome]),
      [
        ["then run the tests", true, "typed"],
        [["esc"], null, "refused"],
        ["/model gpt-x", null, "refused"],
        ["/skill:profile", null, "refused"],
      ],
    );
    const [frame] = await s.env.service.consoles.screens([s.trial]);
    assert.equal(frame?.pi_view, true, "Live shows the Pi view's console");
    // Its end: the routes keep the screen, then refuse; another trial's token reaches no view.
    assert.equal((await post("/v1/trial/console/end", {})).status, 200);
    assert.deepEqual((await post("/v1/trial/console/next", { wait_ms: 0 })).body, { input: null });
    new Registry(s.env.ledger).startTrial({
      id: "t-other-trial-01",
      run: "js-1",
      lane: "lane-2",
      epoch: 1,
      family: "f",
      parent: "p",
      token: "tok-other",
    });
    const other = await post("/v1/trial/console/next", { wait_ms: 0 }, "tok-other");
    assert.equal(other.status, 409);
    assert.match(String(other.body.error), /this trial or call has no Pi view/);
  });

  test("a planner's call in its own terminal: its console under planner-RUN-N, its lines on the planner's, its id in the rig's report, and nothing more once it ends", async () => {
    const s = await setup();
    const t = fakeTerminal();
    const id = plannerCallId("js-1", 3);
    s.env.service.consoles.setCall(
      id,
      { run: "js-1", lane: "planner", source: "planner" },
      new TrialConsole(t),
    );
    assert.deepEqual(s.env.service.work().terminals, [{ id, run: "js-1", role: "planner" }]);
    const out = await s.type({ trial: id, text: "Plan tiling first." });
    assert.deepEqual(result(out), { run: "js-1", trial: id, lane: "planner", outcome: "typed" });
    assert.deepEqual(t.typed, [{ text: "Plan tiling first.", keys: undefined }]);
    assert.deepEqual(
      s.records().map((x) => [x.trial, x.lane, x.outcome]),
      [[id, "planner", "typed"]],
    );
    const lines = s.env.service.live.since(0).entries.filter((e) => e.source === "planner");
    assert.ok(lines.some((e) => /the owner's input went into its terminal/.test(e.text)));
    // Another run's id of the same shape names nothing here.
    const other = await s.type({ trial: plannerCallId("js-2", 3), text: "hello" });
    assert.match(String(result(other).error), /has no trial or call planner-js-2-3/);
    // Its end: its last screen is kept, it leaves the report, and it takes no more input.
    t.last = { cols: 80, rows: 24, data: "the plan" };
    s.env.service.consoles.ended(id);
    assert.equal(s.env.service.work().terminals, undefined);
    const [frame] = await s.env.service.consoles.screens([id]);
    assert.equal(frame?.state, "ended");
    const late = await s.type({ trial: id, text: "one more" });
    assert.match(String(result(late).error), /has ended: nothing more goes into its terminal/);
    // The round's second try takes the same id: its console is open again.
    s.env.service.consoles.setCall(
      id,
      { run: "js-1", lane: "planner", source: "planner" },
      new TrialConsole(t),
    );
    assert.equal(result(await s.type({ trial: id, text: "again" })).outcome, "typed");
  });

  test("a planner's call's credential: the turn routes give it its own messages' offers, and it stops working when the call ends", async () => {
    const s = await setup();
    const id = plannerCallId("js-1", 4);
    const caller = { run: "js-1", kind: "planner" as const, source: "planner" };
    const auth = s.env.service.mintCallToken({ id, caller });
    assert.match(auth, /^call\.[0-9a-f]{48}$/);
    const offered: string[] = [];
    s.env.service.inTurn(id, {
      offer: (at) => {
        offered.push(at);
        return { offer: "o-1", text: "the owner's words" };
      },
      taken: (offer) => (offer === "o-1" ? [12] : []),
    });
    const api = createHarnessApi(s.env.service, { supervisor: "s" });
    const post = async (path: string, body: object, bearer: string) => {
      const r = await api.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const offer = await post("/v1/trial/turn/offer", { at: "after-tool" }, auth);
    assert.deepEqual(offer, { status: 200, body: { offer: "o-1", text: "the owner's words" } });
    assert.deepEqual(offered, ["after-tool"]);
    const taken = await post("/v1/trial/turn/taken", { offer: "o-1" }, auth);
    assert.deepEqual(taken.body, { messages: [12] });
    // The MCP gateway takes it as the planner's own credential.
    assert.deepEqual(s.env.service.callOf(auth)?.caller, caller);
    s.env.service.endCall(auth);
    assert.equal((await post("/v1/trial/turn/offer", { at: "turn-end" }, auth)).status, 401);
    assert.equal((await post("/v1/trial/turn/offer", { at: "turn-end" }, "call.0")).status, 401);
    const r = await api.request("/v1/mcp-tools", { headers: { authorization: `Bearer ${auth}` } });
    assert.equal(r.status, 401);
  });
});

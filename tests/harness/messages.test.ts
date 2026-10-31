import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { type CommandKind, signEnvelope } from "../../src/core/commands.ts";
import { parseContract } from "../../src/core/contract.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { LEDGER_MIGRATIONS } from "../../src/harness/ledger/migrations.ts";
import { MIGRATIONS } from "../../src/harness/schema/index.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

type Env = ReturnType<typeof makeJudgeEnv>;

/** A command as control signs it, from the owner unless another issuer is named. */
async function command(env: Env, kind: CommandKind, payload: unknown, issuer = "owner") {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: issuer,
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.equal(out.status, "applied", JSON.stringify(out));
  return out as { accepted: boolean; result: Record<string, unknown> };
}

const send = (env: Env, payload: Record<string, unknown>) =>
  command(env, "message_agent", { run: "js-1", ...payload });

const events = (env: Env, kind: string) =>
  env.ledger
    .eventsAfter(0, 5000)
    .events.filter((e) => e.kind === kind)
    .map((e) => e.body as Record<string, unknown>);

const lines = (env: Env) => env.service.live.since(0, 5000).entries;

const trial = (id: string, lane: string) => ({
  id: `t-${id.repeat(16).slice(0, 16)}`,
  run: "js-1",
  lane,
});

describe("the owner's messages", () => {
  test("a run without agents takes no message for its lanes or planner; a lane rule counts the lanes everyone reaches", async () => {
    const tryEnv = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 }, agents: false });
    await tryEnv.service.applyCommand(tryEnv.assign);
    for (const to of ["all", "lane-1", "planner"]) {
      const out = await send(tryEnv, { to, text: "hello" });
      assert.equal(out.accepted, false, to);
      assert.match(String(out.result.error), /has no agents/);
    }
    const env = makeJudgeEnv({ lanes: { count: 3, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    await command(env, "redirect", {
      run: "js-1",
      directives: [{ kind: "lane_count", value: 2, rationale: "two lanes are enough" }],
    });
    const sent = await send(env, { to: "all", text: "two lanes now" });
    assert.deepEqual((sent.result as { readers: string[] }).readers, [
      "lane-1",
      "lane-2",
      "planner",
    ]);
    // A teacher's later rule of 3 lanes does not apply over the owner's 2, for the scheduler or
    // for the readers: the message never waits for a lane that never runs (goal 162).
    env.service.ledger.directives.add("js-1", "supervisor:teachers", {
      kind: "lane_count",
      value: 3,
      rationale: "more lanes",
    });
    const again = await send(env, { to: "all", text: "still two lanes" });
    assert.deepEqual((again.result as { readers: string[] }).readers, [
      "lane-1",
      "lane-2",
      "planner",
    ]);
  });

  test("everyone working reaches each lane once and the planner; a read is recorded only when given, and the first read by each reader is an event", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const sent = await send(env, { to: "all", text: "focus on the inner loop" });
    assert.ok(sent.accepted, JSON.stringify(sent.result));
    assert.deepEqual(sent.result, {
      message: 1,
      to: "all",
      keep: false,
      readers: ["lane-1", "lane-2", "planner"],
    });
    // The event carries the owner's text, so control can show it from events alone.
    assert.deepEqual(events(env, "agent_message"), [
      { id: 1, to: "all", keep: false, text: "focus on the inner loop", chars: 23 },
    ]);
    const a = env.service.trialInbox(trial("a", "lane-1"));
    assert.deepEqual(a.waiting(), [{ id: 1, text: "focus on the inner loop" }]);
    assert.equal(a.waiting().length, 1, "fetching it gives nothing: it still waits");
    assert.deepEqual(events(env, "agent_message_read"), []);
    a.given([1]);
    assert.deepEqual(a.waiting(), []);
    // Another trial of lane-1 has nothing more; lane-2 still has it.
    assert.deepEqual(env.service.trialInbox(trial("c", "lane-1")).waiting(), []);
    const b = env.service.trialInbox(trial("b", "lane-2"));
    assert.equal(b.waiting().length, 1);
    b.given([1, 1]);
    assert.deepEqual(
      env.service.messages.waitingForPlanner("js-1").map((m) => m.id),
      [1],
    );
    assert.deepEqual(env.service.takePlannerMessages("js-1"), ["focus on the inner loop"]);
    assert.deepEqual(env.service.takePlannerMessages("js-1"), []);
    assert.deepEqual(events(env, "agent_message_read"), [
      { message: 1, by: "lane-1", trial: trial("a", "lane-1").id },
      { message: 1, by: "lane-2", trial: trial("b", "lane-2").id },
      { message: 1, by: "planner" },
    ]);
    // The live view: the message as sent, and a line where each agent read it.
    const live = lines(env);
    assert.ok(
      live.some(
        (e) => e.kind === "message" && e.text === "Owner to all (#1): focus on the inner loop",
      ),
    );
    for (const source of [
      `trial:${trial("a", "lane-1").id}`,
      `trial:${trial("b", "lane-2").id}`,
      "planner",
    ])
      assert.ok(
        live.some(
          (e) =>
            e.source === source &&
            e.text === "read the owner's message #1: focus on the inner loop",
        ),
        source,
      );
    // A receipt counts only for a message waiting for that trial: never another lane's.
    await send(env, { to: "lane-2", text: "only for lane two" });
    env.service.trialInbox(trial("d", "lane-1")).given([2]);
    assert.equal(env.service.trialInbox(trial("e", "lane-2")).waiting().length, 1);
  });

  test("a message to a trial that ended goes to its lane's next trial, which is told so", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const registry = new Registry(env.ledger);
    const t1 = trial("a", "lane-1");
    registry.startTrial({ ...t1, epoch: 1, family: "f", parent: "p" });
    const sent = await send(env, { to: `trial:${t1.id}`, text: "check the bounds" });
    assert.deepEqual(sent.result.readers, ["lane-1"]);
    assert.equal(sent.result.note, undefined);
    // Still running: only that trial gets it.
    assert.equal(env.service.trialInbox(trial("b", "lane-1")).waiting().length, 0);
    assert.equal(env.service.trialInbox(t1).waiting()[0]?.text, "check the bounds");
    registry.finishTrial(
      t1.id,
      { stopped: "submitted", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "t",
    );
    const next = env.service.trialInbox(trial("b", "lane-1")).waiting();
    assert.equal(next.length, 1);
    assert.match(
      String(next[0]?.text),
      /^check the bounds\n\n\(The owner sent this to trial t-a+, an earlier trial of your lane, which ended before it read it\.\)$/,
    );
    assert.equal(env.service.trialInbox(trial("c", "lane-2")).waiting().length, 0);
    // Sent after it ended: accepted, and the result says where it goes.
    const late = await send(env, { to: `trial:${t1.id}`, text: "too late" });
    assert.match(String(late.result.note), /has ended; lane-1's next trial reads this/);
    // An unknown trial is refused.
    const unknown = await send(env, { to: "trial:t-ffffffffffffffff", text: "x" });
    assert.equal(unknown.accepted, false);
    assert.match(String(unknown.result.error), /no trial t-ffffffffffffffff in run js-1/);
  });

  test("kept in force: in every new trial's brief until the owner removes it; removing it is an event, and only the owner's", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const m = env.service.messages;
    await send(env, { to: "lane-1", text: "never edit the timer", keep: true });
    await send(env, { to: "all", text: "keep changes small", keep: true });
    await send(env, { to: "lane-1", text: "once only" });
    assert.deepEqual(
      m.inForce("js-1", "lane-1").map((x) => x.id),
      [1, 2],
    );
    assert.deepEqual(
      m.inForce("js-1", "lane-2").map((x) => x.id),
      [2],
    );
    // A planner message cannot be kept: the harness refuses the payload.
    const bad = await env.service.applyCommand(
      signEnvelope(
        {
          v: 1,
          id: randomUUID(),
          rig: "rig-a",
          kind: "message_agent",
          issued_by: "owner",
          issued_at: new Date(Date.now() - 1000).toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          payload: { run: "js-1", to: "planner", text: "x", keep: true },
        },
        env.keys.privateKeyPem,
      ),
    );
    assert.equal(bad.status, "rejected");
    // Only the owner removes one.
    const agent = await command(env, "unkeep_message", { run: "js-1", message: 1 }, "agent:ops");
    assert.equal(agent.accepted, false);
    assert.match(String(agent.result.error), /owner's to issue/);
    const out = await command(env, "unkeep_message", { run: "js-1", message: 1 });
    assert.ok(out.accepted, JSON.stringify(out.result));
    assert.deepEqual(events(env, "agent_message_unkept"), [{ message: 1 }]);
    assert.deepEqual(
      m.inForce("js-1", "lane-1").map((x) => x.id),
      [2],
    );
    // Removed before lane-1 read it: no longer given to anyone.
    assert.deepEqual(
      env.service
        .trialInbox(trial("a", "lane-1"))
        .waiting()
        .map((x) => x.id),
      [2, 3],
    );
    for (const [message, why] of [
      [1, /already removed from force/],
      [3, /is not kept in force/],
      [99, /no message 99 in run js-1/],
    ] as const) {
      const r = await command(env, "unkeep_message", { run: "js-1", message });
      assert.equal(r.accepted, false);
      assert.match(String(r.result.error), why);
    }
    assert.ok(lines(env).some((e) => e.text === "the owner's message #1 is no longer in force"));
  });

  test("a recipient that would never read the message is refused with the reason, so control shows it failed", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const refused = async (payload: Record<string, unknown>, why: RegExp) => {
      const r = await send(env, { text: "x", ...payload });
      assert.equal(r.accepted, false, JSON.stringify(payload));
      assert.match(String(r.result.error), why);
    };
    await refused({ to: "review_panel" }, /no goal the review panel reviews/);
    await refused({ to: "lane-3" }, /run js-1 has 2 lanes/);
    assert.deepEqual((await send(env, { to: "advisors", text: "x" })).result.readers, [
      "teachers",
      "auditor",
    ]);
    await command(env, "rig_settings", { teachers: false, planner: false });
    await refused({ to: "teachers" }, /the teachers are off on this rig/);
    await refused({ to: "planner" }, /the planner is off on this rig/);
    assert.deepEqual((await send(env, { to: "all", text: "x" })).result.readers, [
      "lane-1",
      "lane-2",
    ]);
    await command(env, "rig_settings", { auditor: false });
    await refused({ to: "auditor" }, /the auditor is off on this rig/);
    await refused({ to: "advisors" }, /none of the advisors would read this message/);
    env.ledger.runs.setStatus("js-1", "closed", "done", "test");
    await refused({ to: "lane-1" }, /run js-1 is closed/);
    // Nothing refused was recorded.
    assert.equal(events(env, "agent_message").length, 2);
  });

  test("a research run's planner reads (goals 047 and 117), it has no audits, its review panel reads (goal 112); everyone working reaches its lanes and its planner", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract(researchFixture);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    const msg = async (to: string) => {
      const out = await env.service.applyCommand(
        env.sign("message_agent", { run: "r-1", to, text: "x" }),
      );
      assert.equal(out.status, "applied");
      return out as { accepted: boolean; result: Record<string, unknown> };
    };
    const planner = await msg("planner");
    assert.equal(planner.accepted, true);
    assert.deepEqual(planner.result.readers, ["planner"]);
    assert.match(String((await msg("auditor")).result.error), /a research run has no audits/);
    assert.deepEqual((await msg("all")).result.readers, ["lane-1", "lane-2", "planner"]);
    // The review panel checks whether a research run's questions are answered (goal 112).
    assert.deepEqual((await msg("review_panel")).result.readers, ["review_panel"]);
    assert.deepEqual((await msg("advisors")).result.readers, ["teachers", "review_panel"]);
  });

  test("the advisors: the brief and the supervisor's route record reads and answers, only for messages to that role", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, { supervisor: "sup", proposer: "prop" });
    const call = (method: string, path: string, body?: unknown, token = "sup") =>
      api.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await send(env, { to: "teachers", text: "read the tiling paper" });
    await send(env, { to: "advisors", text: "be strict about timing" });
    await send(env, { to: "lane-1", text: "not for advisors" });
    const runs = (await (await call("GET", "/v1/runs")).json()) as {
      runs: { id: string; owner_messages_waiting: Record<string, number[]> }[];
    };
    assert.deepEqual(runs.runs[0]?.owner_messages_waiting, {
      teachers: [1, 2],
      auditor: [2],
      review_panel: [2],
    });
    const brief = async () =>
      (
        (await (await call("GET", "/v1/brief?run=js-1")).json()) as {
          owner_messages: { id: number; text: string; read: boolean }[];
        }
      ).owner_messages;
    assert.deepEqual(
      (await brief()).map((m) => [m.id, m.read]),
      [
        [1, false],
        [2, false],
      ],
    );
    const post = (body: unknown, token?: string) =>
      call("POST", "/v1/advisor-messages", body, token);
    assert.equal((await post({ run: "js-1", role: "teachers", read: [1] }, "prop")).status, 401);
    assert.equal(
      (await post({ run: "js-1", role: "auditor", read: [1] })).status,
      400,
      "message 1 is not the auditor's",
    );
    assert.equal((await post({ run: "js-1", role: "teachers", read: [3] })).status, 400);
    assert.equal((await post({ run: "js-1", role: "teachers", read: [42] })).status, 404);
    assert.equal(
      (await post({ run: "js-1", role: "teachers", read: [1], verdict: "win" })).status,
      400,
      "nothing else rides along",
    );
    const ok = await post({
      run: "js-1",
      role: "teachers",
      read: [1, 2],
      answers: [{ message: 1, text: "We will cite it next round.", advisor: "teacher-a" }],
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(
      (await brief()).map((m) => [m.id, m.read]),
      [
        [1, true],
        [2, true],
      ],
      "read in the last day: shown as read",
    );
    assert.deepEqual(events(env, "advisor_answer"), [
      { message: 1, role: "teachers", text: "We will cite it next round.", advisor: "teacher-a" },
    ]);
    assert.deepEqual(
      events(env, "agent_message_read").map((b) => [b.message, b.by]),
      [
        [1, "teachers"],
        [2, "teachers"],
      ],
    );
    assert.ok(
      lines(env).some(
        (e) =>
          e.source === "supervisor" &&
          e.kind === "text" &&
          e.text ===
            "the teachers (teacher-a) answered the owner's message #1: We will cite it next round.",
      ),
    );
    // The auditor still has message 2 waiting; the teachers have nothing.
    const after = (await (await call("GET", "/v1/runs")).json()) as typeof runs;
    assert.deepEqual(after.runs[0]?.owner_messages_waiting.teachers, []);
    assert.deepEqual(after.runs[0]?.owner_messages_waiting.auditor, [2]);
  });

  test("a worker reads its messages through its trial's token: fetching marks nothing, a receipt marks only its own", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const registry = new Registry(env.ledger);
    const t = trial("a", "lane-1");
    registry.startTrial({ ...t, epoch: 1, family: "f", parent: "p", token: "tok-1" });
    await send(env, { to: "lane-1", text: "for you" });
    await send(env, { to: "lane-2", text: "not for you" });
    const api = createHarnessApi(env.service, { supervisor: "sup" });
    const call = (method: string, path: string, body?: unknown) =>
      api.request(path, {
        method,
        headers: { authorization: "Bearer trial.tok-1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const get = async () =>
      ((await (await call("GET", "/v1/trial/messages")).json()) as { messages: unknown[] })
        .messages;
    assert.deepEqual(await get(), [{ id: 1, text: "for you" }]);
    assert.deepEqual(await get(), [{ id: 1, text: "for you" }]);
    assert.equal((await call("POST", "/v1/trial/messages/read", { ids: [1, 2] })).status, 200);
    assert.deepEqual(await get(), []);
    assert.deepEqual(
      events(env, "agent_message_read").map((b) => [b.message, b.by]),
      [[1, "lane-1"]],
      "message 2 is lane-2's: this trial cannot mark it",
    );
    assert.equal((await call("POST", "/v1/trial/messages/read", { ids: [] })).status, 400);
    // A worker's live lines are its session's own kinds: it cannot write the owner's message or
    // a receipt, which are the harness's lines.
    for (const kind of ["message", "status", "log"])
      assert.equal(
        (
          await call("POST", "/v1/trial/live", {
            entries: [{ kind, text: "Owner to lane-1 (#1): x" }],
          })
        ).status,
        400,
        kind,
      );
    assert.equal(
      (
        await call("POST", "/v1/trial/live", {
          entries: [{ kind: "text", text: "thinking aloud" }],
        })
      ).status,
      200,
    );
  });

  test("a ledger from before read receipts keeps its deliveries as reads, and the advisors' old messages as read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    MIGRATIONS.slice(0, 12).forEach((m, i) => {
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    const at = "2026-10-19T00:00:00.000Z";
    db.prepare(
      "insert into trial (id, run, lane, epoch, parent_commit, started_at) values ('t-1', 'r', 'lane-2', 1, 'c', ?)",
    ).run(at);
    const msg = db.prepare(
      "insert into agent_message (run, target, text, issued_by, created_at, delivered_at, delivered_to) values ('r', ?, 'x', 'owner', ?, ?, ?)",
    );
    msg.run("lane-2", at, at, "trial:t-1");
    msg.run("planner", at, at, "planner");
    msg.run("lane-1", at, null, null);
    msg.run("advisors", at, null, null);
    db.close();
    const ledger = Ledger.open(path);
    assert.deepEqual(
      ledger.db
        .prepare("select message, reader, trial, read_at from agent_message_read order by id")
        .all()
        .map((r) => ({ ...r })),
      [
        { message: 1, reader: "lane-2", trial: "t-1", read_at: at },
        { message: 2, reader: "planner", trial: null, read_at: at },
        // Shown in the advisors' briefs under the earlier rules: never given again.
        { message: 4, reader: "teachers", trial: null, read_at: at },
        { message: 4, reader: "auditor", trial: null, read_at: at },
        { message: 4, reader: "review_panel", trial: null, read_at: at },
      ],
    );
    const cols = (
      ledger.db.prepare("pragma table_info(agent_message)").all() as { name: string }[]
    ).map((c) => c.name);
    assert.ok(cols.includes("keep") && cols.includes("unkept_at"));
    ledger.close();
  });

  test("a message to the review panel by its v0.1.0 name still waits for it after the update (goal 125)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    LEDGER_MIGRATIONS.slice(0, 21).forEach((m, i) => {
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    const msg = db.prepare(
      "insert into agent_message (run, target, text, issued_by, created_at) values ('r', ?, ?, 'owner', '2026-10-26T00:00:00.000Z')",
    );
    msg.run("panel", "waits");
    msg.run("panel", "read");
    db.prepare(
      "insert into agent_message_read (message, reader, read_at) values (2, 'panel', '2026-10-26T01:00:00.000Z')",
    ).run();
    db.close();
    const ledger = Ledger.open(path);
    const rows = (sql: string) =>
      ledger.db
        .prepare(sql)
        .all()
        .map((r) => Object.values(r));
    assert.deepEqual(rows("select target from agent_message order by id"), [
      ["review_panel"],
      ["review_panel"],
    ]);
    assert.deepEqual(rows("select reader from agent_message_read"), [["review_panel"]]);
    ledger.close();
  });
});

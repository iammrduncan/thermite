import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createControlApi } from "../../src/control/api.ts";
import { ControlStore } from "../../src/control/store.ts";
import { runEntryHtml } from "../../src/control/ui/live.ts";
import { createHarnessApi } from "../../src/harness/api.ts";
import { relayLive, relayLiveOnce, supervisorLive } from "../../src/supervisor/live.ts";
import { relayOnce } from "../../src/supervisor/relay.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const tokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };

function setup() {
  const env = makeHarnessEnv("rig-a");
  const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
  const store = new ControlStore(":memory:");
  const control = createControlApi(store, tokens, env.keys.privateKeyPem);
  let tamper: ((body: string) => string) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const app = url.host === "harness" ? harness : control;
    const body =
      tamper && url.pathname.endsWith("/live") && init?.body
        ? tamper(String(init.body))
        : init?.body;
    return app.request(`${url.pathname}${url.search}`, {
      ...(init as RequestInit),
      body,
    } as RequestInit);
  };
  const cfg = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: "sup-token-abcdef",
    controlUrl: "http://control",
    controlToken: tokens.rigs["rig-a"],
    fetchImpl,
  };
  return { env, store, control, cfg, setTamper: (t: typeof tamper) => (tamper = t) };
}

describe("the live view", () => {
  test("the harness's lines reach control signed; the supervisor's are kept as unsigned; a tampered batch is refused", async () => {
    const s = setup();
    // The rig's key is pinned by its first report.
    await relayOnce(s.cfg, { cursor: 0 });
    s.env.service.live.append({ source: "planner", kind: "status", text: "planning epoch 1" });
    s.env.service.live.append({ source: "judge", kind: "log", text: "evaluate a-1: started" });
    supervisorLive.append({ source: "supervisor", kind: "status", text: "advisor round started" });
    const st = await relayLiveOnce(s.cfg, { cursor: 0, ownCursor: 0 });
    assert.equal(st.cursor, 2);
    const r = await s.control.request("/v1/rigs/rig-a/live", {
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    const body = (await r.json()) as {
      entries: { source: string; text: string; signed: boolean }[];
      sources: { source: string }[];
    };
    assert.deepEqual(
      body.entries.map((e) => [e.source, e.signed]),
      [
        ["planner", true],
        ["judge", true],
        ["supervisor", false],
      ],
    );
    assert.equal(body.sources.length, 3);
    // Nothing new: nothing sent. Then a line the supervisor alters in transit is refused.
    assert.deepEqual(await relayLiveOnce(s.cfg, st), st);
    s.env.service.live.append({ source: "planner", kind: "text", text: "lane-1: tiling" });
    s.setTamper((b) => b.replace("lane-1: tiling", "lane-1: something else"));
    await assert.rejects(relayLiveOnce(s.cfg, st), /403/);
    s.setTamper(undefined);
    await relayLiveOnce(s.cfg, st);
    assert.equal(s.store.liveTail("rig-a", 10).at(-1)?.text, "lane-1: tiling");
  });

  test("a line of a kind control does not know is left out, the rest kept, and said once (goal 171)", async (t) => {
    const s = setup();
    await relayOnce(s.cfg, { cursor: 0 });
    for (const text of ["before", "a newer harness's line", "after"])
      s.env.service.live.append({ source: "planner", kind: "status", text });
    // A newer harness's kind, signed with the batch like the others.
    const kept = (s.env.service.live as unknown as { entries: { kind: string }[] }).entries;
    (kept[1] as { kind: string }).kind = "diff";
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    let st = await relayLiveOnce(s.cfg, { cursor: 0, ownCursor: 0 });
    s.env.service.live.append({ source: "planner", kind: "status", text: "later" });
    (kept[3] as { kind: string }).kind = "diff";
    st = await relayLiveOnce(s.cfg, st);
    t.mock.restoreAll();
    assert.equal(st.cursor, 4);
    assert.deepEqual(
      s.store
        .liveTail("rig-a", 10)
        .filter((e) => e.source === "planner")
        .map((e) => e.text),
      ["before", "after"],
    );
    const told = said.filter((l) => l.includes("control left out live lines it does not know"));
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /"what":"kind diff","lines":1/);
  });

  test("before the rig's key is accepted, live lines are refused", async () => {
    const s = setup();
    s.env.service.live.append({ source: "judge", kind: "log", text: "x" });
    await assert.rejects(relayLiveOnce(s.cfg, { cursor: 0, ownCursor: 0 }), /409/);
  });

  test("the supervisor's live relay waits for the rig's first report, so a first start logs no refusal", async (t) => {
    const s = setup();
    s.env.service.live.append({ source: "judge", kind: "log", text: "first" });
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    let reported = false;
    let stopped = false;
    const relaying = relayLive(s.cfg, {
      intervalMs: 1,
      pollMs: 1,
      stopped: () => stopped,
      reported: () => reported,
    });
    const sent = () => s.store.liveTail("rig-a", 10).some((e) => e.text === "first");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent(), false);
    await relayOnce(s.cfg, { cursor: 0 });
    reported = true;
    for (let i = 0; i < 500 && !sent(); i++) await new Promise((r) => setTimeout(r, 2));
    stopped = true;
    await relaying;
    t.mock.restoreAll();
    assert.equal(sent(), true);
    assert.deepEqual(
      said.filter((l) => l.includes("live relay error")),
      [],
    );
  });

  test("the live relay stops while it still waits for the first report", async () => {
    const s = setup();
    let stopped = false;
    const relaying = relayLive(s.cfg, {
      intervalMs: 1,
      pollMs: 1,
      stopped: () => stopped,
      reported: () => false,
    });
    stopped = true;
    await relaying;
    assert.deepEqual(s.store.liveTail("rig-a", 10), []);
  });
});

describe("the owner's messages to agents", () => {
  test("a message to a lane reaches its trial once; the planner's waits for the next plan; agents cannot send one", async () => {
    const s = setup();
    const issue = (body: unknown, token = tokens.admin) =>
      s.control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const assigned = await issue({
      rig: "rig-a",
      kind: "assign_campaign",
      payload: s.env.assignPayload(),
    });
    assert.equal(assigned.status, 201);
    await relayOnce(s.cfg, { cursor: 0 });
    const toLane = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "lane-1", text: "try the tiled kernel first" },
    });
    const toPlanner = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "planner", text: "spread the lanes wider" },
    });
    assert.equal(toLane.status, 201);
    assert.equal(toPlanner.status, 201);
    // Refusals are the client's to fix: 400 with why (404 for an unknown rig), never 500.
    const toPanel = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "panel", text: "judge it strictly" },
    });
    assert.equal(toPanel.status, 400);
    assert.match(
      String(((await toPanel.json()) as { error: string }).error),
      /no goal the review panel reviews/,
    );
    const empty = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "lane-1", text: "   " },
    });
    assert.equal(empty.status, 400);
    const nowhere = await issue({
      rig: "rig-z",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "lane-1", text: "x" },
    });
    assert.equal(nowhere.status, 404);
    // Each refusal is in the audit log, as the dashboard's and MCP's are.
    assert.equal(
      s.store.listAudit(50).filter((a) => a.action === "refused" && a.actor === "owner:api").length,
      3,
    );
    await relayOnce(s.cfg, { cursor: 0 });
    const svc = s.env.service;
    assert.deepEqual(
      svc.takeMessages({ id: "t-0123456789abcdef", run: "smoke-1", lane: "lane-2" }),
      [],
    );
    assert.deepEqual(
      svc.takeMessages({ id: "t-0123456789abcdef", run: "smoke-1", lane: "lane-1" }),
      ["try the tiled kernel first"],
    );
    assert.deepEqual(
      svc.takeMessages({ id: "t-0123456789abcdef", run: "smoke-1", lane: "lane-1" }),
      [],
    );
    assert.deepEqual(svc.takePlannerMessages("smoke-1"), ["spread the lanes wider"]);
    assert.deepEqual(svc.takePlannerMessages("smoke-1"), []);
    // The owner's message shows in the live view.
    assert.ok(
      svc.live
        .since(0)
        .entries.some((e) => e.kind === "message" && e.text.includes("tiled kernel")),
    );
    // Owner only: the same command signed as an agent's is refused by the harness.
    const r = await svc.applyCommand(
      s.env.sign(
        "message_agent",
        { run: "smoke-1", to: "planner", text: "x" },
        { issuedBy: "agent:mcp" },
      ),
    );
    assert.ok(r.status === "applied" && !r.accepted, JSON.stringify(r));
  });
});

describe("a run's Live lines", () => {
  const line = (o: {
    source: string;
    kind: string;
    text: string;
    signed: boolean;
    lane?: string;
  }) =>
    ({ id: 7, seq: 1, at: "2026-10-20T05:00:00.000Z", run: "r-1", ...o }) as Parameters<
      typeof runEntryHtml
    >[0];
  test("the harness's signed lines show at once; unsigned ones never show as you; a trial's wait for the event", () => {
    // Signed, from the harness's own source: drawn from its words before the event comes.
    const sent = runEntryHtml(
      line({
        source: "supervisor",
        kind: "message",
        text: "Owner to teachers (#4): cite the paper",
        signed: true,
      }),
    );
    assert.match(sent, /class="lv-row lv-you"[\s\S]*<b>To the teachers:<\/b> cite the paper/);
    // The same words unsigned (the supervisor's own line): never the owner's.
    const forged = runEntryHtml(
      line({
        source: "supervisor",
        kind: "message",
        text: "Owner to teachers (#4): cite the paper",
        signed: false,
      }),
    );
    assert.doesNotMatch(forged, /lv-you|class="who">You/);
    const receipt = runEntryHtml(
      line({
        source: "supervisor",
        kind: "status",
        text: "the teacher pair read the owner's message #4: cite the paper",
        signed: true,
      }),
    );
    // A harness of an earlier version names the teachers "the teacher pair": shown by the name
    // now (goal 074), as a line of this version's harness is.
    assert.match(receipt, /✓ the teachers read your message: “cite the paper”/);
    const now = runEntryHtml(
      line({
        source: "supervisor",
        kind: "text",
        text: "the teachers (teacher-b) answered the owner's message #4: done",
        signed: true,
      }),
    );
    assert.match(now, /<b>the teachers \(teacher-b\) answered you:<\/b>/);
    // Filed under a trial: plain and marked until the run's event has the message.
    const early = line({
      source: "trial:t-1",
      kind: "status",
      text: "read the owner's message #4: cite the paper",
      signed: true,
      lane: "lane-1",
    });
    assert.match(runEntryHtml(early), /data-recheck="1"/);
    const later = runEntryHtml(
      early,
      undefined,
      new Map([[4, { to: "lane-1", text: "cite the paper", keep: false }]]),
    );
    assert.match(later, /lv-read/);
    assert.doesNotMatch(later, /data-recheck/);
    // An answer is the harness's signed line from the supervisor's source, nothing else.
    const answer = {
      source: "supervisor",
      kind: "text",
      text: "the auditor answered the owner's message #4: Noted.",
    };
    assert.match(runEntryHtml(line({ ...answer, signed: true })), /the auditor answered you:/);
    assert.doesNotMatch(runEntryHtml(line({ ...answer, signed: false })), /answered you/);
  });

  test("the owner removing a kept message is the owner's line, under You and its lane", () => {
    const unkept = {
      source: "supervisor",
      kind: "status",
      text: "the owner's message #4 is no longer in force",
    };
    const kept = new Map([[4, { to: "lane-2", text: "keep it simple", keep: true }]]);
    const html = runEntryHtml(line({ ...unkept, signed: true, lane: "lane-2" }), undefined, kept);
    assert.match(html, /^<div class="lv-row lv-read" data-who="you lane-2"/);
    assert.match(html, /📌 You removed your kept message: “keep it simple”\. New trials no longer/);
    assert.doesNotMatch(html, /advisors/);
    // To everyone working: under You alone; its words from the event when control has it.
    assert.match(runEntryHtml(line({ ...unkept, signed: true })), /data-who="you"[\s\S]*\(#4\)/);
    // Unsigned, the supervisor's own line: never the owner's.
    const forged = runEntryHtml(line({ ...unkept, signed: false }), undefined, kept);
    assert.match(forged, /data-who="advisors"/);
    assert.doesNotMatch(forged, /You removed/);
  });
});

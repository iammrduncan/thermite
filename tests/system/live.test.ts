import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runEntryHtml } from "../../src/control/ui/live.ts";
import { supervisorLive } from "../../src/supervisor/live/index.ts";
import { ADMIN, controlStack } from "../helpers/control-stack.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/** The stack, with a supervisor that may alter its live lines on their way to the bus. */
function setup() {
  const s = controlStack({ env: makeHarnessEnv("rig-a") });
  let tamper: ((body: string) => string) | undefined;
  const bus = s.bus;
  s.cfg.bus = {
    publish: (subject, data, o) =>
      bus.publish(subject, tamper && subject.includes(".live.") ? tamper(String(data)) : data, o),
    request: (subject, data, timeoutMs) => bus.request(subject, data, timeoutMs),
  };
  return { ...s, setTamper: (t: typeof tamper) => (tamper = t) };
}

describe("the live view, on the message bus", () => {
  test("the harness's lines reach control signed; the supervisor's are kept as unsigned; a tampered batch is refused", async () => {
    const s = setup();
    // The rig's key is pinned by its first report.
    await s.relay();
    s.env.service.live.append({ source: "planner", kind: "status", text: "planning epoch 1" });
    s.env.service.live.append({ source: "judge", kind: "log", text: "evaluate a-1: started" });
    supervisorLive.append({ source: "supervisor", kind: "status", text: "advisor round started" });
    const st = await s.live();
    assert.equal(st.cursor, 2);
    const r = await s.control.request("/v1/rigs/rig-a/live", {
      headers: { authorization: `Bearer ${ADMIN}` },
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
    assert.deepEqual(await s.live(), st);
    s.env.service.live.append({ source: "planner", kind: "text", text: "lane-1: tiling" });
    s.setTamper((b) => b.replace("lane-1: tiling", "lane-1: something else"));
    await s.live();
    assert.equal(s.taken.refused["bad live signature"], 1);
    assert.notEqual(s.store.liveLines.tail("rig-a", 10).at(-1)?.text, "lane-1: something else");
  });

  test("a line of a kind control does not know is left out, the rest kept", async () => {
    const s = setup();
    await s.relay();
    for (const text of ["before", "a newer harness's line", "after"])
      s.env.service.live.append({ source: "planner", kind: "status", text });
    // A newer harness's kind, signed with the batch like the others.
    const kept = (s.env.service.live as unknown as { entries: { kind: string }[] }).entries;
    (kept[1] as { kind: string }).kind = "diff";
    let st = await s.live();
    s.env.service.live.append({ source: "planner", kind: "status", text: "later" });
    (kept[3] as { kind: string }).kind = "diff";
    st = await s.live();
    assert.equal(st.cursor, 4);
    assert.deepEqual(
      s.store.liveLines
        .tail("rig-a", 10)
        .filter((e) => e.source === "planner")
        .map((e) => e.text),
      ["before", "after"],
    );
    assert.equal(s.taken.leftOut, 2);
  });

  test("before the rig's key is accepted, live lines are refused", async () => {
    const s = setup();
    s.env.service.live.append({ source: "judge", kind: "log", text: "x" });
    await s.live();
    assert.equal(s.taken.refused["the rig's report key is not accepted yet"], 1);
    assert.equal(s.store.liveLines.tail("rig-a", 10).filter((e) => e.source === "judge").length, 0);
  });
});

describe("the owner's messages to agents", () => {
  test("a message to a lane reaches its trial once; the planner's waits for the next plan; agents cannot send one", async () => {
    const s = setup();
    const issue = (body: unknown, token = ADMIN) =>
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
    await s.relay();
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
    // Refusals are the client's to fix: 400 with why, never 500.
    const toPanel = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "review_panel", text: "judge it strictly" },
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
    // A message goes to the rig its run is on (goal 170): another rig is refused in words.
    const nowhere = await issue({
      rig: "rig-z",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "lane-1", text: "x" },
    });
    assert.equal(nowhere.status, 400);
    assert.equal(
      ((await nowhere.json()) as { error: string }).error,
      "Run smoke-1 is on rig-a, not on rig-z.",
    );
    // Each refusal is in the audit log, as the dashboard's and MCP's are.
    assert.equal(
      s.store.auditLog.list(50).filter((a) => a.action === "refused" && a.actor === "owner:api")
        .length,
      3,
    );
    await s.relay();
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

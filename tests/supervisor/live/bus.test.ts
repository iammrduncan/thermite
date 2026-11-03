import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { foldLive, LiveTaken } from "../../../src/control/live/index.ts";
import { SupervisorFigures } from "../../../src/core/api/control/rigs.ts";
import { verifyJson } from "../../../src/core/commands.ts";
import { LIVE_FIGURE_SUBJECTS, LIVE_RIG_HEADER } from "../../../src/core/link/live.ts";
import { LiveLog, liveBody } from "../../../src/core/live.ts";
import {
  LiveCounts,
  type LiveRelayState,
  publishLiveOnce,
} from "../../../src/supervisor/live/index.ts";
import { controlStack } from "../../helpers/control-stack.ts";
import { asMessage, FakeBus } from "../../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * The supervisor's live lines on the message bus (goal 168, step 2): each run's source on its
 * own subject, as the harness signed it, and the supervisor's own unsigned; control folds them.
 */

/** Control, a rig whose report key control pinned and whose run smoke-1 it knows, and a bus. */
async function rig() {
  const s = controlStack({ env: makeHarnessEnv("rig-a") });
  await s.relay();
  const at = new Date().toISOString();
  s.store.runRegistry.registerRunCreated("rig-a", "ledger-1", {
    kind: "run_created",
    subject: "smoke-1",
    body: {},
    at,
  });
  const bus = new FakeBus();
  await bus.makeStream({
    name: "LIVE",
    subjects: ["thermite.run.*.live.*", "thermite.rig.*.live.*"],
  });
  const own = new LiveLog({ max: 1000 });
  const counts = new LiveCounts();
  const cfg = {
    rig: "rig-a",
    harnessUrl: s.cfg.harnessUrl,
    harnessToken: s.cfg.harnessToken,
    fetchImpl: s.fetchImpl,
    bus,
    counts,
    own,
  };
  const live = s.env.service.live;
  const taken = new LiveTaken();
  /** Control folds every message the bus kept, as its consumer does. */
  const fold = () => bus.kept.map((m) => foldLive({ store: s.store, taken }, asMessage(m)));
  return { ...s, bus, own, counts, cfg, live, taken, fold };
}

const start: LiveRelayState = { cursor: 0, ownCursor: 0 };

describe("the supervisor's live lines on the message bus", () => {
  test("each run's source goes to its own subject, signed by the harness, and control folds it", async () => {
    const s = await rig();
    s.live.append({ source: "planner", kind: "status", text: "planning round 1", run: "smoke-1" });
    s.live.append({
      source: "trial:t-1",
      kind: "text",
      text: "tiling",
      run: "smoke-1",
      lane: "lane-1",
    });
    s.live.append({ source: "judge", kind: "log", text: "the judge is idle" });
    s.live.append({ source: "planner", kind: "status", text: "planned round 1", run: "smoke-1" });
    s.own.append({ source: "supervisor", kind: "status", text: "teachers asked", run: "smoke-1" });
    s.own.append({ source: "supervisor", kind: "status", text: "advisor round done" });
    const st = await publishLiveOnce(s.cfg, start);
    assert.deepEqual(st, { logId: s.live.id, cursor: 4, ownCursor: 2 });
    assert.deepEqual(
      s.bus.kept.map((m) => [m.subject, m.id]),
      [
        ["thermite.run.smoke-1.live.planner", `${s.live.id}:1-4`],
        ["thermite.run.smoke-1.live.trial-t-1", `${s.live.id}:2-2`],
        ["thermite.rig.rig-a.live.judge", `${s.live.id}:3-3`],
        ["thermite.run.smoke-1.live.supervisor", `${s.own.id}:1-1`],
        ["thermite.rig.rig-a.live.supervisor", `${s.own.id}:2-2`],
      ],
    );
    for (const m of s.bus.kept) {
      assert.equal(m.headers[LIVE_RIG_HEADER], "rig-a", "the rig travels in a header");
      const b = JSON.parse(m.data) as Parameters<typeof liveBody>[0] & {
        signature?: string;
        rig_pubkey?: string;
      };
      if (m.subject.endsWith(".supervisor")) assert.equal(b.signature, undefined);
      // The harness signed each message's lines on their own: the supervisor can't change them.
      else assert.ok(verifyJson(liveBody(b), b.signature ?? "", b.rig_pubkey ?? ""));
    }
    assert.deepEqual(s.counts.figures(), {
      published: 6,
      dropped: 0,
      subjects: {
        "thermite.run.smoke-1.live.planner": { published: 2, dropped: 0 },
        "thermite.run.smoke-1.live.trial-t-1": { published: 1, dropped: 0 },
        "thermite.rig.rig-a.live.judge": { published: 1, dropped: 0 },
        "thermite.run.smoke-1.live.supervisor": { published: 1, dropped: 0 },
        "thermite.rig.rig-a.live.supervisor": { published: 1, dropped: 0 },
      },
    });
    // Control folds them into the rig's live view: the harness's signed, the supervisor's not.
    assert.deepEqual(
      s.fold().map((f) => ("added" in f ? f.added : f.refused)),
      [2, 1, 1, 1, 1],
    );
    assert.deepEqual(
      s.store.liveLines.ofRun("rig-a", "smoke-1", 0, 10).map((e) => [e.text, e.signed]),
      [
        ["planning round 1", true],
        ["planned round 1", true],
        ["tiling", true],
        ["the judge is idle", true],
        ["teachers asked", false],
        ["advisor round done", false],
      ],
    );
    // Nothing new: nothing published, and the place stays.
    assert.deepEqual(await publishLiveOnce(s.cfg, st), st);
    assert.equal(s.bus.kept.length, 5);
  });

  test("a run's subject the bus refuses sends its lines on the rig's; refused there too, they are dropped and counted", async () => {
    const s = await rig();
    // A run control does not give the rig yet, as one the rig made itself before its first report.
    s.bus.refuse = (subject) => subject.startsWith("thermite.run.");
    s.live.append({ source: "planner", kind: "status", text: "planning", run: "smoke-1" });
    let st = await publishLiveOnce(s.cfg, start);
    assert.deepEqual(
      s.bus.kept.map((m) => m.subject),
      ["thermite.rig.rig-a.live.planner"],
    );
    // Control takes a run's lines on the rig's subject: they show on the run's Live.
    s.fold();
    assert.deepEqual(
      s.store.liveLines.ofRun("rig-a", "smoke-1", 0, 10).map((e) => e.text),
      ["planning"],
    );
    // Refused everywhere (a retired rig's user): dropped, counted, and the place moves on.
    s.bus.refuse = () => true;
    s.live.append({ source: "planner", kind: "status", text: "planned", run: "smoke-1" });
    s.live.append({ source: "judge", kind: "log", text: "idle" });
    st = await publishLiveOnce(s.cfg, st);
    assert.equal(st.cursor, 3);
    assert.equal(s.bus.kept.length, 1);
    const f = s.counts.figures();
    assert.deepEqual([f.published, f.dropped], [1, 2]);
    assert.deepEqual(f.subjects["thermite.run.smoke-1.live.planner"], { published: 0, dropped: 1 });
    assert.deepEqual(f.subjects["thermite.rig.rig-a.live.judge"], { published: 0, dropped: 1 });
  });

  test("on a leaf node, a run's subject the rig may not use gets no answer: its lines go on the rig's; none there waits", async () => {
    const s = await rig();
    // Through a RunPod pod's leaf node, a subject the rig's account does not take reaches no
    // stream at all, as a subject no stream takes.
    const leaf = new FakeBus();
    await leaf.makeStream({ name: "LIVE", subjects: ["thermite.rig.*.live.*"] });
    s.live.append({ source: "planner", kind: "status", text: "planning", run: "smoke-1" });
    const st = await publishLiveOnce({ ...s.cfg, bus: leaf }, start);
    assert.equal(st.cursor, 1);
    assert.deepEqual(
      leaf.kept.map((m) => m.subject),
      ["thermite.rig.rig-a.live.planner"],
    );
    // No stream on the rig's subject either (the leaf not up yet): the lines wait for a round.
    const none = new FakeBus();
    s.live.append({ source: "planner", kind: "status", text: "planned", run: "smoke-1" });
    await assert.rejects(
      publishLiveOnce({ ...s.cfg, bus: none }, st),
      /no stream on the bus takes/,
    );
  });

  test("a bus that fails otherwise leaves the place where it was; the round again is kept once", async () => {
    const s = await rig();
    s.live.append({ source: "planner", kind: "status", text: "a", run: "smoke-1" });
    s.live.append({ source: "judge", kind: "log", text: "b" });
    // The first message is acked, then the server's acks stop coming.
    const publish = s.bus.publish.bind(s.bus);
    let calls = 0;
    s.bus.publish = async (subject, data, o) => {
      if (++calls === 2) throw new Error("TimeoutError: no ack from the server");
      return await publish(subject, data, o);
    };
    await assert.rejects(publishLiveOnce(s.cfg, start), /no ack/);
    assert.equal(s.bus.kept.length, 1);
    const st = await publishLiveOnce(s.cfg, start);
    assert.equal(st.cursor, 2);
    assert.deepEqual(
      s.bus.kept.map((m) => m.subject),
      ["thermite.run.smoke-1.live.planner", "thermite.rig.rig-a.live.judge"],
      "each message once",
    );
    // Counted once each: the one the bus had already is counted again, as published.
    assert.equal(s.counts.figures().dropped, 0);
  });

  test("the figures count every line, and name the subjects used last", () => {
    const counts = new LiveCounts();
    for (let i = 0; i < LIVE_FIGURE_SUBJECTS + 50; i++)
      counts.add(`thermite.run.r-${i}.live.planner`, i % 2 ? "dropped" : "published", 2);
    counts.add("thermite.run.r-0.live.planner", "published", 1);
    const f = counts.figures();
    assert.equal(f.published + f.dropped, (LIVE_FIGURE_SUBJECTS + 50) * 2 + 1);
    const names = Object.keys(f.subjects);
    assert.equal(names.length, LIVE_FIGURE_SUBJECTS);
    assert.equal(names.at(-1), "thermite.run.r-0.live.planner", "used last, kept");
    assert.ok(!names.includes("thermite.run.r-1.live.planner"), "the least recent left out");
    // Control takes them with the figures; too many subjects are dropped, not the figures.
    const at = new Date().toISOString();
    assert.deepEqual(SupervisorFigures.parse({ at, live: f }).live, f);
    const tooMany = { ...f, subjects: { ...f.subjects, extra: { published: 1, dropped: 0 } } };
    const parsed = SupervisorFigures.parse({ at, live: tooMany });
    assert.equal(parsed.live, undefined);
    assert.equal(parsed.at, at);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { BusFiguresLook } from "../../../src/control/system/index.ts";
import { FakeServer, serverAnswers } from "../../helpers/fake-server-figures.ts";

/**
 * The bus's figures (goal 179): the server's monitoring as control's system user asks for it,
 * shaped for Metrics' Bus tab, REST and MCP, with rates between two looks and what looks wrong.
 */

const MIB = 2 ** 20;

test("the server, its streams, consumers and connections, named; rates from the second look", async () => {
  let now = Date.parse("2026-11-02T04:00:00Z");
  const asker = new FakeServer(serverAnswers({ inMsgs: 1000, lastSeq: 100, liveBytes: 10 * MIB }));
  const look = new BusFiguresLook({
    look: asker,
    holders: () =>
      new Map([
        ["UCONTROL", "control"],
        ["URIGA", "rig rig-a"],
      ]),
    now: () => now,
  });
  const first = await look.read();
  assert.equal(first.server?.version, "2.15.1");
  assert.equal(first.server?.rate, null, "no rate on the first look");
  assert.deepEqual(first.server?.jetstream, {
    memory_bytes: 0,
    memory_max: 384 * MIB,
    store_bytes: 900 * MIB,
    store_max: 1024 * MIB,
    api_calls: 77,
    api_errors: 1,
  });
  const live = first.streams.find((s) => s.name === "LIVE");
  assert.deepEqual(live?.config, {
    retention: "limits",
    storage: "file",
    discard: "old",
    max_bytes: 256 * MIB,
    max_age_seconds: 3600,
    max_msgs_per_subject: 1000,
    max_msg_size: MIB,
  });
  const reports = first.streams.find((s) => s.name === "REPORTS");
  assert.equal(reports?.first_at, null, "the server's zero time is none");
  assert.equal(reports?.config.max_bytes, null, "-1 is no limit");
  assert.deepEqual(first.consumers[0]?.filter, ["thermite.rig.*.report"]);
  assert.equal(first.consumers[0]?.durable, true);
  assert.deepEqual(
    first.connections.map((c) => [c.name, c.user]),
    [
      ["control", "control"],
      ["supervisor rig-a", "rig rig-a"],
    ],
  );
  assert.equal(first.connections_left_out, 1);
  // What it asked: JetStream with its streams, consumers and config; connections with theirs.
  assert.deepEqual(asker.asked.find((a) => a.what === "JSZ")?.options, {
    accounts: true,
    streams: true,
    consumer: true,
    config: true,
  });
  assert.equal(asker.asked.find((a) => a.what === "CONNZ")?.options.subscriptions, true);

  // Asked again within a second: the same look, not another question.
  const asks = asker.asked.length;
  await look.read();
  assert.equal(asker.asked.length, asks);

  // Two seconds later: 200 messages in and 10 places more, so 100 a second and 5 a second.
  now += 2000;
  asker.now = serverAnswers({ inMsgs: 1200, lastSeq: 110, liveBytes: 10 * MIB });
  const second = await look.read();
  assert.equal(second.server?.rate?.in_msgs, 100);
  assert.equal(second.streams.find((s) => s.name === "LIVE")?.rate, 5);
});

test("what looks wrong: a stream and the store near their limits, a reader away, a client behind", async () => {
  const now = Date.parse("2026-11-02T04:00:00Z");
  const asker = new FakeServer(
    serverAnswers({ inMsgs: 1, lastSeq: 1, liveBytes: 250 * MIB, pending: 12 }),
  );
  const f = await new BusFiguresLook({ look: asker, now: () => now }).read();
  const w = f.warnings.join("\n");
  assert.match(w, /The bus's store holds 88% of its limit/);
  assert.match(w, /LIVE holds 98% of its limit .*it drops its oldest messages/);
  assert.match(
    w,
    /control-reports on REPORTS has 12 messages waiting and took none for 60 minutes/,
  );
  assert.match(w, /The server queues 2\.0 MiB for supervisor rig-a/);
});

test("a figure the server won't give is said, and the rest are shown; no bus at all is said too", async () => {
  const asker = new FakeServer(serverAnswers({ inMsgs: 1, lastSeq: 1, liveBytes: 0 }));
  asker.failing = "CONNZ";
  const f = await new BusFiguresLook({ look: asker }).read();
  assert.deepEqual(f.errors, ["CONNZ: no answer"]);
  assert.equal(f.connections.length, 0);
  assert.equal(f.streams.length, 2);
  const none = await new BusFiguresLook({}).read();
  assert.deepEqual(none.errors, ["control has no message bus to look at"]);
  assert.equal(none.server, null);
});

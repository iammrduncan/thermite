import assert from "node:assert/strict";
import { test } from "node:test";
import { type BusView, ConfigWritten } from "../../../src/control/bus/index.ts";
import { LiveTaken } from "../../../src/control/live/index.ts";
import { EVENT_STREAM_CONFIG } from "../../../src/core/link/events.ts";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { busOf, controlStore, ingestReport } from "../../helpers/control-store.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";
import { FakeServer, serverAnswers } from "../../helpers/fake-server-figures.ts";

/**
 * Metrics' system tabs and the stream inspector (goal 179, from the owner's mockup): Bus, Control,
 * Storage and Rigs beside Model use, drawn again every 2 seconds; a click on a stream opens its
 * messages, and a message its headers and data. REST and MCP give the same figures; a stream's
 * messages only to the owner.
 */

const READ = "read-token-abcdef0123456789";

async function setUp() {
  const bus = new FakeBus();
  const store = controlStore(":memory:", bus);
  await busOf(store).started;
  await bus.makeStream(EVENT_STREAM_CONFIG);
  await bus.publish(
    "thermite.run.r1.ev.trial_finished",
    JSON.stringify({ note: "<script>alert(1)</script>" }),
    {
      id: "e-1",
      headers: { "Thermite-Rig": "rig-a", "Thermite-Ledger": "<b>ledger</b>" },
    },
  );
  await bus.publish("thermite.rig.rig-a.ev.model_call", JSON.stringify({ tokens: 12 }), {
    id: "e-2",
  });
  const view: BusView = {
    server: "nats:4222",
    bus: {
      connected: () => true,
      lastSeq: (s) => bus.lastSeq(s),
      link: () => ({ since: "2026-11-02T01:00:00.000Z", version: "2.15.1" }),
      streams: (names, o) => bus.streams(names, o),
      next: (s, from, subject) => bus.next(s, from, subject),
      message: (s, seq) => bus.message(s, seq),
    },
    ...(({ writer, move, apply }) => ({ events: writer, move, apply }))(busOf(store)),
    live: new LiveTaken(),
    config: new ConfigWritten(),
  };
  const server = new FakeServer(serverAnswers({ inMsgs: 10, lastSeq: 2, liveBytes: 1024 }));
  const s = controlOnly({
    store,
    options: { bus: view, serverLook: server, busOwnKeys: () => ["UCONTROL"] },
    tokens: { read: READ },
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: 0,
    events: [],
    summary: {
      usage: {
        at: "2026-11-02T04:00:00.000Z",
        of: "container",
        cpu: 0.5,
        cpus: 4,
        memory_bytes: 2 ** 30,
        memory_limit_bytes: 8 * 2 ** 30,
      },
    },
    generated_at: new Date().toISOString(),
  });
  return { s, store, bus };
}

test("Metrics' tabs: Model use as before, and Bus, Control, Storage and Rigs, each live", async () => {
  const { s } = await setUp();
  const ui = await signIn(s.control);
  const use = await ui.page("/ui/metrics");
  assert.match(
    use,
    /<nav class="tabs"><a class="on" href="\/ui\/metrics">Model use<\/a><a class="" href="\/ui\/metrics\?tab=bus">Bus<\/a>/,
  );
  assert.doesNotMatch(use, /data-every/, "Model use is not drawn again by itself");
  const bus = await ui.page("/ui/metrics?tab=bus");
  assert.match(bus, /<a class="on" href="\/ui\/metrics\?tab=bus">Bus<\/a>/);
  assert.match(bus, /data-every="2000"/);
  assert.match(bus, /<div data-part="sys">/);
  assert.match(bus, /NATS 2\.15\.1/);
  assert.match(bus, /<a href="\/ui\/metrics\/streams\/LIVE"><b>LIVE<\/b><\/a>/);
  assert.match(bus, /control-reports/);
  assert.match(bus, /<b>supervisor rig-a<\/b>/);
  assert.match(
    bus,
    /May publish \(its permissions\): everything in its account but removing a stream/,
  );
  assert.match(bus, /The server queues 2\.0 MiB for supervisor rig-a/);
  const control = await ui.page("/ui/metrics?tab=control");
  assert.match(control, /Event loop delay/);
  assert.match(control, /JavaScript heap in use/);
  const storage = await ui.page("/ui/metrics?tab=storage");
  assert.match(storage, /In memory/);
  assert.match(storage, /On disk/);
  assert.match(storage, /Available/);
  assert.match(storage, /the bus&#39;s store|the bus's store/);
  assert.match(storage, /control\.db/);
  const rigs = await ui.page("/ui/metrics?tab=rigs");
  assert.match(rigs, /rig-a/);
  assert.match(rigs, /12\.5%/, "half a CPU of its 4");
  assert.match(rigs, /not reported: its image is older than control/, "its supervisor sent no use");
});

test("a stream's messages, newest first, by subject; a message whole, escaped; its data downloaded", async () => {
  const { s } = await setUp();
  const ui = await signIn(s.control);
  const list = await ui.page("/ui/metrics/streams/EVENTS");
  assert.match(
    list,
    /href="\/ui\/metrics\/streams\/EVENTS\/2">2<\/a>[\s\S]*href="\/ui\/metrics\/streams\/EVENTS\/1">1<\/a>/,
  );
  assert.match(list, /&lt;script&gt;/);
  assert.doesNotMatch(list, /<script>alert/);
  const filtered = await ui.page("/ui/metrics/streams/EVENTS?subject=thermite.rig.%3E");
  assert.doesNotMatch(filtered, /thermite\.run\.r1\.ev\.trial_finished<\/code>/);
  assert.match(filtered, /thermite\.rig\.rig-a\.ev\.model_call<\/code>/);
  const bad = await ui.get("/ui/metrics/streams/EVENTS?subject=a%20b");
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /subject is refused/);
  assert.equal((await ui.get("/ui/metrics/streams/NOPE")).status, 404);
  const one = await ui.page("/ui/metrics/streams/EVENTS/1");
  assert.match(one, /Thermite-Ledger/);
  assert.match(one, /&lt;b&gt;ledger&lt;\/b&gt;/);
  assert.match(one, /&quot;note&quot;: &quot;&lt;script&gt;/, "JSON laid out, and escaped");
  assert.equal((await ui.get("/ui/metrics/streams/EVENTS/9")).status, 404);
  const data = await ui.get("/ui/metrics/streams/EVENTS/1/data");
  assert.match(
    data.headers.get("content-disposition") ?? "",
    /attachment; filename="EVENTS-1\.txt"/,
  );
  assert.equal(await data.text(), JSON.stringify({ note: "<script>alert(1)</script>" }));
});

test("REST: the system's figures for the reader too; a stream's messages for the owner alone", async () => {
  const { s } = await setUp();
  const all = await s.api("GET", "/v1/system", undefined, READ);
  assert.equal(all.status, 200);
  const body = (await all.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["bus", "control", "storage", "rigs"]);
  const one = (await (await s.api("GET", "/v1/system?part=rigs")).json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(one), ["rigs"]);
  const bad = await s.api("GET", "/v1/system?part=gpu");
  assert.equal(bad.status, 400);
  assert.match(String(((await bad.json()) as { error: string }).error), /part is refused/);
  assert.equal(
    (await s.api("GET", "/v1/bus/streams/EVENTS/messages", undefined, READ)).status,
    401,
  );
  const page = (await (
    await s.api("GET", "/v1/bus/streams/EVENTS/messages?subject=thermite.run.>")
  ).json()) as {
    messages: { seq: number }[];
  };
  assert.deepEqual(
    page.messages.map((m) => m.seq),
    [1],
  );
  const m = (await (await s.api("GET", "/v1/bus/streams/EVENTS/messages/2")).json()) as {
    text: string | null;
    base64: string | null;
  };
  assert.deepEqual([m.text, m.base64], [JSON.stringify({ tokens: 12 }), null]);
  assert.equal((await s.api("GET", "/v1/bus/streams/EVENTS/messages/9")).status, 404);
});

test("MCP: system_state for the reader, bus_messages for the owner alone", async () => {
  const { s } = await setUp();
  const reader = await mcpClient(s.control, READ);
  const names = (await reader.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("system_state"));
  assert.ok(!names.includes("bus_messages"));
  const state = await reader.callTool({ name: "system_state", arguments: { part: ["bus"] } });
  const text = (state.content as { text: string }[])[0]?.text ?? "";
  assert.deepEqual(Object.keys(JSON.parse(text)), ["bus"]);
  const owner = await mcpClient(s.control);
  const msg = await owner.callTool({
    name: "bus_messages",
    arguments: { stream: "EVENTS", seq: 1 },
  });
  const got = JSON.parse((msg.content as { text: string }[])[0]?.text ?? "{}") as {
    text: string;
    cut: boolean;
  };
  assert.equal(got.cut, false);
  assert.match(got.text, /alert\(1\)/);
});

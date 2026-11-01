import assert from "node:assert/strict";
import { test } from "node:test";
import { type BusView, ConfigWritten, noteOffBusCall } from "../../../../src/control/bus/index.ts";
import { ControlDisk } from "../../../../src/control/disk.ts";
import { LiveTaken } from "../../../../src/control/live/index.ts";
import { COMMAND_STREAM_CONFIG } from "../../../../src/core/link/commands.ts";
import { LIVE_STREAM_CONFIG } from "../../../../src/core/link/live.ts";
import { REPORT_STREAM_CONFIG } from "../../../../src/core/link/report.ts";
import { controlOnly, signIn } from "../../../helpers/control-stack.ts";
import { busOf, controlStore, ingestReport } from "../../../helpers/control-store.ts";
import { FakeBus } from "../../../helpers/fake-bus.ts";

/**
 * Settings › Message bus (goal 168; the owner's decision of 2026-11-01, from a mockup): control's
 * connection, the rigs on the bus with what waits for each, and the streams with what each
 * carries, holds and keeps, from the same state as `GET /v1/bus` and `busReach()`.
 */

const GIB = 1024 ** 3;

test("Settings › Message bus: control's connection, each rig on the bus or off it, and the streams", async () => {
  const bus = new FakeBus();
  const store = controlStore(":memory:", bus);
  await busOf(store).started;
  await bus.makeStream(REPORT_STREAM_CONFIG);
  await bus.makeStream(COMMAND_STREAM_CONFIG);
  await bus.makeStream(LIVE_STREAM_CONFIG);
  // Two of rig-a's reports wait on the bus; control holds a connection since 05:20.
  await bus.publish("thermite.rig.rig-a.report", "{}", { id: "r-1" });
  await bus.publish("thermite.rig.rig-a.report", "{}", { id: "r-2" });
  // The fake bus lists no consumers: the rig's, as a server lists them.
  const consumers: Record<
    string,
    { name: string; pending: number; ack_pending: number; redelivered: number }[]
  > = {
    COMMANDS: [{ name: "rig-rig-a-commands", pending: 2, ack_pending: 1, redelivered: 3 }],
  };
  const view: BusView = {
    server: "nats:4222",
    bus: {
      connected: () => true,
      lastSeq: (s) => bus.lastSeq(s),
      link: () => ({ since: "2026-11-01T05:20:00.000Z", version: "2.15.1" }),
      streams: async (names, o) =>
        (await bus.streams(names, o)).map((x) => ({ ...x, consumers: consumers[x.name] ?? [] })),
    },
    ...(({ writer, move, apply }) => ({ events: writer, move, apply }))(busOf(store)),
    live: new LiveTaken(),
    config: new ConfigWritten(),
  };
  // Control's disk: the bus's store 612 MiB of 40 GiB used, a floor of 5 GiB.
  const disk = new ControlDisk({
    store,
    stateDir: "/nowhere",
    floorGib: 5,
    free: () => ({ free: 100 * GIB, total: 200 * GIB }),
    busStore: async () => ({ used: 0.6 * GIB, limit: 40 * GIB }),
  });
  await disk.check();
  const s = controlOnly({
    store,
    options: { bus: view },
    tokens: { rigs: { "rig-a": "rig-a-token-abcdef", "rig-b": "rig-b-token-abcdef" } },
  });
  for (const rig of ["rig-a", "rig-b"])
    await ingestReport(store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: 0,
      next: 0,
      events: [],
      summary: {},
      generated_at: new Date().toISOString(),
    });
  noteOffBusCall(store, "rig-b");
  const ui = await signIn(s.control);
  const page = await ui.page("/ui/settings");

  // Control's connection.
  assert.match(page, /<h2>Message bus<\/h2>/);
  assert.match(
    page,
    /<dt>State<\/dt><dd><span class="dot ok"><\/span> Connected, since 2026-11-01 05:20 UTC<\/dd>/,
  );
  assert.match(
    page,
    /<dt>Server<\/dt><dd>NATS 2\.15\.1, nats:4222, over TLS with control's own authority<\/dd>/,
  );
  assert.match(
    page,
    /<dt>Its store<\/dt><dd>0\.6 GiB of 40 GiB · control holds new runs below 5 GiB left<\/dd>/,
  );
  assert.match(
    page,
    /<dt>Rigs' events<\/dt><dd>written through place \d[\d,]* · applied through \d[\d,]* <span class="chip ok">none behind<\/span><\/dd>/,
  );
  // Each rig: rig-a on the bus with what waits for it; rig-b off it, broken.
  const row = (rig: string) =>
    new RegExp(`<tr data-rig="${rig}"[^>]*>(.*?)</tr>`).exec(page)?.[1] ?? "";
  assert.match(page, /<tr data-rig="rig-a" data-bus="on">/);
  assert.match(
    row("rig-a"),
    /<span class="dot ok"><\/span> On the bus<\/td><td class="num">2<\/td><td class="num">3<\/td><td class="num">3<\/td><td>\d+ ?s ago<\/td>/,
  );
  assert.match(page, /<tr data-rig="rig-b" data-bus="off">/);
  assert.match(
    row("rig-b"),
    /<b>Off the bus<\/b> since \d{4}-\d\d-\d\d \d\d:\d\d UTC: broken until it comes back/,
  );
  assert.match(page, /Rigs on the bus<\/h2><span class="n">2<\/span>/);
  // The info icons say what each column is.
  assert.match(page, /The rig's reports on the bus that control has not taken yet/);
  assert.match(
    page,
    /Messages the bus sent the rig again because it did not acknowledge them in time/,
  );
  // The streams, with what each carries and keeps.
  assert.match(
    page,
    /<tr data-stream="REPORTS"><td><code>REPORTS<\/code><\/td><td>Each rig's reports, until control takes them<\/td><td class="num">2<\/td><td class="num">[^<]+<\/td><td>Until taken · 32 waiting per rig at most<\/td><\/tr>/,
  );
  assert.match(
    page,
    /<tr data-stream="EVENTS">.*Until a retention policy removes some; never deleted/,
  );
  assert.match(page, /<tr data-stream="LIVE">.*The newest 1 hour, 1,000 a subject/);
  assert.match(
    page,
    /The same figures: <code>thermite bus<\/code>, <code>GET \/v1\/bus<\/code> and MCP's <code>bus_state<\/code>/,
  );

  // Away: control says so, and the server's state the page could not read.
  view.bus.connected = () => false;
  view.bus.link = () => ({ since: null, version: null });
  const away = await ui.page("/ui/settings");
  assert.match(
    away,
    /<span class="dot bad"><\/span> <b class="bad">Away<\/b>: control holds no connection to the bus/,
  );
});

test("Settings › Message bus without control's bus, as only a test makes it: it says so", async () => {
  const s = controlOnly();
  const ui = await signIn(s.control);
  const page = await ui.page("/ui/settings");
  assert.match(page, /Control runs without its message bus: only a test makes it so\./);
});

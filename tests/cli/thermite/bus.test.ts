import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { type BusView, ConfigWritten } from "../../../src/control/bus/index.ts";
import { LiveTaken } from "../../../src/control/live/index.ts";
import { LIVE_STREAM_CONFIG } from "../../../src/core/link/live.ts";
import { REPORT_STREAM_CONFIG } from "../../../src/core/link/report.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { busOf, controlStore } from "../../helpers/control-store.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const READ = "read-token-abcdef";

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("thermite bus prints the message bus as control sees it, or its JSON, with the reader's token (goal 168)", async () => {
  // Control on a bus with the reports and live streams made, two live messages kept and taken.
  const bus = new FakeBus();
  const store = controlStore(":memory:", bus);
  await bus.makeStream(REPORT_STREAM_CONFIG);
  await bus.makeStream(LIVE_STREAM_CONFIG);
  await bus.publish("thermite.run.r1.live.planner", "{}", { id: "log:1-2" });
  await bus.publish("thermite.rig.rig-a.live.judge", "{}", { id: "log:3-3" });
  const live = new LiveTaken();
  live.messages = 2;
  live.lines = 3;
  live.rigs.set("rig-a", 3);
  const { writer: events, move, apply } = busOf(store);
  await busOf(store).started;
  // The fake bus lists no consumers: the live stream gets control's, as a server lists it.
  const withConsumer: BusView["bus"] = {
    connected: () => bus.connected(),
    lastSeq: (stream) => bus.lastSeq(stream),
    streams: async (names) =>
      (await bus.streams(names)).map((x) =>
        x.name === "LIVE"
          ? {
              ...x,
              consumers: [{ name: "control-live", pending: 1, ack_pending: 2, redelivered: 0 }],
            }
          : x,
      ),
  };
  const view: BusView = {
    server: "nats:4222",
    bus: withConsumer,
    events,
    move,
    apply,
    live,
    config: new ConfigWritten(),
  };
  const s = controlOnly({ store, tokens: { read: READ }, options: { bus: view } });
  const server = serve({ fetch: s.control.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  try {
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-bus-"));
    const token = join(dir, "reader");
    writeFileSync(token, `${READ}\n`, { mode: 0o600 });
    const on = ["--control", control, "--token-file", token];

    const said = await cli("bus", ...on);
    assert.equal(said.code, 0, said.stderr);
    const lines = said.stdout.trimEnd().split("\n");
    assert.equal(lines[0], "bus nats:4222: reached");
    assert.match(lines[1] ?? "", /^STREAM\s+MESSAGES\s+BYTES\s+SUBJECTS\s+NEWEST$/);
    assert.match(said.stdout, /^REPORTS\s+0\s+0 B\s+0\s+none$/m);
    assert.match(said.stdout, /^EVENTS\s+0\s+0 B\s+0\s+none$/m);
    // The fake bus keeps no times: a server's stream gives its newest message's.
    assert.match(
      said.stdout,
      /^LIVE\s+2\s+4 B\s+2\s+none\n {2}consumer control-live: 1 not handed yet, 2 not acked, 0 handed again$/m,
    );
    assert.match(
      said.stdout,
      /^events: 0 published since control started, 0 moved from an older store, 0 reports refused for now$/m,
    );
    assert.match(said.stdout, /^apply: through place 0 of 0, 0 behind; 0 applied, 0 passed over/m);
    assert.match(
      said.stdout,
      /^live: 2 messages and 3 lines taken since control started; rig-a 3$/m,
    );
    assert.match(said.stdout, /^config: no rig on the bus yet$/m);

    // --json: control's answer as it came, the same as GET /v1/bus.
    const json = await cli("bus", ...on, "--json");
    assert.equal(json.code, 0, json.stderr);
    const answer = (await (
      await s.control.request("/v1/bus", { headers: { authorization: `Bearer ${READ}` } })
    ).json()) as { streams: unknown[]; live: { taken: { since: string } } };
    const printed = JSON.parse(json.stdout) as typeof answer;
    assert.deepEqual(printed.streams, answer.streams);
    assert.equal(printed.live.taken.since, answer.live.taken.since);

    // A wrong token: control's refusal, exit code 2. No control: the usage, exit code 2.
    const other = join(dir, "other");
    writeFileSync(other, "not-a-token\n", { mode: 0o600 });
    const refused = await cli("bus", "--control", control, "--token-file", other);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /-> 401 /);
    const usage = await cli("bus");
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /^usage: thermite <command>/);
  } finally {
    server.close();
  }
});

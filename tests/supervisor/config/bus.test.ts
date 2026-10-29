import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BusMessage } from "../../../src/common/bus/index.ts";
import {
  CONFIG_STREAM,
  type ConfigKey,
  configConsumerName,
  configSubjects,
  newSealKey,
  sealConfig,
} from "../../../src/core/link/config.ts";
import type { McpConnection, McpUnavailable } from "../../../src/core/mcp.ts";
import {
  applyConfig,
  ConfigCounts,
  followConfig,
  keepConfig,
  RigConfig,
  takeConfig,
} from "../../../src/supervisor/config/index.ts";

/**
 * The rig's config from the message bus, on the supervisor's side (goal 168, step 3): each value
 * it takes is applied at once, to the harness and to the advisors; one it can't take is counted,
 * and what it knows stays; and on its beat it hands its harness again what the harness lost,
 * without asking control.
 */

const seal = newSealKey();
let seq = 0;

/** A message on rig-a's key, as control writes it, sealed to `sealKey`. */
function message(
  key: string,
  value: unknown,
  revision: string,
  sealKey = seal.publicKey,
): BusMessage {
  const m = {
    v: 1,
    rig: "rig-a",
    key,
    revision,
    written_at: new Date().toISOString(),
    sealed: sealConfig("rig-a", key as ConfigKey, value, sealKey),
  };
  return {
    subject: `thermite.rig.rig-a.config.${key}`,
    seq: ++seq,
    data: new TextEncoder().encode(JSON.stringify(m)),
    header: () => undefined,
  };
}

const route = (revision: string) => ({
  name: "lab",
  type: "openai",
  harness: "pi",
  version: 1,
  base_url: "https://models.example.com/v1",
  model: "m-1",
  context_window: 128_000,
  max_tokens: 0,
  reasoning: null,
  key_hint: "…-one",
  revision,
  api_key: "made-up-key-one",
});

const server = (name: string, agents: string[]) => ({
  name,
  url: "https://mcp.example.com/",
  headers: { authorization: "Bearer made-up" },
  revision: `${name}0123456789`.slice(0, 16),
  agents,
});

/**
 * A harness that holds a route and MCP servers as the real one does, and records what it is
 * handed; `away` makes it unreachable. A call to control fails the test: the bus needs no poll.
 */
function harness() {
  const h = {
    away: false,
    route: { source: "environment" } as { source: string; revision?: string },
    servers: { servers: [] as { name: string; revision: string }[], unavailable: [] as unknown[] },
    puts: [] as { path: string; body: Record<string, unknown> }[],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== "harness") throw new Error(`the supervisor called ${url.host}`);
    if (h.away) throw new TypeError("fetch failed");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      h.puts.push({ path: url.pathname, body });
      if (url.pathname === "/v1/model-route") {
        const r = body.route as { revision: string } | null;
        h.route = r ? { source: "control", revision: r.revision } : { source: "environment" };
      } else
        h.servers = {
          servers: (body.servers as McpConnection[]).map((s) => ({
            name: s.name,
            revision: s.revision,
          })),
          unavailable: body.unavailable as unknown[],
        };
      return Response.json(url.pathname === "/v1/model-route" ? {} : h.servers);
    }
    return Response.json(url.pathname === "/v1/model-route" ? h.route : h.servers);
  };
  return { h, fetchImpl };
}

/** The supervisor's side: what it knows, its counts, the advisors' servers, and its harness. */
function setup() {
  const { h, fetchImpl } = harness();
  const known = new RigConfig();
  const counts = new ConfigCounts();
  const advisorMcp: { servers: string[]; unavailable: McpUnavailable[] }[] = [];
  const keep = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: "h",
    fetchImpl,
    known,
    setAdvisorMcp: (servers: McpConnection[], unavailable: McpUnavailable[]) =>
      advisorMcp.push({ servers: servers.map((s) => s.name), unavailable }),
    everyMs: 1,
    stopping: () => false,
    pause: async () => {},
  };
  const watch = {
    rig: "rig-a",
    sealKey: seal.privatePem,
    known,
    counts,
    apply: (key: ConfigKey) => applyConfig(keep, known, key),
  };
  return { h, known, counts, advisorMcp, keep, watch };
}

describe("the rig's config from the message bus", () => {
  test("watches its own keys in the config bucket, from the latest of each, on the consumer control makes", async () => {
    const s = setup();
    const asked: { stream: string; consumer: string; subjects: readonly string[] }[] = [];
    const bus = {
      watch: async (
        stream: string,
        consumer: string,
        subjects: readonly string[],
        handle: (m: BusMessage) => unknown,
      ) => {
        asked.push({ stream, consumer, subjects });
        await handle(message("model-route", { route: route("r1"), planner: null }, "a".repeat(32)));
      },
    };
    await followConfig(bus, s.watch);
    assert.deepEqual(asked, [
      {
        stream: CONFIG_STREAM,
        consumer: configConsumerName("rig-a"),
        subjects: configSubjects("rig-a"),
      },
    ]);
    assert.deepEqual(configSubjects("rig-a"), [
      "thermite.rig.rig-a.config.model-route",
      "thermite.rig.rig-a.config.advisor-routes",
      "thermite.rig.rig-a.config.mcp-servers",
    ]);
    assert.equal(s.h.route.revision, "r1");
  });

  test("a new route is handed to the harness at once; the same revision again does nothing", async () => {
    const s = setup();
    const said: string[] = [];
    const out = process.stdout.write;
    process.stdout.write = ((chunk: string) => said.push(chunk) > 0) as typeof process.stdout.write;
    try {
      await takeConfig(
        s.watch,
        message("model-route", { route: route("r1"), planner: null }, "a".repeat(32)),
      );
    } finally {
      process.stdout.write = out;
    }
    assert.deepEqual(s.h.route, { source: "control", revision: "r1" });
    assert.equal(s.h.puts.length, 1);
    // The log names the key and its revision, never the key's value.
    assert.match(said.join(""), /config taken from the bus/);
    assert.ok(!said.join("").includes("made-up-key-one"));
    // Watching starts again: the latest of each key comes again, and is passed over.
    await takeConfig(
      s.watch,
      message("model-route", { route: route("r1"), planner: null }, "a".repeat(32)),
    );
    assert.equal(s.h.puts.length, 1);
    // Control clears the route: the agents go back to the rig's own settings.
    await takeConfig(
      s.watch,
      message("model-route", { route: null, planner: null }, "b".repeat(32)),
    );
    assert.deepEqual(s.h.route, { source: "environment" });
    assert.deepEqual(s.counts.figures(), {
      taken: 2,
      refused: 0,
      subjects: { "thermite.rig.rig-a.config.model-route": { taken: 2, refused: 0 } },
    });
  });

  test("the MCP servers go to the harness, its workers' and planner's share, and to the advisors", async () => {
    const s = setup();
    const given = {
      servers: [
        server("docs", ["workers"]),
        server("notes", ["advisors"]),
        server("both", ["planner", "advisors"]),
      ],
      unavailable: [{ name: "gone", why: "Settings has no MCP server of that name now" }],
    };
    await takeConfig(s.watch, message("mcp-servers", given, "c".repeat(32)));
    assert.deepEqual(
      s.h.servers.servers.map((x) => x.name),
      ["docs", "both"],
    );
    assert.deepEqual(s.advisorMcp, [
      { servers: ["notes", "both"], unavailable: given.unavailable },
    ]);
  });

  test("the advisors' routes are kept for their next round; nothing goes to the harness", async () => {
    const s = setup();
    const advisors = {
      teacher_models: [],
      merged_by: null,
      auditor: route("r9"),
      review_panel: null,
    };
    await takeConfig(s.watch, message("advisor-routes", advisors, "d".repeat(32)));
    assert.equal(s.known.get("advisor-routes")?.auditor?.model, "m-1");
    assert.equal(s.known.revision("advisor-routes"), "d".repeat(32));
    assert.equal(s.h.puts.length, 0);
  });

  test("a message it can't take is counted, and the value it knows stays (owner's decision 6)", async () => {
    const s = setup();
    await takeConfig(
      s.watch,
      message("model-route", { route: route("r1"), planner: null }, "a".repeat(32)),
    );
    const other = newSealKey();
    const bad: BusMessage[] = [
      message(
        "model-route",
        { route: route("r2"), planner: null },
        "e".repeat(32),
        other.publicKey,
      ),
      message("later", { anything: true }, "f".repeat(32)),
      {
        ...message("model-route", {}, "0".repeat(32)),
        data: new TextEncoder().encode("{not json"),
      },
      message("model-route", { route: { name: 7 } }, "1".repeat(32)),
    ];
    for (const m of bad) assert.equal(await takeConfig(s.watch, m), undefined, "acked");
    assert.equal(s.known.revision("model-route"), "a".repeat(32));
    assert.deepEqual(s.h.route, { source: "control", revision: "r1" });
    const f = s.counts.figures();
    assert.equal(f.taken, 1);
    assert.equal(f.refused, 4);
    assert.deepEqual(f.subjects["thermite.rig.rig-a.config.later"], { taken: 0, refused: 1 });
  });

  test("a value the harness can't take now stays known, and the next look hands it over", async () => {
    const s = setup();
    s.h.away = true;
    await takeConfig(
      s.watch,
      message("model-route", { route: route("r1"), planner: null }, "a".repeat(32)),
    );
    assert.equal(s.known.revision("model-route"), "a".repeat(32));
    assert.equal(s.h.puts.length, 0);
    s.h.away = false;
    let looks = 0;
    await keepConfig({ ...s.keep, stopping: () => looks++ > 0 });
    assert.deepEqual(s.h.route, { source: "control", revision: "r1" });
  });

  test("a harness that restarted gets its MCP servers again at the next look, without control", async () => {
    const s = setup();
    await takeConfig(
      s.watch,
      message("mcp-servers", { servers: [server("docs", ["workers"])] }, "c".repeat(32)),
    );
    // The harness restarted: it holds no server now.
    s.h.servers = { servers: [], unavailable: [] };
    let looks = 0;
    await keepConfig({ ...s.keep, stopping: () => looks++ > 0 });
    assert.deepEqual(
      s.h.servers.servers.map((x) => x.name),
      ["docs"],
    );
    // Nothing changed since: the next look hands nothing.
    const puts = s.h.puts.length;
    looks = 0;
    await keepConfig({ ...s.keep, stopping: () => looks++ > 0 });
    assert.equal(s.h.puts.length, puts);
  });
});

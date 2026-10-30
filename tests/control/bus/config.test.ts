import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import {
  ConfigWriter,
  ConfigWritten,
  takeRigBusKey,
  takeRigSealKey,
} from "../../../src/control/bus/index.ts";
import type { McpServers } from "../../../src/control/mcp-servers/index.ts";
import { ChatGPTLogins } from "../../../src/control/providers/index.ts";
import { STEP_WORDS } from "../../../src/control/rigs/setup.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import {
  CONFIG_STREAM,
  CONFIG_STREAM_CONFIG,
  ConfigMessage,
  newSealKey,
  openConfig,
  type SealKey,
  sealKeyFingerprint,
} from "../../../src/core/link/config.ts";
import type { McpConnection, McpUnavailable } from "../../../src/core/mcp.ts";
import { controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";
import { enrollRigs } from "../../helpers/control-store.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * Control's side of each rig's config on the message bus (goal 168, step 3): every rig with a seal
 * key gets its model route, its advisors' routes and its MCP servers, each key sealed to it and
 * written only when its value changes; and the seal key, registered on the supervisor's call.
 */

type Mcp = { servers: McpConnection[]; unavailable: McpUnavailable[] };

/** The MCP servers as control gives them, set by the test, with what was audited as handed. */
class FakeMcp {
  given: Mcp = { servers: [], unavailable: [] };
  readonly handed: { rig: string; names: string[] }[] = [];
  forRig = async () => this.given;
  handed_ = (rig: string, r: Mcp) => this.handed.push({ rig, names: r.servers.map((s) => s.name) });
}

/** A store with rig-a and rig-b known, each with its keys on the bus, and the parts the writer uses. */
function setup(
  o: { store?: ControlStore; secrets?: SecretBox; seals?: Record<string, SealKey> } = {},
) {
  const store = o.store ?? new ControlStore(":memory:");
  enrollRigs(store, ["rig-a", "rig-b"]);
  const secrets = o.secrets ?? SecretBox.ephemeral();
  const seals = o.seals ?? { "rig-a": newSealKey(), "rig-b": newSealKey() };
  for (const [rig, seal] of Object.entries(seals)) {
    takeRigBusKey(store, rig, createUser().getPublicKey());
    takeRigSealKey(store, rig, seal.publicKey);
  }
  const mcp = new FakeMcp();
  const mcpServers = { forRig: mcp.forRig, handed: mcp.handed_ } as unknown as McpServers;
  const parts = { store, secrets, chatgpt: new ChatGPTLogins(store, secrets), mcpServers };
  const bus = new FakeBus();
  const figures = new ConfigWritten();
  const writer = new ConfigWriter({ parts, bus, figures });
  /** A rig's model, from a provider whose key is `key`. */
  const giveModel = (rig: string, key = "made-up-key-one") => {
    store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: secrets.seal(key), hint: "…-one" },
    });
    store.modelProviders.setModels("lab", [{ id: "m-1" }]);
    store.agentModels.assignRig(rig, { provider: "lab", model: "m-1" });
  };
  /** What the bus holds on a rig's key, newest last, opened with the rig's seal key now. */
  const values = (rig: string, key: string) =>
    bus.on(`thermite.rig.${rig}.config.${key}`).map((m) => {
      const msg = ConfigMessage.parse(JSON.parse(m.data));
      return { ...msg, value: openConfig(rig, key, msg.sealed, seals[rig]?.privatePem ?? "") };
    });
  return { store, secrets, seals, mcp, bus, figures, writer, giveModel, values };
}

describe("each rig's config on the message bus", () => {
  test("nothing is written before the bucket's stream is made", async () => {
    const s = setup();
    await s.writer.write();
    assert.equal(s.bus.kept.length, 0);
    await s.writer.start();
    assert.deepEqual(s.bus.made.get(CONFIG_STREAM), CONFIG_STREAM_CONFIG);
  });

  test("each rig gets each key, sealed to its own seal key, and only once while nothing changes", async (t) => {
    const s = setup();
    s.giveModel("rig-a");
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    await s.writer.start();
    await s.writer.write();
    t.mock.restoreAll();
    // The log says what was written, by rig, key and revision: never a value.
    assert.equal(said.join("").match(/a rig's config written to the bus/g)?.length, 6);
    assert.ok(!said.join("").includes("made-up-key-one"));
    for (const rig of ["rig-a", "rig-b"])
      for (const key of ["model-route", "advisor-routes", "mcp-servers"])
        assert.equal(s.values(rig, key).length, 1, `${rig} ${key}`);
    const [route] = s.values("rig-a", "model-route");
    const value = route?.value as { route: { model: string; api_key: string }; planner: null };
    assert.equal(value.route.model, "m-1");
    assert.equal(value.route.api_key, "made-up-key-one");
    assert.equal(value.planner, null);
    assert.deepEqual(s.values("rig-b", "model-route")[0]?.value, { route: null, planner: null });
    // Nothing of a secret is in the clear: not in the message, its id or its headers.
    for (const m of s.bus.kept) assert.ok(!JSON.stringify(m).includes("made-up-key-one"));
    // rig-b's seal key opens none of rig-a's values.
    const sealed = route?.sealed ?? "";
    assert.throws(() =>
      openConfig("rig-a", "model-route", sealed, s.seals["rig-b"]?.privatePem ?? ""),
    );
    assert.deepEqual(s.figures.written, {
      "model-route": 2,
      "advisor-routes": 2,
      "mcp-servers": 2,
    });
    assert.equal(s.figures.rigs.get("rig-a"), 3);
    // A second look, a third: nothing changed, nothing written.
    await s.writer.write();
    await s.writer.write();
    assert.equal(s.bus.kept.length, 6);
  });

  test("a change rewrites only its key: the route's key, then the MCP servers, then the seal key", async () => {
    const s = setup();
    s.giveModel("rig-a");
    await s.writer.start();
    await s.writer.write();
    s.giveModel("rig-a", "made-up-key-two");
    await s.writer.write();
    const routes = s.values("rig-a", "model-route");
    assert.equal(routes.length, 2);
    assert.notEqual(routes[0]?.revision, routes[1]?.revision);
    const second = routes[1]?.value as { route: { api_key: string } } | undefined;
    assert.equal(second?.route.api_key, "made-up-key-two");
    assert.equal(s.values("rig-a", "advisor-routes").length, 1);
    assert.equal(s.values("rig-a", "mcp-servers").length, 1);
    // The MCP servers change: both rigs get the new list, and the handing is audited.
    s.mcp.given = {
      servers: [
        {
          name: "docs",
          url: "https://mcp.example.com/",
          headers: { authorization: "Bearer made-up" },
          revision: "0123456789abcdef",
          agents: ["workers"],
        },
      ],
      unavailable: [],
    };
    await s.writer.write();
    assert.equal(s.values("rig-a", "mcp-servers").length, 2);
    assert.equal(s.values("rig-a", "model-route").length, 2);
    assert.deepEqual(s.mcp.handed.at(-1), { rig: "rig-b", names: ["docs"] });
    // A new seal key: every key of that rig is sealed again, to it alone.
    const fresh = newSealKey();
    s.seals["rig-b"] = fresh;
    assert.equal(takeRigSealKey(s.store, "rig-b", fresh.publicKey), "changed");
    await s.writer.write();
    const count = (rig: string, key: string) =>
      s.bus.on(`thermite.rig.${rig}.config.${key}`).length;
    assert.equal(count("rig-b", "model-route"), 2);
    assert.equal(count("rig-b", "mcp-servers"), 3);
    const last = s.bus.on("thermite.rig.rig-b.config.model-route").at(-1);
    const sealed = ConfigMessage.parse(JSON.parse(last?.data ?? "{}")).sealed;
    assert.deepEqual(openConfig("rig-b", "model-route", sealed, fresh.privatePem), {
      route: null,
      planner: null,
    });
    assert.equal(count("rig-a", "model-route"), 2, "rig-a's are left as they were");
  });

  test("control started again reads the revisions back, and writes nothing that did not change", async () => {
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    const seals = { "rig-a": newSealKey() };
    const one = setup({ store, secrets, seals });
    one.giveModel("rig-a");
    await one.writer.start();
    await one.writer.write();
    assert.equal(one.bus.kept.length, 3);
    const mcpServers = { forRig: one.mcp.forRig, handed: one.mcp.handed_ } as unknown as McpServers;
    const writer = (box: SecretBox) =>
      new ConfigWriter({
        parts: { store, secrets: box, chatgpt: new ChatGPTLogins(store, secrets), mcpServers },
        bus: one.bus,
        figures: new ConfigWritten(),
      });
    // A new writer on the same bus: as after control's restart.
    const again = writer(secrets);
    await again.start();
    await again.write();
    assert.equal(one.bus.kept.length, 3);
    // With another secrets key, the revisions differ: each key is written again.
    const other = writer(SecretBox.ephemeral());
    await other.start();
    await other.write();
    // The route's key does not open with it: that value is not written, and the rig keeps it.
    assert.equal(one.bus.kept.length, 5);
  });

  test("a rig without a seal key, a retired rig and an unknown rig get nothing", async () => {
    const s = setup({ seals: { "rig-a": newSealKey() } });
    takeRigBusKey(s.store, "rig-b", createUser().getPublicKey());
    takeRigBusKey(s.store, "rig-c", createUser().getPublicKey());
    takeRigSealKey(s.store, "rig-c", newSealKey().publicKey);
    await s.writer.start();
    s.store.retired.add("rig-a", "owner");
    await s.writer.write();
    assert.equal(s.bus.kept.length, 0);
    // Enrolled again, it is back, and gets its config.
    enrollRigs(s.store, ["rig-a"]);
    await s.writer.write();
    assert.deepEqual([...new Set(s.bus.kept.map((m) => m.subject.split(".")[2]))], ["rig-a"]);
  });

  test("a value control can't make is not written: the rig keeps the one it has", async () => {
    const s = setup({ seals: { "rig-a": newSealKey() } });
    s.giveModel("rig-a");
    await s.writer.start();
    await s.writer.write();
    // The provider's key no longer opens, as after the secrets key was replaced.
    s.store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: SecretBox.ephemeral().seal("made-up-key-three"), hint: "…hree" },
    });
    await s.writer.write();
    await s.writer.write();
    assert.equal(s.values("rig-a", "model-route").length, 1);
    assert.equal(s.figures.notMade, 2);
  });

  test("a write the bus does not take is tried again at the next look", async () => {
    const s = setup({ seals: { "rig-a": newSealKey() } });
    await s.writer.start();
    s.bus.failing = true;
    await s.writer.write();
    assert.equal(s.figures.failed, 3, "each key's read back failed");
    s.bus.failing = false;
    await s.writer.write();
    assert.equal(s.bus.kept.length, 3);
    assert.equal(s.figures.written["model-route"], 1);
  });

  test("after a write the bus refused, the stream is made again and every key read back", async () => {
    const s = setup({ seals: { "rig-a": newSealKey() } });
    await s.writer.start();
    await s.writer.write();
    assert.equal(s.bus.kept.length, 3);
    // The bus lost its store: its stream, every value and the ids it had seen with it.
    s.bus.made.clear();
    s.bus.kept.length = 0;
    s.bus.forgetIds();
    s.giveModel("rig-a");
    await s.writer.write();
    assert.equal(s.figures.failed, 1, "the changed route's write");
    assert.deepEqual(s.bus.made.get(CONFIG_STREAM), CONFIG_STREAM_CONFIG, "made again");
    await s.writer.write();
    assert.deepEqual(s.bus.kept.map((m) => m.subject.split(".").at(-1)).sort(), [
      "advisor-routes",
      "mcp-servers",
      "model-route",
    ]);
  });

  test("a value too large for a message is not written, and counted once while it stays", async () => {
    const s = setup({ seals: { "rig-a": newSealKey() } });
    s.mcp.given = {
      servers: Array.from({ length: 50 }, (_, i) => ({
        name: `big-${i}`,
        url: "https://mcp.example.com/",
        headers: { authorization: "x".repeat(16_384) },
        revision: "0123456789abcdef",
        agents: ["workers" as const],
      })),
      unavailable: [],
    };
    await s.writer.start();
    await s.writer.write();
    await s.writer.write();
    assert.equal(s.values("rig-a", "mcp-servers").length, 0);
    assert.equal(s.values("rig-a", "model-route").length, 1);
    assert.equal(s.figures.tooLarge, 1);
  });
});

describe("a rig's seal key on the supervisor's call", () => {
  const RIG_B_TOKEN = "rig-b-token-abcdef";
  function setupRoute() {
    const s = controlOnly({ tokens: { rigs: { "rig-a": RIG_TOKEN, "rig-b": RIG_B_TOKEN } } });
    const figures = (body: Record<string, unknown>) =>
      s.control.request("/v1/rigs/rig-a/supervisor", {
        method: "POST",
        headers: { authorization: `Bearer ${RIG_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ at: new Date().toISOString(), ...body }),
      });
    const audits = (action: string) => s.store.auditLog.list(50, { action }).map((e) => e.body);
    return { ...s, figures, audits };
  }

  test("is recorded with the rig's key, audited and in the rig's history by its fingerprint", async () => {
    const s = setupRoute();
    const busKey = createUser().getPublicKey();
    const seal = newSealKey();
    assert.equal((await s.figures({ bus_key: busKey, bus_seal_key: seal.publicKey })).status, 200);
    assert.equal(s.store.busKeys.rigSealKey("rig-a"), seal.publicKey);
    const fp = sealKeyFingerprint(seal.publicKey);
    assert.deepEqual(s.audits("rig_seal_key_registered"), [{ fingerprint: fp }]);
    // The same key again changes nothing; a new one is a change, with both fingerprints.
    assert.equal((await s.figures({ bus_key: busKey, bus_seal_key: seal.publicKey })).status, 200);
    const next = newSealKey();
    assert.equal((await s.figures({ bus_key: busKey, bus_seal_key: next.publicKey })).status, 200);
    assert.deepEqual(s.audits("rig_seal_key_changed"), [
      { fingerprint: sealKeyFingerprint(next.publicKey), previous: fp },
    ]);
    const steps = s.store.rigHistory
      .list("rig-a")
      .filter((h) => h.step.startsWith("seal_key"))
      .map((h) => [h.step, h.detail]);
    assert.deepEqual(steps, [
      ["seal_key", `fingerprint ${fp}`],
      ["seal_key_changed", `fingerprint ${fp} → ${sealKeyFingerprint(next.publicKey)}`],
    ]);
    assert.equal(
      STEP_WORDS.seal_key_changed,
      "Its seal key for its config on the message bus changed",
    );
    // The key is kept apart from the figures, which pages show.
    assert.equal("bus_seal_key" in (s.store.reportedRigs.supervisor("rig-a") ?? {}), false);
  });

  test("once a rig registered its seal key, the HTTP config routes refuse it in words; a rig without one gets them", async () => {
    const s = setupRoute();
    const get = (rig: string, token: string, path: string) =>
      s.control.request(`/v1/rigs/${rig}/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const paths = ["model-route", "advisor-routes", "mcp-servers"];
    for (const path of paths) assert.equal((await get("rig-a", RIG_TOKEN, path)).status, 200, path);
    const busKey = createUser().getPublicKey();
    const seal = newSealKey().publicKey;
    assert.equal((await s.figures({ bus_key: busKey, bus_seal_key: seal })).status, 200);
    for (const path of paths) {
      const r = await get("rig-a", RIG_TOKEN, path);
      assert.equal(r.status, 409, path);
      assert.deepEqual(await r.json(), {
        error:
          "rig-a is on the message bus: control gives it its model routes, MCP servers and advisors' routes only in its config there, sealed to its key, never over HTTP. Its supervisor reads them from the bus (THERMITE_NATS_URL).",
      });
      assert.equal((await get("rig-b", RIG_B_TOKEN, path)).status, 200, `rig-b's ${path}`);
    }
  });

  test("a value that is not a seal key, or one without the rig's key, is refused whole", async () => {
    const s = setupRoute();
    const busKey = createUser().getPublicKey();
    const bad = await s.figures({ bus_key: busKey, bus_seal_key: busKey });
    assert.equal(bad.status, 400);
    assert.match(
      await bad.text(),
      /bus_seal_key is not an X25519 public key: base64 of its DER form, on one line/,
    );
    const alone = await s.figures({ bus_seal_key: newSealKey().publicKey });
    assert.equal(alone.status, 400);
    assert.match(await alone.text(), /bus_seal_key comes only with bus_key/);
    assert.equal(s.store.busKeys.rigKey("rig-a"), undefined);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import { RIG_CONSUMERS_LOOK_AGAIN_MS, RigConsumers } from "../../../src/control/bus/consumers.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { COMMAND_STREAM_CONFIG, commandConsumerConfig } from "../../../src/core/link/commands.ts";
import { CONFIG_STREAM_CONFIG, configConsumerConfig } from "../../../src/core/link/config.ts";
import { enrollRigs } from "../../helpers/control-store.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * Each rig's consumers of its commands and its config (goal 168): control makes them, with their
 * settings, for every rig with a user on the bus, since the rig's user may make none.
 */

function setup() {
  const store = new ControlStore(":memory:");
  enrollRigs(store, ["rig-a", "rig-b"]);
  const bus = new FakeBus();
  let now = 1_000_000;
  const consumers = new RigConsumers({ store, bus, clock: () => now });
  return { store, bus, consumers, later: (ms: number) => (now += ms) };
}

describe("control makes each rig's consumers on the bus", () => {
  test("a rig with a user gets its two, with control's settings; a rig with none gets none", async () => {
    const s = setup();
    await s.bus.makeStream(COMMAND_STREAM_CONFIG);
    await s.bus.makeStream(CONFIG_STREAM_CONFIG);
    s.store.busKeys.setRigKey("rig-a", createUser().getPublicKey());
    await s.consumers.make();
    assert.deepEqual(Object.fromEntries(s.bus.consumers), {
      "COMMANDS.rig-rig-a-commands": commandConsumerConfig("rig-a"),
      "CONFIG.rig-rig-a-config": configConsumerConfig("rig-a"),
    });
    // A retired rig has no user: nothing more is made for it.
    s.store.busKeys.setRigKey("rig-b", createUser().getPublicKey());
    s.store.retired.add("rig-b", "owner:test");
    await s.consumers.make();
    assert.equal(s.bus.consumers.size, 2);
  });

  test("before the streams are made, nothing is made and nothing throws; the next round makes them", async () => {
    const s = setup();
    s.store.busKeys.setRigKey("rig-a", createUser().getPublicKey());
    await s.consumers.make();
    assert.equal(s.bus.consumers.size, 0);
    await s.bus.makeStream(COMMAND_STREAM_CONFIG);
    await s.bus.makeStream(CONFIG_STREAM_CONFIG);
    await s.consumers.make();
    assert.equal(s.bus.consumers.size, 2);
  });

  test("a consumer lost is made again once control looks at every rig's again", async () => {
    const s = setup();
    await s.bus.makeStream(COMMAND_STREAM_CONFIG);
    await s.bus.makeStream(CONFIG_STREAM_CONFIG);
    s.store.busKeys.setRigKey("rig-a", createUser().getPublicKey());
    await s.consumers.make();
    s.bus.consumers.delete("COMMANDS.rig-rig-a-commands");
    await s.consumers.make();
    assert.equal(s.bus.consumers.size, 1, "made already: not looked at again yet");
    s.later(RIG_CONSUMERS_LOOK_AGAIN_MS);
    await s.consumers.make();
    assert.equal(s.bus.consumers.size, 2);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import { takeRigBusKey, takeRigSealKey } from "../../../src/control/bus/index.ts";
import { type ControlStore, openControlStore } from "../../../src/control/store/index.ts";
import { newSealKey, sealKeyFingerprint } from "../../../src/core/link/config.ts";
import { userKeyFingerprint } from "../../../src/core/link/users.ts";
import { controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";
import {
  DROPPED,
  HELD,
  seen,
  WRITE_FAILED,
  watched,
  withAnotherCaller,
  withTurns,
  withWriteFailing,
} from "../../helpers/together.ts";

/**
 * The transactions of the rigs' keys on the message bus: a key, its entry in the audit log and
 * its step in the rig's history (control/bus/users.ts, control/bus/config.ts); and a
 * registration's look for another holder with what it takes (control/api/supervisor.ts).
 */

const RIG_B_TOKEN = "rig-b-token-abcdef";
const user = () => createUser().getPublicKey();
const seal = () => newSealKey().publicKey;

const audits = async (store: ControlStore, action: string) =>
  (await store.auditLog.list(50, { action })).map((e) => e.body);

const steps = async (store: ControlStore, rig: string, step: string) =>
  (await store.rigHistory.list(rig)).filter((e) => e.step === step).map((e) => e.detail);

/** Control with two rigs, and each rig's supervisor's and runners' registrations. */
async function setup() {
  const s = await controlOnly({
    tokens: { rigs: { "rig-a": RIG_TOKEN, "rig-b": RIG_B_TOKEN } },
  });
  const post = async (path: string, rig: string, body: unknown) =>
    await s.control.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rig === "rig-a" ? RIG_TOKEN : RIG_B_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const register = (rig: string, busKey: string, sealKey: string) =>
    post(`/v1/rigs/${rig}/supervisor`, rig, {
      at: new Date().toISOString(),
      bus_key: busKey,
      bus_seal_key: sealKey,
    });
  const runner = (rig: string, name: string, key: string) =>
    post(`/v1/rigs/${rig}/runners/${name}/supervisor`, rig, { bus_key: key });
  return { ...s, register, runner };
}

describe("a rig's key on the bus, its audit entry and its step in the history", () => {
  test("takeRigBusKey: a first key, and a changed one", async () => {
    const store = openControlStore(":memory:");
    const [first, second] = [user(), user()];
    const dropped = await withWriteFailing(store, store.rigHistory, "add", () =>
      takeRigBusKey(store, "rig-a", first),
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await store.busKeys.rigKey("rig-a"), undefined, "no key with no step");
    assert.deepEqual(await audits(store, "rig_bus_key_registered"), []);

    const kept = await watched(store, () => takeRigBusKey(store, "rig-a", first));
    assert.equal(kept.out, "new");
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["audit", "rig_bus_key", "rig_setup_event"] },
    ]);
    assert.equal(await store.busKeys.rigKey("rig-a"), first);
    const fp = userKeyFingerprint(first);
    assert.deepEqual(await audits(store, "rig_bus_key_registered"), [{ fingerprint: fp }]);
    assert.deepEqual(await steps(store, "rig-a", "bus_key"), [`fingerprint ${fp}`]);

    // Another key: the audit entry fails, and the rig keeps the key it had.
    const changedDropped = await withWriteFailing(store, store.auditLog, "add", () =>
      takeRigBusKey(store, "rig-a", second),
    );
    assert.equal(changedDropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(changedDropped), DROPPED);
    assert.equal(await store.busKeys.rigKey("rig-a"), first);
    assert.deepEqual(await steps(store, "rig-a", "bus_key_changed"), []);

    const changed = await watched(store, () => takeRigBusKey(store, "rig-a", second));
    assert.equal(changed.out, "changed");
    assert.equal(await store.busKeys.rigKey("rig-a"), second);
    const next = userKeyFingerprint(second);
    assert.deepEqual(await audits(store, "rig_bus_key_changed"), [
      { fingerprint: next, previous: fp },
    ]);
    assert.deepEqual(await steps(store, "rig-a", "bus_key_changed"), [
      `fingerprint ${fp} → ${next}`,
    ]);
    await store.close();
  });

  test("takeRigSealKey: a first key, and a changed one", async () => {
    const store = openControlStore(":memory:");
    const [first, second] = [seal(), seal()];
    await takeRigBusKey(store, "rig-a", user());
    const dropped = await withWriteFailing(store, store.rigHistory, "add", () =>
      takeRigSealKey(store, "rig-a", first),
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await store.busKeys.rigSealKey("rig-a"), undefined, "no key with no step");
    assert.deepEqual(await audits(store, "rig_seal_key_registered"), []);

    const kept = await watched(store, () => takeRigSealKey(store, "rig-a", first));
    assert.equal(kept.out, "new");
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["audit", "rig_bus_key", "rig_setup_event"] },
    ]);
    assert.equal(await store.busKeys.rigSealKey("rig-a"), first);
    const fp = sealKeyFingerprint(first);
    assert.deepEqual(await audits(store, "rig_seal_key_registered"), [{ fingerprint: fp }]);
    assert.deepEqual(await steps(store, "rig-a", "seal_key"), [`fingerprint ${fp}`]);

    const changedDropped = await withWriteFailing(store, store.auditLog, "add", () =>
      takeRigSealKey(store, "rig-a", second),
    );
    assert.equal(changedDropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(changedDropped), DROPPED);
    assert.equal(await store.busKeys.rigSealKey("rig-a"), first);

    const changed = await watched(store, () => takeRigSealKey(store, "rig-a", second));
    assert.equal(changed.out, "changed");
    assert.equal(await store.busKeys.rigSealKey("rig-a"), second);
    const next = sealKeyFingerprint(second);
    assert.deepEqual(await audits(store, "rig_seal_key_changed"), [
      { fingerprint: next, previous: fp },
    ]);
    assert.deepEqual(await steps(store, "rig-a", "seal_key_changed"), [
      `fingerprint ${fp} → ${next}`,
    ]);
    await store.close();
  });
});

describe("a supervisor's registration of its keys", () => {
  test("supervisorRoutes, a rig's registration: its figures, its step and its key", async () => {
    const s = await setup();
    const { store } = s;
    const [busKey, sealKey] = [user(), seal()];
    // The key's write fails after the figures and the registration's step were written.
    const dropped = await withWriteFailing(store, store.busKeys, "setRigKey", () =>
      s.register("rig-a", busKey, sealKey),
    );
    assert.equal(dropped.out?.status, 500);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await store.reportedRigs.supervisor("rig-a"), null, "no figures kept");
    assert.deepEqual(await steps(store, "rig-a", "bus_registered"), []);
    assert.equal(await store.busKeys.rigKey("rig-a"), undefined);
    // The failed request is in the audit log, written after the transaction, outside it.
    assert.equal((await audits(store, "failed")).length, 1);

    const kept = await watched(store, () => s.register("rig-a", busKey, sealKey));
    assert.equal(kept.out?.status, 200);
    // The registration's transaction, then the seal key's own, once the bus has the user's key.
    assert.deepEqual(seen(kept), [
      {
        failed: false,
        changed: ["audit", "rig", "rig_bus_key", "rig_setup_event"],
      },
      { failed: false, changed: ["audit", "rig_bus_key", "rig_setup_event"] },
    ]);
    assert.ok(await store.reportedRigs.supervisor("rig-a"), "the figures");
    assert.equal((await steps(store, "rig-a", "bus_registered")).length, 1);
    assert.equal(await store.busKeys.rigKey("rig-a"), busKey);
    assert.equal(await store.busKeys.rigSealKey("rig-a"), sealKey);
  });

  test("supervisorRoutes, a rig's registration: the look for another holder and the take are one piece", async () => {
    await withTurns(async () => {
      const s = await setup();
      const { store } = s;
      const busKey = user();
      // While rig-a's registration is open, with the look for the key's holder made, rig-b
      // registers the same key: it waits, finds rig-a holds the key, and is refused.
      let second: Response | undefined;
      const held = await withAnotherCaller(
        store,
        store.busKeys,
        "holderOf",
        () => s.register("rig-a", busKey, seal()),
        async () => {
          second = await s.register("rig-b", busKey, seal());
        },
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(held.out.status, 200);
      assert.equal(second?.status, 409);
      assert.equal(await store.busKeys.rigKey("rig-a"), busKey);
      assert.equal(await store.busKeys.rigKey("rig-b"), undefined, "one rig holds the key");
    });
  });

  test("supervisorRoutes, a runner's registration: its key and its step in the rig's history", async () => {
    const s = await setup();
    const { store } = s;
    const key = user();
    const dropped = await withWriteFailing(store, store.rigHistory, "add", () =>
      s.runner("rig-a", "runner-1", key),
    );
    assert.equal(dropped.out?.status, 500);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await store.busKeys.runnerKey("rig-a", "runner-1"), undefined);
    assert.deepEqual(await steps(store, "rig-a", "runner_bus_key"), []);

    const kept = await watched(store, () => s.runner("rig-a", "runner-1", key));
    assert.equal(kept.out?.status, 200);
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["rig_setup_event", "runner_bus_key"] },
    ]);
    assert.equal(await store.busKeys.runnerKey("rig-a", "runner-1"), key);
    assert.deepEqual(await steps(store, "rig-a", "runner_bus_key"), [
      `runner-1: ${userKeyFingerprint(key)}`,
    ]);
  });

  test("supervisorRoutes, a runner's registration: the look for another holder and the take are one piece", async () => {
    await withTurns(async () => {
      const s = await setup();
      const { store } = s;
      const key = user();
      // While runner-1's registration is open, with the look for the key's holder made, runner-2
      // of another rig registers the same key: it waits, and is refused.
      let second: Response | undefined;
      const held = await withAnotherCaller(
        store,
        store.busKeys,
        "holderOf",
        () => s.runner("rig-a", "runner-1", key),
        async () => {
          second = await s.runner("rig-b", "runner-2", key);
        },
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(held.out.status, 200);
      assert.equal(second?.status, 409);
      assert.deepEqual(await store.busKeys.runnerKeys(), [
        { rig: "rig-a", runner: "runner-1", key },
      ]);
    });
  });
});

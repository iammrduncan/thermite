import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunpodRigs } from "../../../src/control/runpod/rigs.ts";
import { RunpodTests } from "../../../src/control/runpod/tests.ts";
import { ControlTunnels } from "../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { TEST_BUS_CA } from "../../helpers/bus-ca.ts";
import { controlStore } from "../../helpers/control-store.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod } from "../../helpers/fake-runpod.ts";
import { DROPPED, seen, WRITE_FAILED, watched, withWriteFailing } from "../../helpers/together.ts";

/**
 * The transactions of control's pods on RunPod (control/runpod/): a test ended by hand, and a
 * rig's limits, each read, changed and saved whole with its entry in the audit log. RunPod is the
 * fake one (tests/helpers/fake-runpod.ts).
 */

const IMAGE = "ghcr.io/example/thermite-rig:test-cuda";

/** A store with the GPU cloud `runpod`, and the fake RunPod behind it. */
async function setup() {
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  await store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  return { store, secrets, cloud: fakeRunpod() };
}

const audits = async (store: ControlStore, action: string) =>
  (await store.auditLog.list(20, { action })).map((e) => e.body as Record<string, unknown>);

describe("control's pods on RunPod", () => {
  test("RunpodTests.end: the test set to ending and its audit entry", async () => {
    const { store, secrets, cloud } = await setup();
    const tests = new RunpodTests(store, secrets, { fetch: cloud.fetch, image: IMAGE });
    const started = await tests.start("runpod", {}, "owner:ui");
    const stored = async () => {
      const t = await store.runpod.test(started.id);
      return { active: t?.active, ...(t?.state as { phase: string; notes: string[] }) };
    };
    const before = await stored();
    assert.equal(before.active, true);
    const end = () => tests.end(started.id, "owner:ui");
    const dropped = await withWriteFailing(
      store,
      store.auditLog,
      "add",
      end,
      (_by, action) => action === "runpod_test_ended",
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await stored(), before, "the test is as it was, not ending");
    assert.deepEqual(await audits(store, "runpod_test_ended"), []);
    assert.deepEqual(cloud.terminated(), [], "its pod stays: the step after did not run");

    const kept = await watched(store, end);
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["audit", "runpod_test", "sqlite_sequence"] },
    ]);
    const after = kept.txs[0]?.after.runpod_test as { id: string; state: string }[];
    const saved = JSON.parse(String(after.find((r) => r.id === started.id)?.state)) as {
      phase: string;
      notes: string[];
    };
    assert.equal(saved.phase, "ending");
    assert.equal(saved.notes.length, 1);
    assert.match(String(saved.notes[0]), /^Ended by owner:ui while .+\.$/);
    assert.deepEqual(await audits(store, "runpod_test_ended"), [
      { id: started.id, cloud: "runpod" },
    ]);
    // The step after the transaction removed the pod.
    assert.equal(cloud.terminated().length, 1);
  });

  test("RunpodRigs.limits: the rig's limits and their audit entry", async () => {
    const { store, secrets, cloud } = await setup();
    const control = generateSigningKeys();
    const tunnels = new ControlTunnels(store, secrets, control.privateKeyPem, {
      busCa: TEST_BUS_CA,
    });
    const rigs = new RunpodRigs(store, secrets, tunnels, {
      fetch: cloud.fetch,
      image: IMAGE,
      privateKeyPem: control.privateKeyPem,
    });
    const v = await rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const limitsOf = async () => {
      const s = (await store.runpod.rig(v.rig))?.state as {
        spend_limit_usd: number | null;
        idle_stop_minutes: number | null;
      };
      return [s.spend_limit_usd, s.idle_stop_minutes];
    };
    const before = await limitsOf();
    const set = () =>
      rigs.limits(v.rig, { spend_limit_usd: 5, idle_stop_minutes: 45 }, "owner:api");
    const dropped = await withWriteFailing(
      store,
      store.auditLog,
      "add",
      set,
      (_by, action) => action === "runpod_rig_limits",
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await limitsOf(), before, "the limits are as they were");
    assert.deepEqual(await audits(store, "runpod_rig_limits"), []);

    const kept = await watched(store, set);
    assert.equal(kept.threw, undefined);
    assert.equal(kept.txs.length, 1);
    assert.equal(kept.txs[0]?.failed, false);
    for (const table of ["audit", "runpod_rig"])
      assert.ok(kept.txs[0]?.changed.includes(table), `${table}: ${kept.txs[0]?.changed}`);
    assert.deepEqual(await limitsOf(), [5, 45]);
    assert.deepEqual(await audits(store, "runpod_rig_limits"), [
      { rig: v.rig, spend_limit_usd: 5, idle_stop_minutes: 45 },
    ]);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createPolicy,
  deletePolicy,
  runPolicy,
  setPolicyOn,
  updatePolicy,
} from "../../../src/control/retention/index.ts";
import { writeBehind } from "../../../src/control/store/behind.ts";
import { type ControlStore, openControlStore } from "../../../src/control/store/index.ts";
import { DROPPED, seen, WRITE_FAILED, watched, withWriteFailing } from "../../helpers/together.ts";

/**
 * The transactions of the owner's retention policies (control/retention/): a policy's change and
 * its entry in the audit log, and a removal's line in the history and its entry, are kept
 * together or dropped together.
 */

const DAY = 86_400_000;

const design = (o: Record<string, unknown> = {}) => ({
  name: "Old audit",
  kind: "audit",
  rule: "older",
  older_n: 30,
  ...o,
});

const audits = async (store: ControlStore, action: string) =>
  (await store.auditLog.list(500)).filter((a) => a.action === action);

/** An audit entry `days` old. */
async function oldEntry(store: ControlStore, action: string, days: number) {
  await writeBehind(
    store,
    "insert into audit (at, actor, action, body) values (?, 'owner:api', ?, '{}')",
    new Date(Date.now() - days * DAY).toISOString(),
    action,
  );
}

describe("a retention policy's change and its audit entry", () => {
  test("createPolicy: the policy and its audit entry", async () => {
    const store = openControlStore(":memory:");
    const dropped = await withWriteFailing(store, store.auditLog, "add", () =>
      createPolicy(store, design(), true, "owner:ui"),
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await store.retention.list(), [], "the policy went with its audit entry");
    assert.deepEqual(await audits(store, "retention_policy_created"), []);

    const kept = await watched(store, () => createPolicy(store, design(), true, "owner:ui"));
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "retention_policy"] }]);
    const policies = await store.retention.list();
    assert.deepEqual(
      policies.map((p) => [p.name, p.on]),
      [["Old audit", true]],
    );
    const entries = await audits(store, "retention_policy_created");
    assert.equal(entries.length, 1);
    assert.equal((entries[0]?.body as { id?: number } | undefined)?.id, policies[0]?.id);
    await store.close();
  });

  test("updatePolicy: the new design and its audit entry", async () => {
    const store = openControlStore(":memory:");
    const p = await createPolicy(store, design(), false, "owner:ui");
    const change = () => updatePolicy(store, p.id, design({ older_n: 90 }), true, "owner:ui");
    const dropped = await withWriteFailing(store, store.auditLog, "add", change);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await store.retention.get(p.id), p, "the policy is as it was");
    assert.deepEqual(await audits(store, "retention_policy_changed"), []);

    const kept = await watched(store, change);
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "retention_policy"] }]);
    const now = await store.retention.get(p.id);
    assert.equal(now?.on, true);
    assert.equal((now as unknown as { older_n: number }).older_n, 90);
    assert.deepEqual(kept.out, now);
    const entries = await audits(store, "retention_policy_changed");
    assert.equal(entries.length, 1);
    const was = (entries[0]?.body as { was?: { on: boolean } } | undefined)?.was;
    assert.equal(was?.on, false);
    await store.close();
  });

  test("setPolicyOn: the policy turned on or off and its audit entry", async () => {
    const store = openControlStore(":memory:");
    const p = await createPolicy(store, design(), false, "owner:ui");
    const dropped = await withWriteFailing(store, store.auditLog, "add", () =>
      setPolicyOn(store, p.id, true, "owner:ui"),
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await store.retention.get(p.id), p, "the policy is off, as it was");
    assert.deepEqual(await audits(store, "retention_policy_on"), []);

    const kept = await watched(store, () => setPolicyOn(store, p.id, true, "owner:ui"));
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "retention_policy"] }]);
    assert.equal((await store.retention.get(p.id))?.on, true);
    assert.equal((await audits(store, "retention_policy_on")).length, 1);
    await store.close();
  });

  test("deletePolicy: the policy gone and its audit entry", async () => {
    const store = openControlStore(":memory:");
    const p = await createPolicy(store, design(), false, "owner:ui");
    const dropped = await withWriteFailing(store, store.auditLog, "add", () =>
      deletePolicy(store, p.id, "owner:ui"),
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await store.retention.get(p.id), p, "the policy is still there");
    assert.deepEqual(await audits(store, "retention_policy_deleted"), []);

    const kept = await watched(store, () => deletePolicy(store, p.id, "owner:ui"));
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "retention_policy"] }]);
    assert.equal(await store.retention.get(p.id), undefined);
    assert.equal((await audits(store, "retention_policy_deleted")).length, 1);
    await store.close();
  });
});

describe("what a policy removed on control", () => {
  test("removeOnControl (runPolicy): the removal's line in the history and its audit entry", async () => {
    const store = openControlStore(":memory:");
    const p = await createPolicy(store, design(), false, "owner:ui");
    await oldEntry(store, "old_thing", 40);
    await oldEntry(store, "old_thing", 50);
    const run = () => runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui");
    const dropped = await withWriteFailing(store, store.auditLog, "add", run);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await store.retention.removals(10), [], "no line with no audit entry");
    assert.deepEqual(await audits(store, "retention_removed"), []);
    // The entries themselves went before the transaction, outside it: that removal is kept.
    assert.deepEqual(await audits(store, "old_thing"), []);

    await oldEntry(store, "old_thing", 60);
    const kept = await watched(store, run);
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "retention_removal"] }]);
    const removals = await store.retention.removals(10);
    assert.deepEqual(
      removals.map((r) => [r.policy, r.rig, r.by, r.count]),
      [[p.id, null, "Run now", 1]],
    );
    const entries = await audits(store, "retention_removed");
    assert.equal(entries.length, 1);
    assert.equal((entries[0]?.body as { count?: number } | undefined)?.count, 1);
    await store.close();
  });
});

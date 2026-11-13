import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advanceResets, cancelReset, confirmReset } from "../../../src/control/lifecycle.ts";
import { sqliteBehind } from "../../../src/control/store/behind.ts";
import { type ControlStore, openControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { enrollRigs } from "../../helpers/control-store.ts";
import {
  DROPPED,
  HELD,
  rowsOf,
  seen,
  WRITE_FAILED,
  watched,
  withAnotherCaller,
  withTurns,
  withWriteFailing,
} from "../../helpers/together.ts";

/**
 * The transactions of a rig's full reset (control/lifecycle.ts): each step reads the reset's
 * state and moves it on as one piece, with the command the step issues; the owner's confirmation
 * and cancellation read and set it as one piece too; and on RunPod the step in the rig's history
 * goes with the state.
 */

/** A store that knows rig-a, with a reset of it in `state`; `runpod`: control launched it there. */
async function setup(state: string, o: { runpod?: boolean } = {}) {
  const store = openControlStore(":memory:");
  await enrollRigs(store, ["rig-a"]);
  if (o.runpod)
    await store.runpod.addRig({
      rig: "rig-a",
      cloud: "cloud-a",
      pod: "pod-a",
      state: { status: "RUNNING" },
      by: "owner:api",
    });
  const { privateKeyPem } = generateSigningKeys();
  const advance = () =>
    advanceResets({ store, privateKeyPem, driver: undefined, staleAfterMs: 180_000 });
  return { store, advance, id: await resetIn(store, state) };
}

/** A new reset of rig-a in `state`, with the export a later step names. */
async function resetIn(store: ControlStore, state: string): Promise<number> {
  const id = await store.fullResets.create("rig-a", "owner:api");
  await store.fullResets.update(id, { state, export_name: "export-1", through_event: 5 });
  return id;
}

const resetOf = async (store: ControlStore, id: number) =>
  (await store.fullResets.list(200)).find((r) => Number(r.id) === id);

const stateOf = async (store: ControlStore, id: number) =>
  String((await resetOf(store, id))?.state);

const wipes = async (store: ControlStore) => await store.commands.latest("rig-a", "wipe_state", 10);

const steps = async (store: ControlStore) =>
  (await store.rigHistory.list("rig-a")).map((s) => [s.step, s.ok]);

describe("a full reset's transactions", () => {
  test("advanceResets, a step's move: the wipe's command and the reset that records it", async () => {
    const { store, advance, id } = await setup("confirmed");
    // The reset's move to wiping fails after its command was issued: the command goes with it.
    const dropped = await withWriteFailing(
      store,
      store.fullResets,
      "update",
      advance,
      (_id, fields) => (fields as { state: string }).state === "wiping",
    );
    assert.equal(dropped.threw, undefined, "the step notes its own failure");
    assert.deepEqual(seen(dropped)[0], { failed: true, changed: [] });
    assert.deepEqual(await wipes(store), [], "no wipe is asked for that no reset records");
    assert.deepEqual(rowsOf(store, "command"), []);
    // The step then notes the failure on the reset, in a transaction of its own, which is kept.
    assert.deepEqual(seen(dropped)[1], {
      failed: false,
      changed: ["audit", "reset", "sqlite_sequence"],
    });
    assert.equal(dropped.txs.length, 2);
    const failed = await resetOf(store, id);
    assert.equal(failed?.state, "failed");
    assert.match(String(failed?.detail), new RegExp(`^${WRITE_FAILED} \\(the rig's campaigns`));

    const next = await resetIn(store, "confirmed");
    const kept = await watched(store, advance);
    assert.equal(kept.threw, undefined);
    assert.equal(kept.txs.length, 1);
    assert.equal(kept.txs[0]?.failed, false);
    assert.ok(kept.txs[0]?.changed.includes("command"), String(kept.txs[0]?.changed));
    assert.ok(kept.txs[0]?.changed.includes("reset"));
    const asked = await wipes(store);
    assert.equal(asked.length, 1);
    const now = await resetOf(store, next);
    assert.equal(now?.state, "wiping");
    assert.equal(now?.command, asked[0]?.id, "the reset names the command it waits for");
    await store.close();
  });

  test("advanceResets, a step's move: the state is read and moved on as one piece", async () => {
    await withTurns(async () => {
      const { store, advance, id } = await setup("confirmed");
      // While the step's transaction is open, with the state read as confirmed, the owner
      // cancels: the cancel waits, finds the reset wiping, and is refused in words.
      let cancel = "";
      const held = await withAnotherCaller(store, store.fullResets, "list", advance, async () => {
        cancel = await cancelReset(store, id, "owner:ui").then(
          () => "cancelled",
          (err: Error) => err.message,
        );
      });
      assert.deepEqual(held.order, HELD);
      assert.equal(cancel, `reset ${id} is wiping`);
      assert.equal(await stateOf(store, id), "wiping");
      assert.equal((await wipes(store)).length, 1);
      await store.close();
    });
  });

  test("advanceResets, a step's failure: the failed reset and its step in a RunPod rig's history", async () => {
    const { store, advance, id } = await setup("quiescing", { runpod: true });
    // Two hours in a step that may take one.
    sqliteBehind(store)
      .db.prepare("update reset set updated_at = ? where id = ?")
      .run(new Date(Date.now() - 2 * 3_600_000).toISOString(), id);
    const dropped = await withWriteFailing(store, store.rigHistory, "add", advance);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await stateOf(store, id), "quiescing", "not failed with no step in the history");
    assert.deepEqual(await steps(store), []);

    const kept = await watched(store, advance);
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["audit", "reset", "rig_setup_event", "sqlite_sequence"] },
    ]);
    assert.equal(await stateOf(store, id), "failed");
    assert.match(String((await resetOf(store, id))?.detail), /^timed out while quiescing/);
    assert.deepEqual(await steps(store), [["reset_failed", false]]);
    await store.close();
  });

  test("confirmReset: the state is read and set as one piece", async () => {
    await withTurns(async () => {
      const { store, id } = await setup("awaiting_owner");
      // While the confirmation's transaction is open, with the state read as waiting for the
      // owner, the owner cancels from another window: the cancel waits, and is the last word.
      // Not held, the confirmation would write over it, and a cancelled reset would wipe.
      const held = await withAnotherCaller(
        store,
        store.fullResets,
        "list",
        () => confirmReset(store, id, "owner:ui"),
        () => cancelReset(store, id, "owner:api"),
      );
      assert.deepEqual(held.order, HELD);
      const now = await resetOf(store, id);
      assert.equal(now?.state, "cancelled");
      assert.match(String(now?.detail), /^cancelled by owner:api/);
      await assert.rejects(confirmReset(store, id, "owner:ui"), /is cancelled, not waiting/);
      await store.close();
    });
  });

  test("cancelReset: the cancelled reset and its step in a RunPod rig's history", async () => {
    const { store, id } = await setup("awaiting_owner", { runpod: true });
    const cancel = () => cancelReset(store, id, "owner:ui");
    const dropped = await withWriteFailing(store, store.rigHistory, "add", cancel);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await stateOf(store, id), "awaiting_owner", "the reset is as it was");
    assert.deepEqual(await steps(store), []);

    const kept = await watched(store, cancel);
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["audit", "reset", "rig_setup_event", "sqlite_sequence"] },
    ]);
    assert.equal(await stateOf(store, id), "cancelled");
    assert.deepEqual(await steps(store), [["reset_cancelled", true]]);
    await store.close();
  });

  test("cancelReset: the state is read and set as one piece", async () => {
    await withTurns(async () => {
      const { store, advance, id } = await setup("confirmed");
      // While the cancel's transaction is open, with the state read as confirmed, the reset's
      // next step begins to wipe: it waits, and finds the reset cancelled, so it asks no wipe.
      const held = await withAnotherCaller(
        store,
        store.fullResets,
        "list",
        () => cancelReset(store, id, "owner:ui"),
        advance,
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(await stateOf(store, id), "cancelled");
      assert.deepEqual(await wipes(store), [], "a cancelled reset wipes nothing");
      await store.close();
    });
  });
});

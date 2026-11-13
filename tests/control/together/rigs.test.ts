import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInfo } from "../../../src/common/build-info.ts";
import { inBackground } from "../../../src/control/background.ts";
import { RigUpdates } from "../../../src/control/rigs/update.ts";
import { type ControlStore, openControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { applied, controlStore, enrollRigs, ingestReport } from "../../helpers/control-store.ts";
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
 * The transactions around a rig's reports and control's work on a rig: a report's ledger and the
 * runs it creates (control/ingest.ts); a rig marked failed that reports again, with its step
 * (control/ingest.ts); background work that failed, with the status it reads (control/background.ts);
 * and an update's start, with the look for one under way (control/rigs/update.ts).
 */

/** A report of `rig`'s ledger l-1 with these events, as one that passed control's checks. */
const report = (rig: string, events: { id: number; kind: string; subject: string }[]) => ({
  rig,
  ledger_id: "l-1",
  cursor: 0,
  next: events.length,
  generated_at: new Date().toISOString(),
  summary: {},
  events: events.map((e) => ({
    ...e,
    at: new Date(Date.UTC(2026, 9, 29, 5, 0, 0, e.id)).toISOString(),
    actor: "harness",
    body: { campaign: "gemv" },
    run: e.subject,
  })),
});

/** The rig gpu-1 as control set it up on a cluster, with no cluster behind it. */
async function clusterRig(store: ControlStore): Promise<void> {
  await store.clusters.addRig({
    rig: "gpu-1",
    cluster: "k8s-g",
    namespace: "thermite-slot-1",
    placement: "slot",
    spec: {
      gpus: 1,
      gpuMode: "device-plugin",
      storageGi: 50,
      images: {
        harness: "registry.example.com/harness-cuda:1",
        supervisor: "registry.example.com/supervisor:1",
      },
    },
    created_by: "owner:ui",
  });
}

const statusOf = async (store: ControlStore) => (await store.clusters.rig("gpu-1"))?.status;

const steps = async (store: ControlStore, rig: string) =>
  (await store.rigHistory.list(rig)).map((e) => [e.step, e.ok, e.detail]);

describe("a rig's report", () => {
  test("keepReport: the rig's ledger and the runs its events create", async () => {
    const store = controlStore();
    // The apply's start is over, so the report's own transactions are the only ones seen.
    await applied(store);
    const page = report("rig-a", [
      { id: 1, kind: "run_created", subject: "gs-1" },
      { id: 2, kind: "run_created", subject: "gs-2" },
    ]);
    // The second run's entry in the registry fails: the first run's and the ledger go with it.
    let runs = 0;
    const dropped = await withWriteFailing(
      store,
      store.runRegistry,
      "registerRunCreated",
      () => ingestReport(store, page),
      () => ++runs === 2,
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(rowsOf(store, "run_registry"), [], "no run of the report is registered");
    assert.deepEqual(rowsOf(store, "rig_ledger"), [], "the rig did not enter the ledger");
    assert.deepEqual(await store.reportedRigs.list(), []);

    const kept = await watched(store, () => ingestReport(store, page));
    assert.equal(kept.out, 2);
    // The report's own transaction is the first; the apply of its events follows.
    assert.equal(kept.txs[0]?.failed, false);
    for (const table of ["rig", "rig_ledger", "run_registry"])
      assert.ok(kept.txs[0]?.changed.includes(table), `${table}: ${kept.txs[0]?.changed}`);
    const registry = (kept.txs[0]?.after.run_registry ?? []) as {
      run: string;
      rig: string;
      ledger_id: string;
    }[];
    assert.deepEqual(
      registry.map((r) => [r.run, r.rig, r.ledger_id]),
      [
        ["gs-1", "rig-a", "l-1"],
        ["gs-2", "rig-a", "l-1"],
      ],
    );
    assert.equal((await store.reportedRigs.list())[0]?.ledger_id, "l-1");
  });

  test("noteReportAfterWait (keepReport): a failed rig that reports again, its status and its step", async () => {
    const store = controlStore();
    await clusterRig(store);
    await store.clusters.setRigStatus("gpu-1", "failed");
    await store.rigHistory.add("gpu-1", "first_report", false, "no report after 10 minutes");
    const reports = () => ingestReport(store, report("gpu-1", []));
    const dropped = await withWriteFailing(store, store.rigHistory, "add", reports);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped).at(-1), { failed: true, changed: [] });
    assert.equal(await statusOf(store), "failed", "not running with no step that says why");
    assert.equal((await steps(store, "gpu-1")).length, 1);
    // The report itself was taken before that transaction, outside it, and is kept.
    assert.equal((await store.reportedRigs.list())[0]?.id, "gpu-1");

    const kept = await watched(store, reports);
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept).at(-1), {
      failed: false,
      changed: ["cluster_rig", "rig_setup_event"],
    });
    assert.equal(await statusOf(store), "running");
    assert.deepEqual((await steps(store, "gpu-1")).at(-1), [
      "first_report",
      true,
      "it reported after the wait ended",
    ]);
  });
});

describe("control's work on a rig", () => {
  test("inBackground: the status is read and set to failed as one piece", async () => {
    await withTurns(async () => {
      const store = openControlStore(":memory:");
      await clusterRig(store);
      assert.equal(await statusOf(store), "deploying");
      // While the failure's transaction is open, with the status read as deploying, the owner
      // stops the rig: the stop waits, and is the last word. Not held, "failed" would write
      // over it.
      const held = await withAnotherCaller(
        store,
        store.clusters,
        "rig",
        () =>
          inBackground(
            store,
            "cluster",
            "gpu-1",
            "applied",
            Promise.reject(new Error("the cluster refused the objects")),
          ),
        () => store.clusters.setRigStatus("gpu-1", "stopped"),
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(await statusOf(store), "stopped");
      assert.deepEqual(await steps(store, "gpu-1"), [
        ["applied", false, "the cluster refused the objects"],
      ]);
      // A status that does not last only while the work goes on is left as it is.
      await inBackground(store, "cluster", "gpu-1", "applied", Promise.reject(new Error("late")));
      assert.equal(await statusOf(store), "stopped");
      await store.close();
    });
  });

  test("RigUpdates.begin: the look for an update under way and its note are one piece", async () => {
    await withTurns(async () => {
      const store = openControlStore(":memory:");
      await enrollRigs(store, ["rig-a"]);
      const updates = new RigUpdates({
        store,
        privateKeyPem: generateSigningKeys().privateKeyPem,
        control: buildInfo(),
        staleAfterMs: 180_000,
        pollMs: 1,
      });
      // The update's move onto new images waits until the test lets it fail.
      let fail = () => {};
      const waits = new Promise<void>((done) => {
        fail = done;
      });
      const target = {
        apply: async () => {
          await waits;
          throw new Error("the images are not there");
        },
      };
      // While the first update's transaction is open, with its look for an update under way
      // made, the owner asks for the update again: that waits, finds the first, and is refused.
      let second = "";
      const held = await withAnotherCaller(
        store,
        store.rigUpdates,
        "get",
        () => updates.begin("rig-a", "owner:ui", target),
        async () => {
          second = await updates.begin("rig-a", "owner:api", target).then(
            () => "began",
            (err: Error) => err.message,
          );
        },
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(second, "An update of rig-a is under way: wait until its steps end.");
      assert.deepEqual(
        rowsOf(store, "rig_update").map((r) => [r.rig, r.requested_by]),
        [["rig-a", "owner:ui"]],
        "one update is under way, the first one's",
      );
      fail();
      await held.out.ended;
      assert.deepEqual(rowsOf(store, "rig_update"), []);
      await store.close();
    });
  });
});

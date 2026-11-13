import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inBackground } from "../../src/control/background.ts";
import { type ClusterRig, openControlStore } from "../../src/control/store/index.ts";

async function clusterRig(status?: string) {
  const store = openControlStore(":memory:");
  await store.clusters.addRig({
    rig: "k-1",
    cluster: "k8s-c",
    namespace: "thermite-slot-1",
    placement: "slot",
    spec: {} as ClusterRig["spec"],
    created_by: "owner:ui",
  });
  if (status) await store.clusters.setRigStatus("k-1", status);
  return store;
}

describe("work control starts in the background (goal 161)", () => {
  test("a failure is recorded in the rig's history and ends the state it left", async () => {
    const store = await clusterRig("updating");
    await inBackground(
      store,
      "cluster",
      "k-1",
      "images_running",
      Promise.reject(new Error("kubectl: connection refused")),
    );
    assert.equal((await store.clusters.rig("k-1"))?.status, "failed");
    const [e] = await store.rigHistory.list("k-1");
    assert.equal(e?.step, "images_running");
    assert.equal(e?.ok, false);
    assert.equal(e?.detail, "kubectl: connection refused");
  });

  test("a rig set up from scratch that fails leaves deploying too", async () => {
    const store = await clusterRig();
    assert.equal((await store.clusters.rig("k-1"))?.status, "deploying");
    await inBackground(store, "cluster", "k-1", "applied", Promise.reject("no namespace"));
    assert.equal((await store.clusters.rig("k-1"))?.status, "failed");
  });

  test("a state set meanwhile, such as stopped, is left as it is", async () => {
    const store = await clusterRig("stopped");
    await inBackground(store, "cluster", "k-1", "pods_running", Promise.reject(new Error("gone")));
    assert.equal((await store.clusters.rig("k-1"))?.status, "stopped");
    assert.equal(
      (await store.rigHistory.list("k-1")).length,
      1,
      "the failure is still in its history",
    );
  });

  test("work that succeeds records nothing of its own", async () => {
    const store = await clusterRig("updating");
    await inBackground(store, "cluster", "k-1", "images_running", Promise.resolve());
    assert.equal((await store.clusters.rig("k-1"))?.status, "updating");
    assert.deepEqual(await store.rigHistory.list("k-1"), []);
  });
});

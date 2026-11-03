import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inBackground } from "../../src/control/background.ts";
import { type ClusterRig, ControlStore } from "../../src/control/store/index.ts";

function clusterRig(status?: string) {
  const store = new ControlStore(":memory:");
  store.clusters.addRig({
    rig: "k-1",
    cluster: "k8s-c",
    namespace: "thermite-slot-1",
    placement: "slot",
    spec: {} as ClusterRig["spec"],
    created_by: "owner:ui",
  });
  if (status) store.clusters.setRigStatus("k-1", status);
  return store;
}

describe("work control starts in the background (goal 161)", () => {
  test("a failure is recorded in the rig's history and ends the state it left", async () => {
    const store = clusterRig("updating");
    await inBackground(
      store,
      "cluster",
      "k-1",
      "images_running",
      Promise.reject(new Error("kubectl: connection refused")),
    );
    assert.equal(store.clusters.rig("k-1")?.status, "failed");
    const [e] = store.rigHistory.list("k-1");
    assert.equal(e?.step, "images_running");
    assert.equal(e?.ok, false);
    assert.equal(e?.detail, "kubectl: connection refused");
  });

  test("a rig set up from scratch that fails leaves deploying too", async () => {
    const store = clusterRig();
    assert.equal(store.clusters.rig("k-1")?.status, "deploying");
    await inBackground(store, "cluster", "k-1", "applied", Promise.reject("no namespace"));
    assert.equal(store.clusters.rig("k-1")?.status, "failed");
  });

  test("a state set meanwhile, such as stopped, is left as it is", async () => {
    const store = clusterRig("stopped");
    await inBackground(store, "cluster", "k-1", "pods_running", Promise.reject(new Error("gone")));
    assert.equal(store.clusters.rig("k-1")?.status, "stopped");
    assert.equal(store.rigHistory.list("k-1").length, 1, "the failure is still in its history");
  });

  test("work that succeeds records nothing of its own", async () => {
    const store = clusterRig("updating");
    await inBackground(store, "cluster", "k-1", "images_running", Promise.resolve());
    assert.equal(store.clusters.rig("k-1")?.status, "updating");
    assert.deepEqual(store.rigHistory.list("k-1"), []);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deploymentEnv } from "../../../src/control/clusters/deployment.ts";
import { control, fakeCluster, KUBECONFIG } from "../../helpers/fake-cluster.ts";

/** A cluster rig set up through Add a rig, then running. */
async function rigOn(deploymentStdout?: string) {
  const f = fakeCluster({
    canCreateNamespaces: false,
    slots: { "thermite-slot-1": true },
    ...(deploymentStdout === undefined ? {} : { deploymentStdout }),
  });
  const s = await control(f.k);
  await s.post("/ui/settings/add", {
    type: "k8s",
    name: "k8s-c",
    kubeconfig: KUBECONFIG,
    placement: "slot",
    slots: "thermite-slot-1",
  });
  await s.post("/ui/rigs/add", {
    place: "cluster:k8s-c",
    rig: "cpu-1",
    "k_gpus__k8s-c": "0",
    "k_slot__k8s-c": "thermite-slot-1",
  });
  await new Promise((r) => setTimeout(r, 20));
  s.store.clusters.setRigStatus("cpu-1", "running");
  return s;
}

describe("Update to these images when kubectl's answer can't be read (goal 161)", () => {
  test("an answer that is not a deployment is reported as a failure, never as an unchanged rig", async () => {
    const s = await rigOn("Error from server: etcdserver: request timed out\n");
    // kubectl's words stay on control: the page's address names them by an ID.
    const to = await s.post("/ui/rigs/cpu-1/cluster/images", {});
    assert.match(to, /error=note-[0-9a-f]+$/);
    const said = await s.page(to);
    assert.match(
      said,
      /Control could not read cpu-1's deployment to compare control's address: kubectl's answer is not a deployment/,
    );
    assert.doesNotMatch(said, /already runs control's images/);
  });

  test("a deployment it can read, with control's address, is unchanged", async () => {
    const s = await rigOn();
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 already runs control's images/,
    );
  });

  test("reading a deployment's environment", () => {
    const env = [{ name: "CONTROL_URL", value: "https://c.example.com" }];
    const d = (containers: unknown) =>
      JSON.stringify({ spec: { template: { spec: { containers } } } });
    assert.deepEqual(deploymentEnv(d([{ env }])), env);
    assert.deepEqual(deploymentEnv(d([{}])), []);
    assert.equal(deploymentEnv("not json"), null);
    assert.equal(deploymentEnv(JSON.stringify({ kind: "Status" })), null);
    assert.equal(deploymentEnv("null"), null);
  });
});

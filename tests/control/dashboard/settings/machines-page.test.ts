import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { control, fakeCluster, KUBECONFIG } from "../../../helpers/fake-cluster.ts";

/**
 * Goal 203: where rigs run has its own Settings page, Machines, apart from Providers' logins. Its
 * Add a machine has the three kinds; each cluster or machine offers Add a rig here, which opens
 * Add a rig with it chosen; Add a rig's card for a new machine opens Machines.
 */

describe("Settings › Machines (goal 203)", () => {
  test("machines, clusters and GPU clouds are on Machines, not Providers", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    const providers = await s.page("/ui/settings");
    assert.match(providers, /href="\/ui\/settings\/machines"/, "Settings' own navigation");
    assert.doesNotMatch(
      providers,
      /value="ssh"|value="k8s"|value="runpod"/,
      "no machine in its list",
    );
    const empty = await s.page("/ui/settings/machines");
    assert.match(
      empty,
      /<summary class="btn primary" style="display:inline-flex">Add a machine<\/summary>/,
    );
    for (const kind of ["ssh", "k8s", "runpod"])
      assert.match(empty, new RegExp(`<input type="radio" name="type" value="${kind}"`));
    assert.match(empty, /No cluster yet\./);
    // A cluster added from Machines comes back there, in its own block.
    const added = await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-a",
      kubeconfig: KUBECONFIG,
      placement: "created",
      namespace_pattern: "thermite-{rig}",
    });
    assert.match(added, /^\/ui\/settings\/machines\?ok=.*"k8s-a" is added and checked/);
    const machines = await s.page("/ui/settings/machines");
    assert.match(machines, /<h2>Kubernetes clusters<\/h2><span class="n">1<\/span>/);
    assert.match(machines, /href="\/ui\/rigs\/add\?place=cluster:k8s-a">Add a rig here<\/a>/);
    assert.doesNotMatch(await s.page("/ui/settings"), /data-k="cluster-k8s-a"/);
  });

  test("Add a rig chooses the place it came from, and its new-machine card opens Machines", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-a",
      kubeconfig: KUBECONFIG,
      placement: "created",
      namespace_pattern: "thermite-{rig}",
    });
    const add = await s.page("/ui/rigs/add?place=cluster:k8s-a");
    assert.match(add, /value="cluster:k8s-a" checked/);
    assert.match(
      add,
      /<a class="ch" href="\/ui\/settings\/machines\?add=1#add-machine"><span><b>\+ A new machine<\/b>/,
    );
    assert.match(
      await s.page("/ui/settings/machines?add=1"),
      /<details class="block" id="add-machine" open>/,
    );
  });
});

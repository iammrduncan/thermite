import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { control, fakeCluster, KUBECONFIG } from "../../helpers/fake-cluster.ts";

/**
 * A slot whose rules let other pods connect to the harness: the rig is added and works, and its
 * page warns in words, with the rule that lets only its supervisor in; once the operators apply
 * it, Check again takes the warning off.
 */

describe("a slot's ingress rules on the rig's page", () => {
  test("a slot open to other pods is taken, with a warning and the rule that closes it", async () => {
    const options: Parameters<typeof fakeCluster>[0] = {
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true },
    };
    const f = fakeCluster(options);
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-b",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    const rig = {
      place: "cluster:k8s-b",
      rig: "k8s-b-1",
      "k_gpus__k8s-b": "0",
      "k_slot__k8s-b": "thermite-slot-1",
    };
    assert.equal(await s.post("/ui/rigs/add", rig), "/ui/rigs/k8s-b-1", "a warning, not a refusal");
    await new Promise((r) => setTimeout(r, 20));
    let page = await s.page("/ui/rigs/k8s-b-1");
    assert.match(page, /<b class="warn">Other pods can connect to this rig's harness\.<\/b>/);
    assert.match(
      page,
      /In the slot thermite-slot-1, no network rule in the slot limits who may connect to the harness, so every pod in the cluster can reach its port 8700\. The rig works/,
    );
    assert.match(page, /name: thermite-k8s-b-1-harness-in\n {2}namespace: thermite-slot-1/);
    assert.match(
      page,
      /- podSelector:\n {12}matchLabels:\n {14}app\.kubernetes\.io\/instance: k8s-b-1\n {14}app\.kubernetes\.io\/component: supervisor/,
    );
    // The operators apply it; Check again on the cluster reads the slot again.
    options.ingress = [
      {
        from: [
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/instance": "k8s-b-1",
                "app.kubernetes.io/component": "supervisor",
              },
            },
          },
        ],
        ports: [{ port: 8700, protocol: "TCP" }],
      },
    ];
    await s.post("/ui/settings/clusters/k8s-b/check", {});
    page = await s.page("/ui/rigs/k8s-b-1");
    assert.ok(!page.includes("Other pods can connect"), "the warning is gone");
    assert.deepEqual(s.store.clusters.rig("k8s-b-1")?.spec.ingress, {
      ok: true,
      why: "only the rig's supervisor may connect to the harness",
    });
  });
});

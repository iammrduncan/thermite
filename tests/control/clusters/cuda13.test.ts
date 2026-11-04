import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { control, fakeCluster, KUBECONFIG, mcpWith, OPERATOR } from "../../helpers/fake-cluster.ts";

/**
 * Goal 132, part 2 for clusters: a rig added over MCP with cuda "13" runs control's CUDA 13
 * harness (THERMITE_RIG_HARNESS_CUDA13_IMAGE) and keeps it when it moves onto control's newer
 * images; a rig without GPUs, or a control without that image, is refused in words.
 */

/** The harness image of the newest apply of the rig's objects. */
function harnessApplied(f: ReturnType<typeof fakeCluster>): string | undefined {
  const apply = f.calls.filter((c) => c.args[0] === "apply").at(-1);
  return /registry\.example\.com\/harness[^"]*/.exec(apply?.stdin ?? "")?.[0];
}

const settle = async (f: ReturnType<typeof fakeCluster>, n: number) => {
  for (let i = 0; i < 100 && f.calls.filter((c) => c.args[0] === "apply").length < n; i++)
    await new Promise((r) => setTimeout(r, 20));
};

async function withCluster(o: { cuda13?: boolean } = {}) {
  const f = fakeCluster();
  const s = await control(f.k, o);
  assert.match(
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-a",
      kubeconfig: KUBECONFIG,
      placement: "created",
      namespace_pattern: "thermite-{rig}",
    }),
    /"k8s-a" is added and checked/,
  );
  const mcp = await mcpWith(s.api, OPERATOR);
  return { f, s, mcp };
}

describe("a cluster rig on the CUDA 13 harness (goal 132)", () => {
  test("cuda 13 deploys the CUDA 13 harness, and an update keeps it", async () => {
    const { f, s, mcp } = await withCluster();
    const added = await mcp.call("add_cluster_rig", {
      rig: "spark-1",
      cluster: "k8s-a",
      gpus: 1,
      gpu_mode: "device-plugin",
      cuda: "13",
    });
    assert.deepEqual(added, { error: false, body: { rig: "spark-1", status: "deploying" } });
    await settle(f, 1);
    assert.equal(harnessApplied(f), "registry.example.com/harness-cuda13:1");
    assert.equal(s.store.clusters.rig("spark-1")?.spec.cuda, "13");
    // A rig with GPUs and no choice runs the CUDA 12 harness, as before.
    await mcp.call("add_cluster_rig", {
      rig: "older-gpu-1",
      cluster: "k8s-a",
      gpus: 1,
      gpu_mode: "device-plugin",
    });
    await settle(f, 2);
    assert.equal(harnessApplied(f), "registry.example.com/harness-cuda:1");
    assert.equal(s.store.clusters.rig("older-gpu-1")?.spec.cuda, undefined);
    await mcp.close();

    // Control on newer images: the CUDA 13 rig moves onto the newer CUDA 13 harness.
    s.store.clusters.setRigStatus("spark-1", "running");
    const later = await control(f.k, { store: s.store, secrets: s.secrets, tag: "2" });
    const owner = await mcpWith(later.api, OPERATOR);
    f.calls.length = 0;
    const moved = await owner.call("update_rig_images", { rig: "spark-1", wait: false });
    assert.equal(moved.error, false, JSON.stringify(moved.body));
    await settle(f, 1);
    assert.equal(harnessApplied(f), "registry.example.com/harness-cuda13:2");
    await owner.close();
  });

  test("refused in words: no GPUs, or no CUDA 13 image on control", async () => {
    const { mcp } = await withCluster();
    const cpu = await mcp.call("add_cluster_rig", { rig: "cpu-9", cluster: "k8s-a", cuda: "13" });
    assert.ok(cpu.error);
    assert.equal(
      cpu.body.error,
      "A rig with no GPUs runs the CPU harness: leave out cuda, or give it GPUs.",
    );
    await mcp.close();
    const none = await withCluster({ cuda13: false });
    const refused = await none.mcp.call("add_cluster_rig", {
      rig: "spark-2",
      cluster: "k8s-a",
      gpus: 1,
      gpu_mode: "device-plugin",
      cuda: "13",
    });
    assert.ok(refused.error);
    assert.equal(
      refused.body.error,
      "Control has no CUDA 13 harness image configured (THERMITE_RIG_HARNESS_CUDA13_IMAGE).",
    );
    assert.equal(none.s.store.clusters.rig("spark-2"), undefined, "nothing was added");
    await none.mcp.close();
  });
});

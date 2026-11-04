import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cudaFor } from "../../../src/control/clusters/index.ts";
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

  test("control tells a GB10 from what the cluster says, and defaults to CUDA 13", async () => {
    // The class's selector names the GPU's UUID; the slice says it is a GB10 of 12.1 on an arm64 node.
    const UUID = "GPU-f583e817-7193-fb85-7863-b3a0d5eca14e";
    const spark = {
      deviceClasses: ["spark-gpus", "other-gpus"],
      deviceClassSpecs: {
        "spark-gpus": {
          selectors: [
            { cel: { expression: `device.attributes["gpu.nvidia.com"].uuid == "${UUID}"` } },
          ],
        },
        "other-gpus": {
          selectors: [
            {
              cel: {
                expression: `device.attributes["gpu.nvidia.com"].productName == "Tesla P100-PCIE-16GB"`,
              },
            },
          ],
        },
      },
      nodeArch: "arm64",
      slices: [
        {
          spec: {
            nodeName: "gpu-node-1",
            devices: [
              {
                name: "gpu-0",
                attributes: {
                  uuid: { string: UUID },
                  productName: { string: "NVIDIA GB10" },
                  cudaComputeCapability: { version: "12.1.0" },
                },
              },
            ],
          },
        },
      ],
    };
    const f = fakeCluster(spark);
    const s = await control(f.k);
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
    const facts = s.store.clusters.get("k8s-a")?.facts as { gpu_classes?: unknown } | undefined;
    assert.deepEqual(facts?.gpu_classes, {
      "spark-gpus": { product: "NVIDIA GB10", cc: "12.1.0", arch: "arm64", node: "gpu-node-1" },
      "other-gpus": { product: "Tesla P100-PCIE-16GB" },
    });
    // Add a rig: the GB10's class is a runner on its node, which takes CUDA 13 (goal 206); the
    // node shows its architecture.
    const add = await s.page("/ui/rigs/add");
    assert.match(add, /<b>gpu-node-1<\/b> <span class="chip">a node of k8s-a<\/span>/);
    assert.match(add, /arm64 · 16 CPUs · 64 GiB/);
    assert.match(add, /data-product="NVIDIA GB10" data-cuda="13"/);
    assert.match(add, /NVIDIA GB10 · DRA class spark-gpus/);
    assert.match(add, /value="k8s-a\|\|\|dra%3Aspark-gpus"/);
    // Over MCP, with no cuda: the class's GPU sets it.
    const mcp = await mcpWith(s.api, OPERATOR);
    const added = await mcp.call("add_cluster_rig", {
      rig: "spark-1",
      cluster: "k8s-a",
      gpus: 1,
      gpu_mode: "dra:spark-gpus",
    });
    assert.equal(added.error, false, JSON.stringify(added.body));
    assert.equal(s.store.clusters.rig("spark-1")?.spec.cuda, "13");
    // The form's choice of 12 stays 12, whatever the GPU.
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-a",
        rig: "spark-2",
        "k_gpus__k8s-a": "1",
        "k_mode__k8s-a": "dra:spark-gpus",
        "k_cuda__k8s-a": "12",
        "k_storage__k8s-a": "standard",
        "k_size__k8s-a": "50",
      }),
      "/ui/rigs/spark-2",
    );
    assert.equal(s.store.clusters.rig("spark-2")?.spec.cuda, undefined);
    await mcp.close();
  });

  test("the rule: arm64 or compute capability 10 and up takes CUDA 13", () => {
    assert.equal(cudaFor({ product: "NVIDIA-GB10" })?.cuda, "13");
    assert.equal(cudaFor({ cc: "10.0" })?.cuda, "13");
    assert.equal(cudaFor({ product: "Tesla-V100-SXM2-16GB", arch: "amd64" }), undefined);
    assert.equal(cudaFor({ cc: "6.0", product: "Tesla P100" })?.cuda, "12");
    assert.equal(cudaFor({ arch: "arm64" })?.cuda, "13");
  });
});

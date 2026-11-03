import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClusterFacts } from "../../../src/control/clusters/facts.ts";
import { slotQuota } from "../../../src/control/clusters/facts.ts";
import {
  ClusterResourcesBody,
  judgeShareOf,
  planClusterResize,
  quotaRefusal,
  shareMoveWords,
  sizeChangeWords,
  sizeOf,
  sizeWords,
} from "../../../src/control/clusters/resources.ts";
import type { ClusterRig } from "../../../src/control/store/index.ts";

/** A slot rig with three GPUs through the device plugin and the namespace's defaults. */
const rig = (spec: Partial<ClusterRig["spec"]> = {}): ClusterRig => ({
  rig: "rig-1",
  cluster: "cluster-1",
  namespace: "thermite-slot-1",
  placement: "slot",
  spec: {
    gpus: 3,
    judgeGpus: 2,
    gpuMode: "device-plugin",
    storageGi: 100,
    images: { harness: "h", supervisor: "s" },
    ...spec,
  },
  status: "running",
  created_at: "2026-10-24T00:00:00.000Z",
  created_by: "owner:ui",
});
const facts = (o: Partial<ClusterFacts> = {}): ClusterFacts => ({
  version: "v1.35.2",
  nodes: [],
  device_classes: [],
  storage_classes: [],
  can_create_namespaces: false,
  slots: [],
  ...o,
});
/** The owner, on a rig whose report says its agent programs run headless. */
const owner: Parameters<typeof planClusterResize>[2] = {
  owner: true,
  facts: facts(),
  quota: undefined,
  mode: "headless",
};

describe("a cluster rig's new GPUs, CPUs and memory (goal 118)", () => {
  test("a slot's quota reads GPUs through the device plugin and each DRA device class", () => {
    const q = slotQuota(
      JSON.stringify({
        items: [
          {
            status: {
              hard: {
                "limits.cpu": "16",
                "limits.memory": "52Gi",
                "requests.nvidia.com/gpu": "4",
                "gpu.nvidia.com.deviceclass.resource.k8s.io/devices": "4",
              },
            },
          },
          { status: { hard: { "gpu.nvidia.com.deviceclass.resource.k8s.io/devices": "2" } } },
        ],
      }),
    );
    assert.equal(q?.cpus, 16);
    assert.equal(q?.memoryGi, 52);
    assert.equal(q?.gpus, 4);
    // The tightest of the quotas.
    assert.deepEqual(q?.devices, { "gpu.nvidia.com": 2 });
    assert.equal(slotQuota(JSON.stringify({ items: [] })), undefined);
  });

  test("3 GPUs to 4 and the namespace's defaults to the quota: the new size, in words", () => {
    const plan = planClusterResize(
      rig(),
      { gpus: 4, cpus: 16, memoryGi: 52 },
      { ...owner, quota: { cpus: 16, memoryGi: 52, gpus: 4 } },
    );
    assert.deepEqual(plan, {
      size: {
        gpus: 4,
        judgeGpus: 2,
        resources: { cpus: 16, memoryGi: 52 },
        programMode: "headless" as const,
      },
    });
    if (!("size" in plan)) return;
    assert.equal(
      sizeChangeWords({ gpus: 3, judgeGpus: 2, programMode: "headless" }, plan.size),
      "GPUs 3 → 4 (2 for the judge, 2 for the agents); CPUs and memory: namespace defaults → 16 CPUs, 52 GiB",
    );
    assert.equal(
      sizeWords(plan.size),
      "4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory",
    );
  });

  test("a new number of GPUs without judge_gpus gives the judge half, rounded up; with it, its share", () => {
    const half = planClusterResize(rig({ judgeGpus: 1 }), { gpus: 5 }, owner);
    assert.ok("size" in half);
    assert.equal(half.size.judgeGpus, 3);
    const given = planClusterResize(rig(), { gpus: 5, judgeGpus: 1 }, owner);
    assert.ok("size" in given);
    assert.equal(given.size.judgeGpus, 1);
    // The same number of GPUs keeps the split the rig has, whatever else changes.
    const same = planClusterResize(rig({ judgeGpus: 1 }), { cpus: 8, memoryGi: 32 }, owner);
    assert.ok("size" in same);
    assert.equal(same.size.judgeGpus, 1);
    assert.equal(judgeShareOf(undefined, 1), undefined);
    assert.equal(judgeShareOf(undefined, 4), 2);
  });

  test("an operator's token changes GPUs, CPUs and memory, but not the judge's share", () => {
    const op = { ...owner, owner: false };
    assert.ok("size" in planClusterResize(rig(), { gpus: 4, cpus: 8, memoryGi: 32 }, op));
    assert.deepEqual(planClusterResize(rig(), { gpus: 4, judgeGpus: 1 }, op), {
      error:
        "Only the owner's token changes a rig's GPU split: leave out judge_gpus. A new number of GPUs without it gives the judge half of them, rounded up.",
      status: 403,
    });
  });

  test("refusals, in Add a rig's words", () => {
    const err = (r: ClusterRig, want: Parameters<typeof planClusterResize>[1], o = owner) => {
      const p = planClusterResize(r, want, o);
      return "error" in p ? p.error : "";
    };
    assert.equal(err(rig(), { gpus: 17 }), "A rig takes from none to 16 GPUs.");
    assert.equal(err(rig(), { gpus: 2.5 }), "A rig takes from none to 16 GPUs.");
    assert.match(err(rig(), { gpus: 0 }), /^rig-1 measures on GPUs, and can't move to none/);
    assert.match(
      err(rig({ gpus: 0, judgeGpus: undefined }), { gpus: 1 }),
      /^rig-1 measures on the CPU, and can't take GPUs: its harness image and its target would change/,
    );
    assert.match(err(rig(), { judgeGpus: 1 }), /^judge_gpus goes with a new number of GPUs/);
    assert.equal(
      err(rig(), { gpus: 4, judgeGpus: 4 }),
      "With 4 GPUs the judge takes 1 to 3 of them, and the agents at most 8.",
    );
    assert.equal(
      err(rig(), { cpus: 8 }),
      "Give rig-1 both its CPUs and its memory: it has the namespace's defaults now.",
    );
    assert.match(err(rig(), { cpus: null, memoryGi: 8 }), /^Give the rig both its CPUs/);
    assert.equal(
      err(rig(), { cpus: 1, memoryGi: 4 }),
      "a rig needs at least 1.5 CPUs and 6 GiB of memory",
    );
    assert.match(err(rig(), { cpus: Number.NaN, memoryGi: 8 }), /CPUs and memory are numbers/);
    // The slot's quota, as control read it just now.
    const quota = { cpus: 16, memoryGi: 52, gpus: 4 };
    assert.equal(
      err(rig(), { gpus: 5 }, { ...owner, quota }),
      "The slot thermite-slot-1 allows 4 GPUs.",
    );
    assert.equal(
      err(rig(), { cpus: 20, memoryGi: 52 }, { ...owner, quota }),
      "The slot thermite-slot-1 allows 16 CPUs.",
    );
    assert.equal(
      err(rig(), { cpus: 16, memoryGi: 64 }, { ...owner, quota }),
      "The slot thermite-slot-1 allows 52 GiB of memory.",
    );
    // The device plugin's nodes, as control last read the cluster; a rig kept on one node.
    const nodes = [
      { name: "gpu-node-1", ready: true, gpus: 4, cpu: "32", memory: "128Gi" },
      { name: "gpu-node-2", ready: true, gpus: 8, cpu: "32", memory: "128Gi" },
    ];
    const seen = { ...owner, facts: facts({ nodes }) };
    assert.ok("size" in planClusterResize(rig(), { gpus: 8 }, seen));
    assert.equal(
      err(rig(), { gpus: 9 }, seen),
      "No node of cluster-1 offers 9 GPUs through the device plugin.",
    );
    assert.equal(
      err(rig({ node: "gpu-node-1" }), { gpus: 6 }, seen),
      "The node gpu-node-1 offers 4 GPUs through the device plugin, not 6.",
    );
    // DRA: the rig's device class, and the slot's quota for it.
    const dra = rig({ gpuMode: "dra", deviceClass: "gpu.nvidia.com" });
    assert.equal(
      err(dra, { gpus: 4 }, { ...owner, facts: facts({ device_classes: ["other.example.com"] }) }),
      "cluster-1 no longer offers the DRA device class gpu.nvidia.com.",
    );
    assert.equal(
      err(dra, { gpus: 5 }, { ...owner, quota: { devices: { "gpu.nvidia.com": 4 } } }),
      "The slot thermite-slot-1 allows 4 devices of the class gpu.nvidia.com.",
    );
    assert.ok(
      "size" in
        planClusterResize(
          dra,
          { gpus: 4 },
          { ...owner, quota: { devices: { "gpu.nvidia.com": 4 } } },
        ),
    );
  });

  test("nothing new is nothing to do; null for both is the namespace's defaults", () => {
    const sized = rig({ resources: { cpus: 16, memoryGi: 52 } });
    assert.deepEqual(planClusterResize(sized, { gpus: 3, cpus: 16, memoryGi: 52 }, owner), {
      same: true,
    });
    assert.deepEqual(planClusterResize(sized, { cpus: null, memoryGi: null }, owner), {
      size: { gpus: 3, judgeGpus: 2, resources: undefined, programMode: "headless" },
    });
    // One of the two, with the other kept.
    assert.deepEqual(planClusterResize(sized, { memoryGi: 48 }, owner), {
      size: {
        gpus: 3,
        judgeGpus: 2,
        resources: { cpus: 16, memoryGi: 48 },
        programMode: "headless",
      },
    });
  });

  test("the supervisor's share follows how the agent programs run: the split, the least size, a new mode (goal 169)", () => {
    const terminal = { ...owner, mode: "terminal" as const };
    const err = (r: ClusterRig, want: Parameters<typeof planClusterResize>[1], o = owner) => {
      const p = planClusterResize(r, want, o);
      return "error" in p ? p.error : "";
    };
    const TOO_SMALL =
      "a rig needs at least 1.5 CPUs and 8 GiB of memory while its agent programs run in their own terminals: its supervisor takes 4 GiB for the advisors' terminals, and its harness at least 4 GiB";
    // In their own terminals, the rig needs 8 GiB: 4 for the supervisor, at least 4 for the harness.
    assert.equal(err(rig(), { cpus: 2, memoryGi: 6 }, terminal), TOO_SMALL);
    assert.ok("size" in planClusterResize(rig(), { cpus: 2, memoryGi: 6 }, owner));
    assert.deepEqual(planClusterResize(rig(), { cpus: 2, memoryGi: 8 }, terminal), {
      size: { gpus: 3, judgeGpus: 2, resources: { cpus: 2, memoryGi: 8 }, programMode: "terminal" },
    });
    // The size it keeps must hold the share too: a new number of GPUs alone is refused then.
    const six = rig({ resources: { cpus: 2, memoryGi: 6 }, programMode: "headless" });
    assert.equal(err(six, { gpus: 4 }, terminal), TOO_SMALL);
    // A new mode from the rig's settings: refused in the same words when it does not fit.
    assert.equal(err(six, { programMode: "terminal" }), TOO_SMALL);
    assert.equal(err(six, { programMode: "terminal", cpus: 2, memoryGi: 7 }), TOO_SMALL);
    // When it fits, a new mode alone is a new size: the supervisor's share moves.
    const sized = rig({ resources: { cpus: 16, memoryGi: 52 }, programMode: "headless" });
    const moved = planClusterResize(sized, { programMode: "terminal" }, owner);
    assert.deepEqual(moved, {
      size: {
        gpus: 3,
        judgeGpus: 2,
        resources: { cpus: 16, memoryGi: 52 },
        programMode: "terminal" as const,
      },
    });
    if (!("size" in moved)) return;
    assert.equal(
      sizeChangeWords(sizeOf(sized), moved.size),
      "its supervisor's memory: 2 → 4 GiB, as its agent programs run in their own terminals",
    );
    assert.equal(
      shareMoveWords(sizeOf(sized), moved.size),
      "Its supervisor gets 4 GiB, as its agent programs run in their own terminals: ",
    );
    // The same mode as its deployments have: nothing to do; so too on the namespace's defaults,
    // where no share is set.
    assert.deepEqual(planClusterResize(sized, { programMode: "headless" }, terminal), {
      same: true,
    });
    assert.deepEqual(planClusterResize(rig(), { programMode: "terminal" }, owner), { same: true });
    // Its report's mode, when no new one is asked, is the one its deployments get.
    assert.deepEqual(planClusterResize(sized, { cpus: 16, memoryGi: 52 }, terminal), {
      size: {
        gpus: 3,
        judgeGpus: 2,
        resources: { cpus: 16, memoryGi: 52 },
        programMode: "terminal",
      },
    });
    // A rig deployed before the share followed the mode had the headless share.
    assert.equal(sizeOf(rig({ resources: { cpus: 16, memoryGi: 52 } })).programMode, "headless");
    assert.equal(shareMoveWords(sizeOf(rig()), { ...moved.size, resources: undefined }), "");
  });

  test("Add a rig's GPU quota check takes the same words", () => {
    assert.equal(
      quotaRefusal("thermite-slot-1", { gpus: 2 }, { gpus: 3 }),
      "The slot thermite-slot-1 allows 2 GPUs.",
    );
    assert.equal(quotaRefusal("thermite-slot-1", { gpus: 2 }, { gpus: 0 }), undefined);
    assert.equal(quotaRefusal("thermite-slot-1", undefined, { gpus: 9 }), undefined);
  });

  test("the request body takes nulls for CPUs and memory and refuses unknown fields", () => {
    assert.ok(ClusterResourcesBody.safeParse({ cpus: null, memory_gib: null }).success);
    assert.ok(ClusterResourcesBody.safeParse({ gpus: 4, judge_gpus: 2, wait: false }).success);
    assert.ok(!ClusterResourcesBody.safeParse({ storage_gb: 200 }).success);
    assert.ok(!ClusterResourcesBody.safeParse({ gpus: 1.5 }).success);
  });
});

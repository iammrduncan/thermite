import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { control, fakeCluster, KUBECONFIG, mcpWith, OPERATOR } from "../../helpers/fake-cluster.ts";

/**
 * Goal 205, step 1d: a rig over several nodes of a cluster. The leader's objects stay as a rig's
 * always were, with its followers named in its harness's environment; each follower has its own
 * volume, harness (started as a follower, its GPUs all the judge's) and supervisor, on its own
 * node, with labels no selector of the leader's parts takes.
 */

type Obj = Record<string, unknown> & {
  kind: string;
  metadata: { name: string; labels: Record<string, string> };
};

const settle = async (f: ReturnType<typeof fakeCluster>, n: number) => {
  for (let i = 0; i < 100 && f.calls.filter((c) => c.args[0] === "apply").length < n; i++)
    await new Promise((r) => setTimeout(r, 20));
};

/** The objects of the newest apply. */
function applied(f: ReturnType<typeof fakeCluster>): Obj[] {
  const apply = f.calls.filter((c) => c.args[0] === "apply").at(-1);
  return (JSON.parse(apply?.stdin ?? "{}") as { items?: Obj[] }).items ?? [];
}

const named = (objects: Obj[], kind: string, name: string) =>
  objects.find((o) => o.kind === kind && o.metadata.name === name);

/** The object, which must be there. */
function need(objects: Obj[], kind: string, name: string): Obj {
  const o = named(objects, kind, name);
  assert.ok(o, `${kind} ${name}`);
  return o;
}

/** A deployment's container's environment, as a map. */
function envOf(d: Obj): Record<string, string> {
  const spec = (
    d.spec as { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } }
  ).template.spec;
  return Object.fromEntries(spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
}

async function withCluster(
  o: { moreNodes?: { name: string; arch?: string }[]; nodeArch?: string } = {},
) {
  const f = fakeCluster({
    moreNodes: o.moreNodes ?? [{ name: "gpu-node-2" }],
    nodeArch: o.nodeArch,
  });
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
  return { f, s, mcp: await mcpWith(s.api, OPERATOR) };
}

const PAIR = {
  rig: "pair-1",
  cluster: "k8s-a",
  gpus: 1,
  gpu_mode: "device-plugin",
  node: "gpu-node-1",
  followers: [{ machine: "judge-1", node: "gpu-node-2", gpus: 1 }],
  judge_here: false,
};

describe("a rig over several nodes of a cluster (goal 205)", () => {
  test("the leader names its followers; each follower runs on its own node as a follower", async () => {
    const { f, s, mcp } = await withCluster();
    assert.deepEqual(await mcp.call("add_cluster_rig", PAIR), {
      error: false,
      body: { rig: "pair-1", status: "deploying" },
    });
    await settle(f, 1);
    const objects = applied(f);
    assert.deepEqual(s.store.clusters.rig("pair-1")?.spec.followers, [
      { machine: "judge-1", node: "gpu-node-2", gpus: 1, storageGi: 100 },
    ]);
    assert.equal(s.store.clusters.rig("pair-1")?.spec.judgeHere, false);

    // The leader: its own two parts as always, its harness told of its follower.
    const leader = need(objects, "Deployment", "thermite-pair-1-harness");
    assert.equal(envOf(leader).THERMITE_FOLLOWERS, "judge-1=1");
    assert.equal(envOf(leader).THERMITE_LOCAL_JUDGE, "0");
    assert.deepEqual((leader.spec as { selector: unknown }).selector, {
      matchLabels: {
        "app.kubernetes.io/instance": "pair-1",
        "app.kubernetes.io/component": "harness",
      },
    });

    // The follower: its volume, service, harness and supervisor, on its own node.
    for (const [kind, name] of [
      ["PersistentVolumeClaim", "thermite-pair-1-judge-1-data"],
      ["Service", "thermite-pair-1-judge-1-harness"],
      ["Deployment", "thermite-pair-1-judge-1-harness"],
      ["Deployment", "thermite-pair-1-judge-1-supervisor"],
      ["NetworkPolicy", "thermite-pair-1-judge-1-harness-net"],
      ["NetworkPolicy", "thermite-pair-1-judge-1-supervisor-net"],
    ] as const)
      assert.ok(named(objects, kind, name), `${kind} ${name}`);
    const harness = need(objects, "Deployment", "thermite-pair-1-judge-1-harness");
    const supervisor = need(objects, "Deployment", "thermite-pair-1-judge-1-supervisor");
    assert.deepEqual(envOf(harness), {
      THERMITE_RIG_ID: "pair-1",
      THERMITE_ROLE: "follower",
      THERMITE_TARGET: "cuda-gpu",
      THERMITE_GPU_INDEX: "0",
      THERMITE_CONTROL_PUBKEY_FILE: "/keys/control-signing.pub",
      THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
    });
    assert.equal(envOf(supervisor).THERMITE_ROLE, "follower");
    assert.equal(envOf(supervisor).THERMITE_MACHINE, "judge-1");
    assert.equal(envOf(supervisor).HARNESS_URL, "http://thermite-pair-1-judge-1-harness:8700");
    const podOf = (d: Obj) =>
      (
        d.spec as {
          template: { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> };
        }
      ).template;
    assert.deepEqual(podOf(harness).spec.nodeSelector, { "kubernetes.io/hostname": "gpu-node-2" });
    assert.deepEqual(podOf(leader).spec.nodeSelector, { "kubernetes.io/hostname": "gpu-node-1" });

    // Every object of the follower carries the rig's instance (stop, start and remove take it)
    // and its machine; no follower pod has a component the leader's selectors take.
    for (const o of objects.filter((x) => x.metadata.name.includes("judge-1"))) {
      assert.equal(o.metadata.labels["app.kubernetes.io/instance"], "pair-1", o.metadata.name);
      assert.equal(o.metadata.labels["thermite.dev/machine"], "judge-1", o.metadata.name);
    }
    for (const d of [harness, supervisor])
      assert.match(podOf(d).metadata.labels["app.kubernetes.io/component"] ?? "", /^follower-/);
  });

  test("a follower on the leader's node, an unknown node, another architecture, or two of one name is refused", async () => {
    const { mcp } = await withCluster({
      moreNodes: [{ name: "gpu-node-2" }, { name: "arm-node-1", arch: "arm64" }],
      nodeArch: "amd64",
    });
    const refused = async (followers: unknown[], extra: Record<string, unknown> = {}) => {
      const r = await mcp.call("add_cluster_rig", { ...PAIR, followers, ...extra });
      assert.equal(r.error, true, JSON.stringify(r));
      return String(r.body.error);
    };
    assert.match(
      await refused([{ machine: "judge-1", node: "gpu-node-1", gpus: 1 }]),
      /gpu-node-1 is in the rig already/,
    );
    assert.match(
      await refused([{ machine: "judge-1", node: "nowhere", gpus: 1 }]),
      /has no node nowhere/,
    );
    assert.match(
      await refused([{ machine: "judge-1", node: "arm-node-1", gpus: 1 }]),
      /arm-node-1 is arm64 and the leader's node amd64/,
    );
    assert.match(
      await refused([
        { machine: "judge-1", node: "gpu-node-2", gpus: 1 },
        { machine: "judge-1", node: "arm-node-1", gpus: 1 },
      ]),
      /two followers named judge-1/,
    );
    assert.match(
      await refused([{ machine: "judge-1", node: "gpu-node-2", gpus: 1 }], { node: undefined }),
      /names its leader's node/,
    );
  });
});

describe("Add a rig's More machines, and the rig's page (goal 205)", () => {
  test("a cluster's other nodes are offered; the form sets a follower up, and the rig's page shows both machines", async () => {
    const { f, s } = await withCluster();
    const add = await s.page("/ui/rigs/add");
    assert.match(add, /More machines/);
    assert.match(add, /name="k_follow__k8s-a" value="gpu-node-2"/);
    assert.match(add, /name="k_lead__k8s-a"/);
    const to = await s.post("/ui/rigs/add", {
      place: "cluster:k8s-a",
      rig: "pair-2",
      "k_gpus__k8s-a": "1",
      "k_mode__k8s-a": "device-plugin",
      "k_cuda__k8s-a": "12",
      "k_node__k8s-a": "gpu-node-1",
      "k_size__k8s-a": "100",
      "k_lead__k8s-a": "workers",
      "k_follow__k8s-a": "gpu-node-2",
      "k_fgpus__k8s-a__gpu-node-2": "1",
      "k_fsize__k8s-a__gpu-node-2": "250",
    });
    assert.match(to, /^\/ui\/rigs\/pair-2$/);
    assert.deepEqual(s.store.clusters.rig("pair-2")?.spec.followers, [
      { machine: "gpu-node-2", node: "gpu-node-2", gpus: 1, storageGi: 250 },
    ]);
    assert.equal(s.store.clusters.rig("pair-2")?.spec.judgeHere, false);
    await settle(f, 1);
    const page = await s.page("/ui/rigs/pair-2");
    assert.match(page, /<h2>Machines<\/h2><span class="n">2<\/span>/);
    assert.match(page, /<b>gpu-node-1<\/b> <span class="chip info">leader<\/span>/);
    assert.match(page, /1 GPU, the workers'/);
    assert.match(page, /<b>gpu-node-2<\/b> <span class="chip">follower<\/span>/);
    assert.match(page, /its supervisor has not registered on the bus yet/);
  });
});

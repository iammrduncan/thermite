import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import { runnerUnit } from "../../../src/control/clusters/manifests.ts";
import { mcpClient } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import {
  ADMIN,
  control,
  fakeCluster,
  KUBECONFIG,
  mcpWith,
  OPERATOR,
} from "../../helpers/fake-cluster.ts";

/**
 * Goal 206, step 4b: control sets a rig's runner process up on a cluster: a harness and a
 * supervisor started as a runner, by a name of their own (so the rig's own pods and actions leave
 * them alone), with a token of their own that registers the runner on the bus and does nothing
 * else; then it gives the runner to the rig. Taken away, the rig hears first, then its objects go
 * and its token stops working.
 */

type Obj = {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
  stringData?: Record<string, string>;
};

const settle = async (f: ReturnType<typeof fakeCluster>, n: number) => {
  for (let i = 0; i < 100 && f.calls.filter((c) => c.args[0] === "apply").length < n; i++)
    await new Promise((r) => setTimeout(r, 20));
};

/** The newest apply's objects. */
const applied = (f: ReturnType<typeof fakeCluster>): Obj[] =>
  (
    JSON.parse(f.calls.filter((c) => c.args[0] === "apply").at(-1)?.stdin ?? "{}") as {
      items?: Obj[];
    }
  ).items ?? [];

/** A deployment's first container's environment. */
const envOf = (o: Obj | undefined) =>
  Object.fromEntries(
    (
      ((o?.spec?.template as { spec: { containers: { env: { name: string; value: string }[] }[] } })
        ?.spec.containers[0]?.env ?? []) as { name: string; value: string }[]
    ).map((e) => [e.name, e.value]),
  );

/** Control with a cluster, and the rig core-1 reporting its settings, with no runners yet. */
async function withRig() {
  const f = fakeCluster();
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
  s.store.enrollments.enroll("core-1", "a".repeat(64), "test");
  const report = (runners: unknown[]) =>
    ingestReport(s.store, {
      rig: "core-1",
      ledger_id: "ledger-core-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { settings: { lanes: 2, promotion: "auto", runners } },
    });
  await report([]);
  const sent = () =>
    s.store.commands
      .pending("core-1")
      .filter((c) => c.envelope.kind === "rig_settings")
      .map((c) => c.envelope.payload);
  const register = (runner: string, token: string, path = `runners/${runner}/supervisor`) =>
    s.api.request(`/v1/rigs/core-1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ bus_key: createUser().getPublicKey() }),
    });
  return { f, s, sent, register, report };
}

describe("a rig's runner processes on a cluster (goal 206)", () => {
  test("a runner's objects go by its own name, as a runner, with a token of its own", async () => {
    const { f, s, sent, register, report } = await withRig();
    const owner = await mcpWith(s.api, ADMIN);
    const added = await owner.call("add_cluster_runner", {
      rig: "core-1",
      runner: "spark-02",
      cluster: "k8s-a",
      node: "gpu-node-1",
      gpus: 1,
      pool: "judge",
    });
    assert.equal(added.error, false, JSON.stringify(added.body));
    assert.match(String(added.body.said), /^Control sets spark-02 up on k8s-a, on gpu-node-1/);
    await settle(f, 1);
    const objs = applied(f);
    const unit = runnerUnit("core-1", "spark-02");
    assert.equal(unit, "core-1-spark-02");
    const harness = objs.find(
      (o) => o.kind === "Deployment" && o.metadata.name === `thermite-${unit}-harness`,
    );
    const supervisor = objs.find(
      (o) => o.kind === "Deployment" && o.metadata.name === `thermite-${unit}-supervisor`,
    );
    assert.ok(harness && supervisor, objs.map((o) => `${o.kind} ${o.metadata.name}`).join(", "));
    assert.equal(harness.metadata.namespace, `thermite-${unit}`, "a namespace of its own");
    assert.equal(harness.metadata.labels?.["app.kubernetes.io/instance"], unit);
    assert.equal(harness.metadata.labels?.["app.kubernetes.io/part-of"], "thermite-core-1");
    assert.equal(envOf(harness).THERMITE_ROLE, "runner");
    assert.equal(envOf(harness).THERMITE_RIG_ID, "core-1");
    assert.equal(envOf(harness).THERMITE_TARGET, "cuda-gpu");
    assert.equal(envOf(supervisor).THERMITE_ROLE, "runner");
    assert.equal(envOf(supervisor).THERMITE_RUNNER, "spark-02");
    // Given to the rig once set up: the rig's whole list of runners.
    for (let i = 0; i < 100 && !sent().length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent(), [{ runners: [{ name: "spark-02", pools: ["judge"] }] }]);
    assert.equal(s.store.rigRunners.get("core-1", "spark-02")?.status, "running");

    // Its token registers it on the bus, and does nothing else.
    const token = objs.find((o) => o.kind === "Secret")?.stringData?.["control-rig-token"] ?? "";
    assert.ok(token.length > 20);
    assert.equal((await register("spark-02", token)).status, 200);
    assert.equal((await register("spark-03", token)).status, 401, "another runner's route");
    assert.equal(
      (await register("spark-02", token, "supervisor")).status,
      401,
      "the rig's own route",
    );

    // Taken away: the rig hears first, then its namespace goes, and its token stops working.
    await report([{ name: "spark-02", pools: ["judge"] }]);
    const removed = await owner.call("remove_runner", { rig: "core-1", runner: "spark-02" });
    assert.equal(removed.error, false, JSON.stringify(removed.body));
    assert.deepEqual(sent().at(-1), { runners: [] });
    assert.ok(
      f.calls.some((c) => c.args.join(" ").startsWith(`delete namespace thermite-${unit}`)),
      "its namespace is deleted",
    );
    assert.equal(s.store.rigRunners.get("core-1", "spark-02")?.status, "removed");
    assert.equal((await register("spark-02", token)).status, 401);
    await owner.close();
  });

  test("the owner's alone; refused in words", async () => {
    const { s } = await withRig();
    const operator = await mcpClient(s.api, OPERATOR);
    const names = (await operator.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("add_cluster_runner") && !names.includes("remove_runner"));
    await operator.close();
    const owner = await mcpWith(s.api, ADMIN);
    for (const [args, error] of [
      [{ runner: "Spark 2", gpus: 1, pool: "judge" }, /^A runner's name is /],
      [
        { runner: "spark-02", gpus: 2, pool: "judge" },
        /^A runner on a cluster takes one GPU, or none\.$/,
      ],
      [
        { runner: "spark-02", gpus: 1, pool: "gpu" },
        /^A runner's pool is judge, shared or lane-1 to lane-16\.$/,
      ],
      [
        { runner: "spark-02", gpus: 1, pool: "judge", node: "no-node" },
        /^k8s-a has no node no-node/,
      ],
    ] as const) {
      const r = await owner.call("add_cluster_runner", {
        rig: "core-1",
        cluster: "k8s-a",
        ...args,
      });
      assert.equal(r.error, true, JSON.stringify(args));
      assert.match(String(r.body.error ?? r.body), error);
    }
    const none = await owner.call("add_cluster_runner", {
      rig: "no-rig",
      runner: "spark-02",
      cluster: "k8s-a",
      gpus: 1,
      pool: "judge",
    });
    assert.match(String(none.body.error ?? none.body), /^There is no rig no-rig\.$/);
    await owner.close();
  });

  test("Add a rig with its runners: a core with no GPU judges on its runners alone", async () => {
    const { f, s } = await withRig();
    const page = await s.page("/ui/rigs/add");
    assert.match(page, /<h2>Runners on other machines<\/h2>/);
    assert.match(page, /name="ar_at__0" value="k8s-a\|\|gpu-node-1"/);
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-a",
        rig: "core-2",
        "k_gpus__k8s-a": "0",
        "k_size__k8s-a": "50",
        ar_at__0: "k8s-a||gpu-node-1",
        ar_pool__0: "judge",
        ar_mode__0: "device-plugin",
      }),
      "/ui/rigs/core-2",
    );
    await settle(f, 2);
    const applies = f.calls
      .filter((c) => c.args[0] === "apply")
      .map((c) => JSON.parse(c.stdin ?? "{}").items as Obj[]);
    const core = applies[0]?.find(
      (o) => o.kind === "Deployment" && o.metadata.name === "thermite-core-2-harness",
    );
    assert.equal(envOf(core).THERMITE_LOCAL_JUDGE, "0", "the core's judge measures on its runners");
    const runner = applies[1]?.find(
      (o) => o.kind === "Deployment" && o.metadata.name === "thermite-core-2-gpu-node-1-harness",
    );
    assert.equal(envOf(runner).THERMITE_ROLE, "runner");
    assert.equal(s.store.rigRunners.get("core-2", "gpu-node-1")?.spec.pools[0], "judge");
    // Over MCP: a core with GPUs judges on itself too, unless told.
    const owner = await mcpWith(s.api, ADMIN);
    await owner.call("add_cluster_rig", {
      rig: "core-3",
      cluster: "k8s-a",
      judge_on_runners: true,
    });
    await settle(f, 3);
    const third = applied(f).find(
      (o) => o.kind === "Deployment" && o.metadata.name === "thermite-core-3-harness",
    );
    assert.equal(envOf(third).THERMITE_LOCAL_JUDGE, "0");
    await owner.close();
  });

  test("a long rig and runner name is cut, with a hash, under Kubernetes' limits", () => {
    const unit = runnerUnit(
      "a-rig-with-a-rather-long-name-indeed",
      "and-a-runner-named-at-length-too",
    );
    assert.ok(unit.length <= 46, unit);
    assert.match(unit, /^a-rig-with-a-rathe-and-a-runner-named-[0-9a-f]{8}$/);
    assert.notEqual(
      unit,
      runnerUnit("a-rig-with-a-rather-long-name-indeed", "and-a-runner-named-at-length-two"),
    );
  });
});

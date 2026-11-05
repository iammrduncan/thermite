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
async function withRig(o: { runnersWatchMs?: number; workersWatchMs?: number } = {}) {
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

  test("Add a rig's wizard: a rig of one machine on a cluster takes the GPUs ticked, from one node", async () => {
    const { s } = await withRig();
    const page = await s.page("/ui/rigs/add");
    // It opens on the kind of rig; each step links to its page on the docs site.
    assert.match(
      page,
      /<section class="wz" data-step="kind"><div class="wz-head"><h2>What kind of rig\?<\/h2>/,
    );
    assert.match(page, /<input type="radio" name="kind" value="one"><b>One machine<\/b>/);
    assert.match(page, /<input type="radio" name="kind" value="many"><b>Several machines<\/b>/);
    assert.match(page, /href="https:\/\/usethermite\.com\/how-to\/install\/several-gpus\/"/);
    assert.match(page, /<div data-gpus-for="cluster:k8s-a" hidden>/);
    assert.match(page, /name="one_gpu" value="k8s-a\|\|gpu-node-1\|device-plugin" data-offer=/);
    const at = "k8s-a||gpu-node-1|device-plugin";
    // GPUs of two rows are refused in words; so is a kind and a place that don't fit.
    assert.match(
      await s.post("/ui/rigs/add", {
        kind: "one",
        place: "cluster:k8s-a",
        rig: "one-1",
        one_gpu: at,
        // Fields of the steps a rig of one machine skips are left out.
        runner_new__0: `gpu-node-1=${at}`,
        runner_new_pool__0: "lane-1",
        lanes: "4",
      }),
      /^\/ui\/rigs\/one-1$/,
    );
    const r = s.store.clusters.rig("one-1");
    assert.equal(r?.spec.gpus, 1);
    assert.equal(r?.spec.node, "gpu-node-1", "on the node of its GPUs");
    assert.equal(s.store.rigRunners.of("one-1").length, 0, "no runner from a skipped step");
    assert.match(
      await s.post("/ui/rigs/add", { kind: "join", place: "cluster:k8s-a", rig: "one-2" }),
      /Choose where you set the rig up/,
    );
  });

  test("a rig whose setup failed says why at the top of its page, and is removed with no export", async () => {
    const { f, s } = await withRig();
    const owner = await mcpWith(s.api, ADMIN);
    await owner.call("add_cluster_rig", { rig: "core-9", cluster: "k8s-a" });
    await owner.close();
    await settle(f, 1);
    s.store.clusters.setRigStatus("core-9", "failed");
    s.store.rigHistory.add(
      "core-9",
      "deploy",
      false,
      "Error from server (Forbidden): pods here run only on node-a",
    );
    const page = await s.page("/ui/rigs/core-9");
    assert.match(
      page,
      /data-part="setup-failed"><p style="margin-top:0"><b class="bad">Control could not set core-9 up on k8s-a\.<\/b> Error from server \(Forbidden\): pods here run only on node-a<\/p>/,
    );
    assert.match(page, /action="\/ui\/rigs\/core-9\/cluster\/remove"/);
    // Set up again on a node, as a slot that names its nodes needs: a new token, applied again.
    assert.match(page, /action="\/ui\/rigs\/core-9\/cluster\/again"/);
    const applies = f.calls.filter((c) => c.args[0] === "apply").length;
    assert.match(
      await s.post("/ui/rigs/core-9/cluster/again", { node: "gpu-node-1" }),
      /Control sets core-9 up again on gpu-node-1/,
    );
    assert.equal(s.store.clusters.rig("core-9")?.spec.node, "gpu-node-1");
    await settle(f, applies + 1);
    assert.ok(f.calls.filter((c) => c.args[0] === "apply").length > applies, "applied again");
    // It never reported: it holds no result, and "remove core-9" removes it.
    await s.post("/ui/rigs/core-9/cluster/remove", { confirm: "remove core-9" });
    for (let i = 0; i < 100 && s.store.clusters.rig("core-9")?.status !== "removed"; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.store.clusters.rig("core-9")?.status, "removed");
    // A removed rig keeps its name: Add a rig's name step knows it is taken before it sends.
    assert.match(await s.page("/ui/rigs/add"), /data-taken="\[[^"]*&quot;core-9&quot;/);
    assert.match(
      await s.post("/ui/rigs/add", { kind: "many", place: "cluster:k8s-a", rig: "core-9" }),
      /There is a rig named core-9 already/,
    );
  });

  test("a slot whose rules take pods only on a node it names: control finds it and puts the rig there", async () => {
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true },
      slotNodes: { "thermite-slot-1": ["gpu-node-1"] },
    });
    const s = await control(f.k);
    assert.match(
      await s.post("/ui/settings/add", {
        type: "k8s",
        name: "lab",
        kubeconfig: KUBECONFIG,
        placement: "slot",
        slots: "thermite-slot-1",
      }),
      /"lab" is added and checked/,
    );
    // The check asked the cluster with a dry run, which creates nothing.
    const facts = s.store.clusters.get("lab")?.facts as
      | { slots: { nodes?: string[]; node_rule?: string }[] }
      | undefined;
    const slot = facts?.slots[0];
    assert.deepEqual(slot?.nodes, ["gpu-node-1"]);
    assert.match(slot?.node_rule ?? "", /pods here run only on gpu-node-1/);
    const probes = f.calls.filter(
      (c) => c.args.join(" ") === "create --dry-run=server -n thermite-slot-1 -f -",
    );
    assert.ok(probes.length >= 2, "with no node, then on each node");
    // With control's own harness image, which a slot's rules take as they take a rig's.
    assert.match(probes[0]?.stdin ?? "", /"image":"registry\.example\.com\/harness:1"/);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "nothing applied");
    // Add a rig offers its one node; a rig there with none given goes on it.
    assert.match(
      await s.page("/ui/rigs/add"),
      /value="cluster:lab\|thermite-slot-1"[^>]*data-nodes="gpu-node-1"/,
    );
    assert.equal(
      await s.post("/ui/rigs/add", {
        kind: "many",
        place: "cluster:lab|thermite-slot-1",
        rig: "core-n",
      }),
      "/ui/rigs/core-n",
    );
    assert.equal(s.store.clusters.rig("core-n")?.spec.node, "gpu-node-1");
  });

  test("two runners set up together are both given to the rig", async () => {
    const { s, sent } = await withRig();
    const owner = await mcpWith(s.api, ADMIN);
    for (const [runner, pool] of [
      ["spark-02", "judge"],
      ["spark-03", "shared"],
    ] as const) {
      const added = await owner.call("add_cluster_runner", {
        rig: "core-1",
        runner,
        cluster: "k8s-a",
        node: "gpu-node-1",
        gpus: 1,
        pool,
      });
      assert.equal(added.error, false, JSON.stringify(added.body));
      for (let i = 0; i < 100 && sent().length < (runner === "spark-02" ? 1 : 2); i++)
        await new Promise((r) => setTimeout(r, 20));
    }
    // The rig has not reported spark-02 yet when spark-03 is given: it keeps it.
    assert.deepEqual(sent().at(-1), {
      runners: [
        { name: "spark-02", pools: ["judge"] },
        { name: "spark-03", pools: ["shared"] },
      ],
    });
    await owner.close();
  });

  test("a runner set up before its rig's core reports is given once it does", async () => {
    const { f, s } = await withRig({ runnersWatchMs: 20 });
    const owner = await mcpWith(s.api, ADMIN);
    // A core that has not reported yet, as one whose setup failed and was done again later.
    const core = await owner.call("add_cluster_rig", { rig: "core-4", cluster: "k8s-a" });
    assert.equal(core.error, false, JSON.stringify(core.body));
    await settle(f, 1);
    const added = await owner.call("add_cluster_runner", {
      rig: "core-4",
      runner: "spark-02",
      cluster: "k8s-a",
      node: "gpu-node-1",
      gpus: 1,
      pool: "judge",
    });
    assert.equal(added.error, false, JSON.stringify(added.body));
    await settle(f, 2);
    const sent = () =>
      s.store.commands
        .pending("core-4")
        .filter((c) => c.envelope.kind === "rig_settings")
        .map((c) => c.envelope.payload);
    for (
      let i = 0;
      i < 20 && s.store.rigRunners.get("core-4", "spark-02")?.status !== "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sent(), [], "nothing goes to a rig that does not report its settings");
    const given = () => s.store.rigHistory.list("core-4").filter((x) => x.step === "runner_given");
    assert.deepEqual(given(), [], "and its history shows no failure: the runner waits");
    await ingestReport(s.store, {
      rig: "core-4",
      ledger_id: "ledger-core-4",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { settings: { lanes: 1, promotion: "auto", runners: [] } },
    });
    for (let i = 0; i < 100 && !sent().length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent(), [{ runners: [{ name: "spark-02", pools: ["judge"] }] }]);
    assert.deepEqual(
      given().map((x) => x.ok),
      [true],
    );
    // As the owner who added it: the rig takes its runners from the owner alone.
    const first = s.store.commands.pending("core-4")[0]?.envelope;
    assert.equal(first?.issued_by, s.store.rigRunners.get("core-4", "spark-02")?.created_by);
    assert.match(String(first?.issued_by), /^owner/);
    // Given once: control's next rounds send nothing more while the rig has it on the way.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sent().length, 1);
    // A rig that refuses it gets it again, up to three times in all.
    for (let n = 1; n <= 3; n++) {
      const id = String(s.store.commands.pending("core-4")[0]?.envelope.id);
      s.store.commands.confirmApplied("core-4", id, "failed", "{}", new Date().toISOString());
      for (let i = 0; i < 100 && !sent().length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent().length, n < 3 ? 1 : 0, `after refusal ${n}`);
    }
    assert.equal(given().length, 3);
    await owner.close();
  });

  test("the rig's history says when a runner first answers, stops answering and answers again", async () => {
    const { s } = await withRig();
    const report = (up: boolean, away: string | null) =>
      ingestReport(s.store, {
        rig: "core-1",
        ledger_id: "ledger-core-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: {
          settings: { lanes: 2, promotion: "auto", runners: [{ name: "box-2", pools: ["judge"] }] },
          runners: {
            processes: [
              {
                name: "box-2",
                pools: ["judge"],
                up,
                ...(away ? { why: "the runner box-2 stopped answering" } : {}),
                answered_at: null,
                away_since: away,
                runners: [{ name: "box-2-0", pool: "judge", holder: null }],
              },
            ],
            waiting: [],
          },
        },
      });
    await report(false, null);
    await report(true, null);
    await report(true, null);
    await report(false, "2026-11-04T19:57:00Z");
    await report(true, null);
    assert.deepEqual(
      s.store.rigHistory
        .list("core-1")
        .filter((x) => x.step.startsWith("runner_"))
        .map((x) => [x.step, x.ok, x.detail]),
      [
        ["runner_answers", true, "box-2"],
        ["runner_away", false, "box-2: the runner box-2 stopped answering"],
        ["runner_back", true, "box-2"],
      ],
    );
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
    assert.match(
      page,
      /<h2>Which GPUs are its runners\? <span class="muted small" id="ar-count">0 chosen<\/span><\/h2>/,
    );
    // No runner at first: + Add a runner adds a row, a machine, then its GPU, then the pool.
    assert.match(page, /data-runner-none>No runners yet/);
    assert.match(
      page,
      /<button type="button" class="sm" data-add-runner hidden>\+ Add a runner<\/button>/,
    );
    assert.match(page, /<option value="0" data-core-of="">gpu-node-1 · a node of k8s-a \(/);
    assert.match(
      page,
      /<option value="gpu-node-1-1=k8s-a\|\|gpu-node-1\|device-plugin" data-group="0"/,
    );
    assert.match(page, /name="runner_new__N" data-gpu-pick/);
    // The core's node, among its cluster's ready ones: a slot may take pods only on those it names.
    assert.match(page, /<option value="gpu-node-1" data-cluster="k8s-a">gpu-node-1 \(/);
    const form = {
      kind: "many",
      place: "cluster:k8s-a",
      rig: "core-2",
      // A GPU ticked on the one-machine step, which a rig of several machines leaves out.
      one_gpu: "k8s-a||gpu-node-1|device-plugin",
      core_disk: "50",
      core_node: "gpu-node-1",
      lanes: "2",
      runner_new__0: "gpu-node-1=k8s-a||gpu-node-1|device-plugin",
      runner_new_pool__0: "judge",
      // A row with no GPU chosen adds nothing.
      runner_new__1: "",
      runner_new_pool__1: "shared",
    };
    // A core with no GPU and runners, none of them the judge's, is refused in words.
    assert.match(
      await s.post("/ui/rigs/add", { ...form, runner_new_pool__0: "lane-1" }),
      /Give the judge a runner, its own or a shared one: the core has no GPU to measure on\./,
    );
    assert.equal(s.store.clusters.rig("core-2"), undefined, "nothing was set up");
    assert.equal(await s.post("/ui/rigs/add", form), "/ui/rigs/core-2");
    await settle(f, 2);
    const applies = f.calls
      .filter((c) => c.args[0] === "apply")
      .map((c) => JSON.parse(c.stdin ?? "{}").items as Obj[]);
    const core = applies[0]?.find(
      (o) => o.kind === "Deployment" && o.metadata.name === "thermite-core-2-harness",
    );
    assert.equal(envOf(core).THERMITE_LOCAL_JUDGE, "0", "the core's judge measures on its runners");
    assert.equal(s.store.clusters.rig("core-2")?.spec.node, "gpu-node-1", "on the node chosen");
    // The Rigs list shows it before its first report, as control sets it up.
    assert.match(
      await s.page("/ui/rigs"),
      /<span class="chip info">Setting up<\/span><\/td><td class="nowrap"><a class="kname" href="\/ui\/rigs\/core-2"><b>core-2<\/b>/,
    );
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

  test("Add a rig's Workers at a time waits on control for the new rig's report, then goes once", async () => {
    const { f, s } = await withRig({ workersWatchMs: 20 });
    const form = {
      kind: "many",
      place: "cluster:k8s-a",
      rig: "core-5",
      core_disk: "50",
      core_node: "gpu-node-1",
      lanes: "3",
      runner_new__0: "gpu-node-1=k8s-a||gpu-node-1|device-plugin",
      runner_new_pool__0: "judge",
    };
    assert.equal(await s.post("/ui/rigs/add", form), "/ui/rigs/core-5");
    await settle(f, 2);
    const lanes = () =>
      s.store.commands
        .pending("core-5")
        .map((c) => c.envelope)
        .filter((e) => e.kind === "rig_settings" && "lanes" in (e.payload as object));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lanes(), [], "nothing goes to a rig that does not report its settings");
    // Kept in control's store, so a restart of control loses nothing while the rig comes up.
    assert.equal(s.store.rigWorkers.get("core-5")?.lanes, 3);
    await ingestReport(s.store, {
      rig: "core-5",
      ledger_id: "ledger-core-5",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { settings: { lanes: 1, promotion: "auto", runners: [] } },
    });
    for (let i = 0; i < 100 && !lanes().length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      lanes().map((e) => e.payload),
      [{ lanes: 3 }],
    );
    // As the owner who chose it: the rig takes its settings from the owner alone.
    assert.equal(lanes()[0]?.issued_by, "owner:ui");
    // Given once, while it is on its way; then the rig takes it, and nothing more is given.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lanes().length, 1);
    const id = String(lanes()[0]?.id);
    s.store.commands.confirmApplied("core-5", id, "delivered", "{}", new Date().toISOString());
    for (let i = 0; i < 100 && s.store.rigWorkers.get("core-5"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.store.rigWorkers.get("core-5"), undefined);
    assert.deepEqual(
      s.store.rigHistory
        .list("core-5")
        .filter((x) => x.step === "workers_given")
        .map((x) => x.ok),
      [true],
    );
  });

  test("a long rig and runner name is cut, with a hash, under Kubernetes' limits", () => {
    const unit = runnerUnit(
      "a-rig-with-a-rather-long-name-indeed",
      "and-a-runner-named-at-length-too",
    );
    assert.ok(unit.length <= 40, unit);
    assert.match(unit, /^a-rig-with-a-ra-and-a-runner-na-[0-9a-f]{8}$/);
    assert.notEqual(
      unit,
      runnerUnit("a-rig-with-a-rather-long-name-indeed", "and-a-runner-named-at-length-two"),
    );
  });
});

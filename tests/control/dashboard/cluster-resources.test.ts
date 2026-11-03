import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ingestReport } from "../../helpers/control-store.ts";
import {
  ADMIN,
  control,
  fakeCluster,
  KUBECONFIG,
  mcpWith,
  OPERATOR,
} from "../../helpers/fake-cluster.ts";

describe("a cluster rig's GPUs, CPUs and memory, changed from control (goal 118)", () => {
  type Container = {
    name: string;
    image: string;
    env?: { name: string; value: string }[];
    resources?: Record<string, Record<string, unknown>>;
  };
  type Items = {
    items: {
      kind: string;
      metadata: { name: string; namespace?: string };
      spec?: {
        replicas?: number;
        template?: { spec?: { containers: Container[] } };
        spec?: { devices?: { requests?: { exactly?: { count?: number } }[] } };
      };
    }[];
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const applied = (f: ReturnType<typeof fakeCluster>): Items =>
    JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as Items;
  const container = (list: Items, name: string) =>
    list.items
      .flatMap((d) => d.spec?.template?.spec?.containers ?? [])
      .find((c) => c.name === name);
  const envOf = (c: Container | undefined) =>
    Object.fromEntries((c?.env ?? []).map((e) => [e.name, e.value]));
  /** A cluster of one slot with a rig of `gpus` GPUs in it, running. */
  async function slotRig(
    rig: string,
    gpus: number,
    o: { quota?: Record<string, Record<string, string>>; drainWatchMs?: number } = {},
  ) {
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true },
      nodeGpus: 8,
      ...(o.quota ? { quota: o.quota } : {}),
    });
    const s = await control(f.k, o.drainWatchMs ? { drainWatchMs: o.drainWatchMs } : {});
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-g",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-g",
        rig,
        "k_gpus__k8s-g": String(gpus),
        "k_slot__k8s-g": "thermite-slot-1",
      }),
      `/ui/rigs/${rig}`,
    );
    await sleep(20);
    // Its first report (the fake cluster has no rig to send one) makes it running.
    s.store.clusters.setRigStatus(rig, "running");
    const report = async (summary: Record<string, unknown>) =>
      await ingestReport(s.store, {
        rig,
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary,
      });
    // Edit rig is for a rig that reported.
    await report({});
    return { f, s, report };
  }

  test("Edit rig moves a slot rig from 3 GPUs to 4 and onto the slot's new quota; only its deployments are applied", async () => {
    const quota: Record<string, Record<string, string>> = {
      "thermite-slot-1": { "requests.nvidia.com/gpu": "3" },
    };
    const { f, s } = await slotRig("gpu-1", 3, { quota });
    assert.equal(s.store.clusters.rig("gpu-1")?.spec.resources, undefined);
    // Edit rig: its GPUs, CPUs and memory, each label with its info icon, and what the slot allows.
    let edit = await s.page("/ui/rigs/gpu-1/edit");
    assert.match(
      edit,
      /<span class="lb">GPUs<i class="ii" tabindex="0" data-tip="How many GPUs the rig[^"]*harness pod asks for, through NVIDIA[^"]*device plugin: 1 to 16\./,
    );
    assert.match(edit, /name="k_gpus" type="number" min="1" max="16" step="1" value="3"/);
    assert.match(
      edit,
      /<span class="lb">CPUs<i class="ii" tabindex="0" data-tip="The rig[^"]*CPUs/,
    );
    assert.match(edit, /name="k_cpus" type="number" min="1.5" step="any" value=""/);
    assert.match(
      edit,
      /<span class="lb">Memory \(GiB\)<i class="ii" tabindex="0" data-tip="[^"]+"/,
    );
    assert.match(edit, /name="k_mem" type="number" min="6" step="any" value=""/);
    assert.match(edit, /The slot(&#39;|')s quota allows 3 GPUs, as control last read it/);
    assert.match(edit, /data-moves-say="Its pods restart with the new GPUs, CPUs and memory/);
    // The slot's operators give it a fourth GPU, 16 CPUs and 52 GiB.
    quota["thermite-slot-1"] = {
      "limits.cpu": "16",
      "limits.memory": "52Gi",
      "requests.nvidia.com/gpu": "4",
    };
    f.calls.length = 0;
    assert.equal(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "16", k_mem: "52" }),
      "/ui/rigs/gpu-1?ok=gpu-1's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory.",
    );
    assert.ok(
      f.calls.some((c) => c.args.join(" ") === "get resourcequota -n thermite-slot-1 -o json"),
      "the quota is read again",
    );
    // Only the two deployments: the secret with its tokens, the volume claim and the service stay.
    const list = applied(f);
    assert.deepEqual(
      list.items.map((o) => o.kind),
      ["Deployment", "Deployment"],
    );
    assert.ok(list.items.every((o) => o.metadata.namespace === "thermite-slot-1"));
    const harness = container(list, "harness");
    assert.deepEqual(harness?.resources, {
      requests: { cpu: "15500m", memory: "51200Mi" },
      limits: { cpu: "15500m", memory: "51200Mi", "nvidia.com/gpu": 4 },
    });
    assert.equal(envOf(harness).THERMITE_GPUS, "0,1,2,3");
    assert.equal(envOf(harness).THERMITE_JUDGE_GPUS, "2");
    assert.deepEqual(container(list, "supervisor")?.resources, {
      requests: { cpu: "500m", memory: "2048Mi" },
      limits: { cpu: "500m", memory: "2048Mi" },
    });
    // The images it runs: a change of size is not an image update.
    assert.equal(harness?.image, "registry.example.com/harness-cuda:1");
    const spec = s.store.clusters.rig("gpu-1")?.spec;
    assert.equal(spec?.gpus, 4);
    assert.equal(spec?.judgeGpus, 2);
    assert.deepEqual(spec?.resources, { cpus: 16, memoryGi: 52 });
    await sleep(20);
    let page = await s.page("/ui/rigs/gpu-1");
    assert.match(
      page,
      /Its deployments applied with new GPUs, CPUs or memory.*GPUs 3 → 4 \(2 for the judge, 2 for the agents\); CPUs and memory: namespace defaults → 16 CPUs, 52 GiB/s,
    );
    assert.match(page, /Its pods run with the new GPUs, CPUs or memory/);
    assert.match(page, /<dt>CPUs and memory<\/dt><dd>16 CPUs, 52 GiB/);
    assert.match(
      page,
      /4 through NVIDIA(&#39;|')s device plugin: 2 for the judge, 2 for the agents/,
    );
    // While it waits for a report from its new pods, another change is refused.
    assert.equal(s.store.clusters.rig("gpu-1")?.status, "updating");
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "12", k_mem: "52" }),
      /error=Not saved: gpu-1 is being updated: wait until its page shows it running, or failed\./,
    );
    // Above the quota: refused in words, and nothing is applied.
    s.store.clusters.setRigStatus("gpu-1", "running");
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "5", k_cpus: "16", k_mem: "52" }),
      /error=Not saved: The slot thermite-slot-1 allows 4 GPUs\./,
    );
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "17", k_mem: "52" }),
      /error=Not saved: The slot thermite-slot-1 allows 16 CPUs\./,
    );
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "0", k_cpus: "16", k_mem: "52" }),
      /error=Not saved: gpu-1 measures on GPUs, and can't move to none/,
    );
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"));
    // The same values: nothing to do.
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "16", k_mem: "52" }),
      /ok=Nothing changed\./,
    );
    // Both fields empty: back to the namespace's defaults.
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "", k_mem: "" }),
      /ok=gpu-1's pods restart with 4 GPUs \(2 for the judge, 2 for the agents\), the namespace's default CPUs and memory\./,
    );
    assert.equal(s.store.clusters.rig("gpu-1")?.spec.resources, undefined);
    s.store.clusters.setRigStatus("gpu-1", "running");
    edit = await s.page("/ui/rigs/gpu-1/edit");
    assert.match(edit, /name="k_gpus" type="number" min="1" max="16" step="1" value="4"/);
    page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /<dt>CPUs and memory<\/dt><dd>the namespace(&#39;|')s defaults/);
  });

  test("an operator changes GPUs, CPUs and memory over MCP, not the judge's share; a share the rig kept follows; REST is the owner's twin", async () => {
    const { f, s, report } = await slotRig("gpu-2", 3);
    // The rig keeps a judge's share from Edit rig: 1 of its 3 GPUs.
    await report({ settings: { judge_gpus: 1 }, gpu_split: { set: 3, judge: 1 } });
    const op = await mcpWith(s.api, OPERATOR);
    f.calls.length = 0;
    const refused = await op.call("set_cluster_rig_resources", {
      rig: "gpu-2",
      gpus: 4,
      judge_gpus: 1,
    });
    assert.ok(refused.error);
    assert.match(
      String(refused.body.error),
      /^Only the owner's token changes a rig's GPU split: leave out judge_gpus\./,
    );
    assert.equal(s.store.clusters.rig("gpu-2")?.spec.gpus, 3);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "nothing changed");
    f.calls.length = 0;
    assert.deepEqual(
      await op.call("set_cluster_rig_resources", {
        rig: "gpu-2",
        gpus: 4,
        cpus: 8,
        memory_gib: 32,
      }),
      {
        error: false,
        body: {
          rig: "gpu-2",
          said: "gpu-2's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 8 CPUs and 32 GiB of memory.",
        },
      },
    );
    assert.equal(envOf(container(applied(f), "harness")).THERMITE_JUDGE_GPUS, "2");
    // The share it kept (1) would come first in its harness: it follows the new default, sent as
    // the one who asked (the operator acts for the owner).
    const sent = s.store.commands
      .pending("gpu-2")
      .map((c) => c.envelope)
      .filter((e) => e.kind === "rig_settings");
    assert.deepEqual(
      sent.map((e) => [e.payload, e.issued_by]),
      [[{ judge_gpus: 2 }, "owner:operator"]],
    );
    assert.match(
      s.store.rigHistory
        .list("gpu-2")
        .map((e) => e.detail ?? "")
        .join("\n"),
      /the judge's share it kept, 1, → 2/,
    );
    s.store.clusters.setRigStatus("gpu-2", "running");
    const setup = await op.call("rig_setup", { rig: "gpu-2" });
    assert.equal(setup.body.gpus, 4);
    assert.equal(setup.body.judge_gpus, 2);
    assert.equal(setup.body.cpus, 8);
    assert.equal(setup.body.memory_gib, 32);
    assert.equal(setup.body.pending, null);
    // The owner gives the judge's share with a new number of GPUs; not without one.
    const own = await mcpWith(s.api, ADMIN);
    assert.equal(
      (await own.call("set_cluster_rig_resources", { rig: "gpu-2", gpus: 6, judge_gpus: 4 })).body
        .said,
      "gpu-2's pods restart with 6 GPUs (4 for the judge, 2 for the agents), 8 CPUs and 32 GiB of memory.",
    );
    s.store.clusters.setRigStatus("gpu-2", "running");
    assert.match(
      String(
        (await own.call("set_cluster_rig_resources", { rig: "gpu-2", judge_gpus: 3 })).body.error,
      ),
      /^judge_gpus goes with a new number of GPUs\. To change the split of gpu-2's 6 GPUs alone, use GPUs for the judge on Edit rig, or set_rig_settings\./,
    );
    assert.match(
      String((await own.call("set_cluster_rig_resources", { rig: "nope", cpus: 8 })).body.error),
      /Control didn't set nope up on a cluster/,
    );
    await op.close();
    await own.close();
    // REST: the owner's token.
    const rest = (body: unknown, rig = "gpu-2", token = ADMIN) =>
      s.api.request(`/v1/rigs/${rig}/cluster/resources`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let r = await rest({ cpus: 12, memory_gib: 40 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      rig: "gpu-2",
      said: "gpu-2's pods restart with 6 GPUs (4 for the judge, 2 for the agents), 12 CPUs and 40 GiB of memory.",
    });
    r = await rest({ cpus: 8 });
    assert.equal(r.status, 409);
    assert.match(String(((await r.json()) as { error: string }).error), /gpu-2 is being updated/);
    s.store.clusters.setRigStatus("gpu-2", "running");
    r = await rest({ gpus: 0 });
    assert.equal(r.status, 400);
    assert.match(String(((await r.json()) as { error: string }).error), /can't move to none/);
    assert.equal((await rest({ storage_gb: 200 })).status, 400);
    assert.equal((await rest({ cpus: 8 }, "nope")).status, 404);
    assert.equal((await rest({ cpus: 8 }, "gpu-2", OPERATOR)).status, 401);
  });

  test("a busy rig drains before its new size: Call the change off, Change now, and the watcher once nothing runs", async () => {
    const { f, s, report } = await slotRig("gpu-3", 3, { drainWatchMs: 20 });
    await report({ work: { trials: 1, judge_jobs: 0, draining: null } });
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/gpu-3/edit", { k_gpus: "4", k_cpus: "", k_mem: "" }),
      /ok=gpu-3 drains first: it starts nothing new, and its pods restart with 4 GPUs \(2 for the judge, 2 for the agents\), the namespace's default CPUs and memory once 1 trial finishes\./,
    );
    let r = s.store.clusters.rig("gpu-3");
    assert.equal(r?.status, "draining");
    // Its report gives no mode (an older harness), so its supervisor's share is the headless one.
    assert.deepEqual(r?.pending, {
      gpus: 4,
      judgeGpus: 2,
      programMode: "headless",
      by: "owner:ui",
    });
    assert.equal(r?.spec.gpus, 3);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "no restart yet");
    assert.deepEqual(
      s.store.commands
        .pending("gpu-3")
        .map((c) => c.envelope)
        .filter((e) => e.kind === "drain_rig")
        .map((e) => e.payload),
      [{ drain: true, reason: "its GPUs, CPUs or memory are about to change" }],
    );
    const page = await s.page("/ui/rigs/gpu-3");
    assert.match(
      page,
      /Draining before its pods restart with 4 GPUs \(2 for the judge, 2 for the agents\)/,
    );
    assert.match(page, /It waits for 1 trial to finish, and starts nothing new/);
    assert.match(page, /Change now, without waiting/);
    assert.match(page, /Call the change off/);
    // An image update meanwhile is refused: the drain is the change's.
    assert.match(
      await s.page(await s.post("/ui/rigs/gpu-3/cluster/images", {})),
      /gpu-3 is draining for a change to its GPUs, CPUs or memory/,
    );
    // Called off: back to work as it was.
    assert.match(
      await s.post("/ui/rigs/gpu-3/cluster/drain-cancel", {}),
      /ok=gpu-3 goes back to work with its GPUs, CPUs and memory as they were\./,
    );
    r = s.store.clusters.rig("gpu-3");
    assert.equal(r?.status, "running");
    assert.equal(r?.pending, undefined);
    assert.equal(r?.spec.gpus, 3);
    // Again, then Change now: its pods restart at once, while the trial still runs.
    await s.post("/ui/rigs/gpu-3/edit", { k_gpus: "4", k_cpus: "", k_mem: "" });
    assert.equal(s.store.clusters.rig("gpu-3")?.status, "draining");
    assert.match(
      await s.post("/ui/rigs/gpu-3/cluster/resources-now", {}),
      /ok=gpu-3's pods restart with 4 GPUs/,
    );
    assert.ok(f.calls.some((c) => c.args[0] === "apply"));
    r = s.store.clusters.rig("gpu-3");
    assert.equal(r?.spec.gpus, 4);
    assert.equal(r?.status, "updating");
    assert.equal(r?.pending, undefined);
    // Once more, to 5 GPUs: applied by the watcher when its report says nothing runs.
    s.store.clusters.setRigStatus("gpu-3", "running");
    await s.post("/ui/rigs/gpu-3/edit", { k_gpus: "5", k_cpus: "", k_mem: "" });
    assert.equal(s.store.clusters.rig("gpu-3")?.status, "draining");
    f.calls.length = 0;
    await report({ work: { trials: 1, judge_jobs: 0, draining: { since: "x", reason: "r" } } });
    await sleep(100);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "not while its trial runs");
    await report({ work: { trials: 0, judge_jobs: 0, draining: { since: "x", reason: "r" } } });
    for (let i = 0; i < 50 && !f.calls.some((c) => c.args[0] === "apply"); i++) await sleep(20);
    assert.equal(f.calls.filter((c) => c.args[0] === "apply").length, 1, "applied once");
    assert.equal(s.store.clusters.rig("gpu-3")?.spec.gpus, 5);
    assert.equal(s.store.clusters.rig("gpu-3")?.status, "updating");
    assert.match(
      s.store.rigHistory
        .list("gpu-3")
        .map((e) => `${e.step}: ${e.detail ?? ""}`)
        .join("\n"),
      /drain: nothing runs any more: its pods restart now\nresources: GPUs 4 → 5 \(3 for the judge, 2 for the agents\)/,
    );
  });

  test("a new mode for the agent programs moves the supervisor's share: REST, MCP, Edit rig and an image update carry it to the deployments; too little memory is refused in words (goal 169)", async () => {
    const { f, s, report } = await slotRig("cpu-m", 0, {
      quota: { "thermite-slot-1": { "limits.cpu": "16", "limits.memory": "52Gi" } },
    });
    const both = (cpu: string, memory: string) => ({
      requests: { cpu, memory },
      limits: { cpu, memory },
    });
    const shares = () => {
      const list = applied(f);
      return [container(list, "supervisor")?.resources, container(list, "harness")?.resources];
    };
    const settingsSent = () =>
      s.store.commands
        .pending("cpu-m")
        .map((c) => c.envelope)
        .filter((e) => e.kind === "rig_settings")
        .map((e) => e.payload);
    const running = async (mode: string) => {
      s.store.clusters.setRigStatus("cpu-m", "running");
      await report({ settings: { program_mode: mode } });
    };
    const rest = async (path: string, body: unknown) => {
      const r = await s.api.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const TOO_SMALL =
      "a rig needs at least 1.5 CPUs and 8 GiB of memory while its agent programs run in their own terminals: its supervisor takes 4 GiB for the advisors' terminals, and its harness at least 4 GiB";
    // Added, sized by its slot's quota: a new rig's agent programs run in their own terminals, so
    // its supervisor has 4 GiB of the 52 for the advisors' terminals.
    assert.deepEqual(shares(), [both("500m", "4096Mi"), both("15500m", "49152Mi")]);
    assert.equal(s.store.clusters.rig("cpu-m")?.spec.programMode, "terminal");
    await running("terminal");

    // Headless over REST: the setting goes first, then its pods restart with the supervisor's
    // headless share. Only its deployments are applied.
    f.calls.length = 0;
    const toHeadless = await rest("/v1/rigs/cpu-m/settings", { program_mode: "headless" });
    assert.equal(toHeadless.status, 200);
    assert.deepEqual(toHeadless.body.sent, { program_mode: "headless" });
    assert.equal(
      toHeadless.body.said,
      "Control sent 1 setting to cpu-m. The rig takes the change in less than one minute. Its supervisor gets 2 GiB, as its agent programs run headless: cpu-m's pods restart with 16 CPUs and 52 GiB of memory.",
    );
    assert.deepEqual(settingsSent(), [{ program_mode: "headless" }]);
    assert.deepEqual(
      applied(f).items.map((o) => o.kind),
      ["Deployment", "Deployment"],
    );
    assert.deepEqual(shares(), [both("500m", "2048Mi"), both("15500m", "51200Mi")]);
    assert.equal(s.store.clusters.rig("cpu-m")?.spec.programMode, "headless");
    assert.deepEqual(s.store.clusters.rig("cpu-m")?.spec.resources, { cpus: 16, memoryGi: 52 });
    assert.match(
      s.store.rigHistory
        .list("cpu-m")
        .map((e) => `${e.step}: ${e.detail ?? ""}`)
        .join("\n"),
      /resources: its supervisor's memory: 4 → 2 GiB, as its agent programs run headless/,
    );

    // Back to the terminals over MCP, as an operator.
    await running("headless");
    const op = await mcpWith(s.api, OPERATOR);
    f.calls.length = 0;
    const toTerminal = await op.call("set_rig_settings", {
      rig: "cpu-m",
      program_mode: "terminal",
    });
    assert.equal(toTerminal.error, false);
    assert.equal(toTerminal.body.restarts, false);
    assert.match(
      String(toTerminal.body.said),
      /Its supervisor gets 4 GiB, as its agent programs run in their own terminals: cpu-m's pods restart with 16 CPUs and 52 GiB of memory\.$/,
    );
    assert.deepEqual(shares(), [both("500m", "4096Mi"), both("15500m", "49152Mi")]);

    // In their own terminals, 6 GiB is too little: refused in words, and nothing is applied.
    await running("terminal");
    f.calls.length = 0;
    const small = await rest("/v1/rigs/cpu-m/cluster/resources", { cpus: 2, memory_gib: 6 });
    assert.deepEqual(small, { status: 400, body: { error: TOO_SMALL } });
    // Headless, it fits; then the terminals are refused before any setting is sent.
    await rest("/v1/rigs/cpu-m/settings", { program_mode: "headless" });
    await running("headless");
    f.calls.length = 0;
    assert.equal(
      (await rest("/v1/rigs/cpu-m/cluster/resources", { cpus: 2, memory_gib: 6 })).body.said,
      "cpu-m's pods restart with 2 CPUs and 6 GiB of memory.",
    );
    assert.deepEqual(shares(), [both("500m", "2048Mi"), both("1500m", "4096Mi")]);
    s.store.clusters.setRigStatus("cpu-m", "running");
    f.calls.length = 0;
    const sent = settingsSent().length;
    const refused = await op.call("set_rig_settings", { rig: "cpu-m", program_mode: "terminal" });
    assert.ok(refused.error);
    assert.equal(refused.body.error, `Not saved: ${TOO_SMALL}`);
    assert.equal(settingsSent().length, sent, "no setting sent");
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "nothing applied");
    await op.close();

    // An image update gives the supervisor the share of the mode its report gives now: a rig set
    // to its terminals elsewhere (here, its report) is refused before it drains.
    await report({ settings: { program_mode: "terminal" } });
    const later = await control(f.k, { store: s.store, secrets: s.secrets, tag: "2" });
    assert.match(
      await later.page(await later.post("/ui/rigs/cpu-m/cluster/images", {})),
      /cpu-m has 2 CPUs, 6 GiB, and a rig needs at least 1\.5 CPUs and 8 GiB of memory while its agent programs run in their own terminals/,
    );
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "nothing applied");
    assert.equal(
      s.store.clusters.rig("cpu-m")?.spec.images.harness,
      "registry.example.com/harness:1",
    );
    await report({ settings: { program_mode: "headless" } });
    assert.match(
      await later.post("/ui/rigs/cpu-m/cluster/images", {}),
      /ok=cpu-m's pods restart on the new images\./,
    );
    assert.deepEqual(shares(), [both("500m", "2048Mi"), both("1500m", "4096Mi")]);
    assert.equal(s.store.clusters.rig("cpu-m")?.spec.programMode, "headless");

    // Edit rig: Memory says the share for the mode it runs, a new mode is said with the restart of
    // its pods, and one Save gives it 8 GiB and the terminals.
    await running("headless");
    const edit = await s.page("/ui/rigs/cpu-m/edit");
    assert.match(
      edit,
      /the supervisor gets 2 GiB while its agent programs run headless \(4 GiB in their own terminals\), the harness the rest\. At least 6 GiB\./,
    );
    assert.match(
      edit,
      /<select name="program_mode" data-label="how agent programs run" data-moves>/,
    );
    f.calls.length = 0;
    const parts = ["judge", "workers", "planner", "teachers", "auditor", "review", "exports"];
    const saved = await s.post("/ui/rigs/cpu-m/edit", {
      ...Object.fromEntries(parts.map((p) => [p, "1"])),
      k_cpus: "2",
      k_mem: "8",
      program_mode: "terminal",
    });
    assert.match(
      saved,
      /ok=Control sent 1 setting to cpu-m\. The rig takes the change in less than one minute\. Its supervisor gets 4 GiB, as its agent programs run in their own terminals: cpu-m's pods restart with 2 CPUs and 8 GiB of memory\./,
    );
    assert.deepEqual(settingsSent().at(-1), { program_mode: "terminal" });
    assert.deepEqual(shares(), [both("500m", "4096Mi"), both("1500m", "4096Mi")]);
    assert.equal(s.store.clusters.rig("cpu-m")?.spec.programMode, "terminal");

    // A rig at work drains first, and the change it waits for carries the new mode.
    s.store.clusters.setRigStatus("cpu-m", "running");
    await report({
      settings: { program_mode: "terminal" },
      work: { trials: 1, judge_jobs: 0, draining: null },
    });
    f.calls.length = 0;
    const busy = await rest("/v1/rigs/cpu-m/settings", { program_mode: "headless" });
    assert.match(
      String(busy.body.said),
      /Its supervisor gets 2 GiB, as its agent programs run headless: cpu-m drains first: it starts nothing new, and its pods restart with 2 CPUs and 8 GiB of memory once 1 trial finishes\./,
    );
    assert.equal(s.store.clusters.rig("cpu-m")?.status, "draining");
    assert.deepEqual(s.store.clusters.rig("cpu-m")?.pending, {
      gpus: 0,
      resources: { cpus: 2, memoryGi: 8 },
      programMode: "headless",
      by: "owner:api",
    });
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "no restart yet");
    // Another mode meanwhile would replace the change it waits for: refused, nothing sent.
    await report({
      settings: { program_mode: "headless" },
      work: { trials: 1, judge_jobs: 0, draining: { since: "x", reason: "r" } },
    });
    const sentBefore = settingsSent().length;
    const meanwhile = await rest("/v1/rigs/cpu-m/settings", { program_mode: "terminal" });
    assert.equal(meanwhile.status, 409);
    assert.match(
      String(meanwhile.body.error),
      /^Not saved: cpu-m is draining for a change to its GPUs, CPUs or memory/,
    );
    assert.equal(settingsSent().length, sentBefore);
    // Change now applies the change it waits for, with the supervisor's headless share.
    assert.match(
      await s.post("/ui/rigs/cpu-m/cluster/resources-now", {}),
      /ok=Its supervisor gets 2 GiB, as its agent programs run headless: cpu-m's pods restart with 2 CPUs and 8 GiB of memory\./,
    );
    assert.deepEqual(shares(), [both("500m", "2048Mi"), both("1500m", "6144Mi")]);
  });

  test("DRA: a new claim template for the new count, the old one deleted first; a stopped rig stays stopped; a CPU rig takes no GPUs", async () => {
    const f = fakeCluster({ deviceClasses: ["gpu.nvidia.com"] });
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-d",
      kubeconfig: KUBECONFIG,
      placement: "created",
      namespace_pattern: "thermite-{rig}",
    });
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-d",
        rig: "dra-1",
        "k_gpus__k8s-d": "2",
        "k_mode__k8s-d": "dra:gpu.nvidia.com",
      }),
      "/ui/rigs/dra-1",
    );
    await sleep(20);
    s.store.clusters.setRigStatus("dra-1", "running");
    const reported = async (rig: string) =>
      await ingestReport(s.store, {
        rig,
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: {},
      });
    await reported("dra-1");
    assert.match(await s.post("/ui/rigs/dra-1/cluster/stop", {}), /ok=Stopped/);
    assert.match(
      await s.page("/ui/rigs/dra-1/edit"),
      /through DRA, the device class gpu\.nvidia\.com: 1 to 16/,
    );
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/dra-1/edit", { k_gpus: "4", k_cpus: "6", k_mem: "24" }),
      /ok=dra-1 has 4 GPUs \(2 for the judge, 2 for the agents\), 6 CPUs and 24 GiB of memory when it starts again\./,
    );
    const del = f.calls.findIndex(
      (c) =>
        c.args.join(" ") ===
        "delete resourceclaimtemplate thermite-dra-1-gpus -n thermite-dra-1 --ignore-not-found",
    );
    const apply = f.calls.findIndex((c) => c.args[0] === "apply");
    assert.ok(del >= 0 && apply > del, "the old template goes first");
    const list = applied(f);
    assert.deepEqual(
      list.items.map((o) => o.kind),
      ["ResourceClaimTemplate", "Deployment", "Deployment"],
    );
    assert.equal(list.items[0]?.spec?.spec?.devices?.requests?.[0]?.exactly?.count, 4);
    // Stopped, it stays stopped.
    assert.deepEqual(
      list.items.filter((o) => o.kind === "Deployment").map((o) => o.spec?.replicas),
      [0, 0],
    );
    assert.deepEqual(container(list, "harness")?.resources, {
      requests: { cpu: "5500m", memory: "22528Mi" },
      limits: { cpu: "5500m", memory: "22528Mi" },
      claims: [{ name: "gpus" }],
    });
    assert.equal(s.store.clusters.rig("dra-1")?.status, "stopped");
    assert.match(
      s.store.rigHistory
        .list("dra-1")
        .map((e) => e.detail ?? "")
        .join("\n"),
      /GPUs 2 → 4 \(2 for the judge, 2 for the agents\); CPUs and memory: namespace defaults → 6 CPUs, 24 GiB; at its next start/,
    );
    // Only CPUs and memory: the claim template stays.
    f.calls.length = 0;
    await s.post("/ui/rigs/dra-1/edit", { k_gpus: "4", k_cpus: "8", k_mem: "24" });
    assert.ok(!f.calls.some((c) => c.args[0] === "delete"));
    // A rig on the CPU has no GPUs field, and takes no GPUs.
    assert.equal(
      await s.post("/ui/rigs/add", { place: "cluster:k8s-d", rig: "cpu-5", "k_gpus__k8s-d": "0" }),
      "/ui/rigs/cpu-5",
    );
    await sleep(20);
    s.store.clusters.setRigStatus("cpu-5", "running");
    await reported("cpu-5");
    const edit = await s.page("/ui/rigs/cpu-5/edit");
    assert.doesNotMatch(edit, /name="k_gpus"/);
    assert.match(edit, /name="k_cpus"/);
    assert.match(edit, /It measures on the CPU: a rig on the CPU can(&#39;|')t take GPUs/);
    assert.match(
      await s.post("/ui/rigs/cpu-5/edit", { k_gpus: "1", k_cpus: "", k_mem: "" }),
      /error=Not saved: cpu-5 measures on the CPU, and can't take GPUs/,
    );
  });
});

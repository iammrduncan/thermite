import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpClient } from "../../helpers/control-stack.ts";
import { answerCommand, ingestReport } from "../../helpers/control-store.ts";
import { control, fakeCluster, KUBECONFIG } from "../../helpers/fake-cluster.ts";

describe("clusters in Providers and Add a rig", () => {
  test("a cluster is added and checked; a rig is applied into a namespace of its own and managed", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    // kubectl's own words come back on the page; its address names them by an ID.
    const notYaml = await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-a",
      kubeconfig: "not yaml",
    });
    assert.match(notYaml, /error=note-[0-9a-f]+/);
    assert.match(await s.page(notYaml), /not a kubeconfig/);
    // A kubeconfig that would run a command or read a file inside control is refused.
    assert.match(
      await s.post("/ui/settings/add", {
        type: "k8s",
        name: "k8s-a",
        kubeconfig: `${KUBECONFIG}# exec:`,
      }),
      /Not added: user "u" runs a command \(exec\) to log in.*cluster "c" reads a file \(certificate-authority\)/,
    );
    assert.match(
      await s.post("/ui/settings/add", {
        type: "k8s",
        name: "k8s-a",
        kubeconfig: KUBECONFIG,
        context: "nope",
      }),
      /has no context "nope"/,
    );
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
    const k = s.store.clusters.get("k8s-a");
    assert.equal(k?.context, "kind-thermite");
    assert.equal(s.secrets.open(k?.kubeconfig_sealed ?? ""), KUBECONFIG.trim());
    let page = await s.page("/ui/settings");
    assert.match(page, /class="kind r">Cluster</);
    assert.match(page, /Kubernetes v1\.35\.2 · 1 node, 1 with 2 GPUs · storage standard/);
    assert.match(page, /control may create namespaces/);
    assert.ok(!page.includes("secret-kube-token-789"));
    // Add a rig offers it, with its GPUs, nodes and storage.
    const add = await s.page("/ui/rigs/add");
    assert.match(add, /name="place" value="cluster:k8s-a"/);
    assert.match(add, /name="k_gpus__k8s-a"/);
    assert.match(add, /NVIDIA&#39;s device plugin|NVIDIA's device plugin/);
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-a",
        rig: "k8s-a-1",
        "k_gpus__k8s-a": "1",
        "k_mode__k8s-a": "device-plugin",
        "k_node__k8s-a": "gpu-node-1",
        "k_storage__k8s-a": "standard",
        "k_size__k8s-a": "50",
      }),
      "/ui/rigs/k8s-a-1",
    );
    await new Promise((r) => setTimeout(r, 20));
    const apply = f.calls.find((c) => c.args[0] === "apply");
    assert.deepEqual(apply?.args, ["apply", "-f", "-"]);
    const list = JSON.parse(apply?.stdin ?? "{}") as {
      items: { kind: string; metadata: { name: string; namespace?: string } }[];
    };
    assert.equal(list.items[0]?.kind, "Namespace");
    assert.equal(list.items[0]?.metadata.name, "thermite-k8s-a-1");
    assert.match(apply?.stdin ?? "", /"nvidia.com\/gpu":1/);
    assert.match(apply?.stdin ?? "", /registry\.example\.com\/harness-cuda:1/);
    assert.ok(s.store.enrollments.rig("k8s-a-1"));
    page = await s.page("/ui/rigs/k8s-a-1");
    assert.match(page, /Control is setting k8s-a-1 up on k8s-a/);
    assert.match(page, /Its objects applied in the cluster/);
    assert.match(page, /1 through NVIDIA&#39;s device plugin|1 through NVIDIA's device plugin/);
    // Stop and start scale its deployments; remove deletes its namespace and retires its token.
    assert.match(await s.post("/ui/rigs/k8s-a-1/cluster/stop", {}), /ok=Stopped/);
    assert.ok(
      f.calls.some(
        (c) =>
          c.args.join(" ") ===
          "scale deployment -n thermite-k8s-a-1 -l app.kubernetes.io/instance=k8s-a-1 --replicas=0",
      ),
    );
    assert.match(
      await s.post("/ui/rigs/k8s-a-1/cluster/remove", { confirm: "remove k8s" }),
      /Type "remove k8s-a-1"/,
    );
    // Its supervisor never reported: refused, until the owner discards what it holds (goal 165).
    assert.match(
      await s.post("/ui/rigs/k8s-a-1/cluster/remove", { confirm: "remove k8s-a-1" }),
      /k8s-a-1 still holds results: the rig's supervisor has not reported yet\./,
    );
    assert.ok(!f.calls.some((c) => c.args[0] === "delete"));
    assert.match(
      await s.post("/ui/rigs/k8s-a-1/cluster/remove", { confirm: "discard k8s-a-1" }),
      /ok=Removed from the cluster/,
    );
    assert.deepEqual(s.store.auditLog.list(1, { action: "cluster_rig_remove" })[0]?.body, {
      rig: "k8s-a-1",
      cluster: "k8s-a",
      discarded: "the rig's supervisor has not reported yet",
    });
    assert.ok(
      f.calls.some(
        (c) =>
          c.args.join(" ") === "delete namespace thermite-k8s-a-1 --wait=false --ignore-not-found",
      ),
    );
    assert.equal(s.store.clusters.rig("k8s-a-1")?.status, "removed");
    assert.equal(s.store.enrollments.rig("k8s-a-1"), undefined);
    assert.match(await s.post("/ui/settings/clusters/k8s-a/delete", {}), /"k8s-a" is deleted/);
  });

  test("slots: only free slots control may use; nothing created outside the slot", async () => {
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true, "thermite-slot-2": false, "thermite-slot-3": true },
    });
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-b",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1, thermite-slot-2, thermite-slot-3",
    });
    const page = await s.page("/ui/settings");
    assert.match(page, /thermite-slot-1: <span class="chip ok">free/);
    assert.match(page, /thermite-slot-2: <span class="chip warn">control may not deploy here/);
    // A slot whose rules don't keep the harness off the cluster is refused.
    assert.match(
      page,
      /thermite-slot-3: <span class="chip warn">refused: no network rule in the slot limits/,
    );
    assert.match(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-b",
        rig: "k8s-b-3",
        "k_gpus__k8s-b": "0",
        "k_slot__k8s-b": "thermite-slot-3",
      }),
      /Refused: in the slot thermite-slot-3, no network rule in the slot limits where the harness may connect/,
    );
    assert.match(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-b",
        rig: "k8s-b-1",
        "k_gpus__k8s-b": "0",
        "k_slot__k8s-b": "thermite-slot-2",
      }),
      /Choose a free slot/,
    );
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-b",
        rig: "k8s-b-1",
        "k_gpus__k8s-b": "0",
        "k_slot__k8s-b": "thermite-slot-1",
      }),
      "/ui/rigs/k8s-b-1",
    );
    await new Promise((r) => setTimeout(r, 20));
    const list = JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as {
      items: { kind: string; metadata: { namespace?: string } }[];
    };
    assert.ok(!list.items.some((o) => o.kind === "Namespace" || o.kind === "NetworkPolicy"));
    assert.ok(list.items.every((o) => o.metadata.namespace === "thermite-slot-1"));
    s.store.reportedRigs.setSupervisor("k8s-b-1", {
      export: { remote: true, to: "repository", waiting: 0 },
    });
    assert.match(
      await s.post("/ui/rigs/k8s-b-1/cluster/remove", { confirm: "remove k8s-b-1" }),
      /ok=Removed/,
    );
    assert.ok(
      f.calls.some((c) =>
        c.args
          .join(" ")
          .startsWith("delete deployment,service,persistentvolumeclaim,secret -n thermite-slot-1"),
      ),
    );
  });

  test("a rig moves onto the images control now deploys; its secret, volume and tokens stay", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    assert.equal(
      await before.post("/ui/rigs/add", {
        place: "cluster:k8s-c",
        rig: "cpu-1",
        "k_gpus__k8s-c": "0",
        "k_slot__k8s-c": "thermite-slot-1",
      }),
      "/ui/rigs/cpu-1",
    );
    await new Promise((r) => setTimeout(r, 20));
    // Its first report (the fake cluster has no rig to send one) makes it running.
    before.store.clusters.setRigStatus("cpu-1", "running");
    assert.doesNotMatch(await before.page("/ui/rigs/cpu-1"), /Update to these images/);
    assert.match(
      await before.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 already runs control's images/,
    );
    // Control now deploys other images (after its own update): the rig's page offers them.
    const s = await control(f.k, { store: before.store, secrets: before.secrets, tag: "2" });
    let page = await s.page("/ui/rigs/cpu-1");
    assert.match(page, /Control now deploys other images:.*registry\.example\.com\/harness:2/s);
    assert.match(page, /Update to these images/);
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
    type Items = {
      items: {
        kind: string;
        metadata: { namespace?: string };
        spec?: { replicas?: number; template?: { spec?: { containers: { image: string }[] } } };
      }[];
    };
    const applied = (): Items =>
      JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as Items;
    // Only the two deployments: the secret with its tokens, the volume claim and the service stay.
    let list = applied();
    assert.deepEqual(
      list.items.map((o) => o.kind),
      ["Deployment", "Deployment"],
    );
    assert.ok(list.items.every((o) => o.metadata.namespace === "thermite-slot-1"));
    assert.deepEqual(
      list.items.flatMap((d) => d.spec?.template?.spec?.containers.map((c) => c.image)),
      ["registry.example.com/harness:2", "registry.example.com/supervisor:2"],
    );
    assert.deepEqual(s.store.clusters.rig("cpu-1")?.spec.images, {
      harness: "registry.example.com/harness:2",
      supervisor: "registry.example.com/supervisor:2",
    });
    await new Promise((r) => setTimeout(r, 20));
    page = await s.page("/ui/rigs/cpu-1");
    assert.match(
      page,
      /Its deployments applied with new images.*harness registry\.example\.com\/harness:1 → registry\.example\.com\/harness:2/s,
    );
    assert.match(page, /Its pods run the new images/);
    assert.doesNotMatch(page, /Update to these images/);
    // While it waits for a report from the new images, another change is refused; a report after
    // a failed wait shows it running again.
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "updating");
    const busy = await control(f.k, { store: s.store, secrets: s.secrets, tag: "9" });
    assert.match(
      await busy.page(await busy.post("/ui/rigs/cpu-1/cluster/images", {})),
      /cpu-1 is being updated/,
    );
    assert.match(
      await busy.page(await busy.post("/ui/rigs/cpu-1/cluster/restart", {})),
      /cpu-1 is updating/,
    );
    // A stopped rig stays stopped: it runs the new images when it starts again.
    assert.match(await s.post("/ui/rigs/cpu-1/cluster/stop", {}), /ok=Stopped/);
    const later = await control(f.k, { store: s.store, secrets: s.secrets, tag: "3" });
    f.calls.length = 0;
    assert.match(
      await later.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 runs the new images when it starts again/,
    );
    list = applied();
    assert.deepEqual(
      list.items.map((d) => d.spec?.replicas),
      [0, 0],
    );
    assert.equal(later.store.clusters.rig("cpu-1")?.status, "stopped");
    // Without control's address for rigs, the update is refused: the rig would lose its way back.
    const lost = await control(f.k, {
      store: s.store,
      secrets: s.secrets,
      tag: "4",
      publicUrl: null,
    });
    assert.match(
      await lost.page(await lost.post("/ui/rigs/cpu-1/cluster/images", {})),
      /Control's address for rigs is not set/,
    );
    // The same images, but control's address changed: the update carries the new address.
    const moved = await control(f.k, {
      store: s.store,
      secrets: s.secrets,
      tag: "3",
      publicUrl: "https://control2.example.com",
    });
    assert.match(
      await moved.page("/ui/rigs/cpu-1"),
      /Control's address for rigs changed: the rig reports to <span class="mono">https:\/\/control\.example\.com<\/span>, control is now at <span class="mono">https:\/\/control2\.example\.com<\/span>[\s\S]*Give it control's new address/,
    );
    f.calls.length = 0;
    assert.match(
      await moved.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 gets control's new address when it starts again/,
    );
    assert.equal(
      moved.store.clusters.rig("cpu-1")?.spec.controlUrl,
      "https://control2.example.com",
    );
    assert.doesNotMatch(await moved.page("/ui/rigs/cpu-1"), /Give it control/);
    // After a failed change, the same images are offered again as a retry.
    moved.store.clusters.setRigStatus("cpu-1", "failed");
    assert.match(await moved.page("/ui/rigs/cpu-1"), /Try the update again/);
    moved.store.clusters.setRigStatus("cpu-1", "stopped");
    assert.match(
      String(f.calls.find((c) => c.args[0] === "apply")?.stdin),
      /control2\.example\.com/,
    );
    // And with the same address, nothing to do.
    const same = await control(f.k, { store: s.store, secrets: s.secrets, tag: "3" });
    assert.match(
      await same.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 already runs control's images/,
    );
  });

  test("a busy rig drains before its update: its pods restart once nothing runs; Update now skips the wait (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.clusters.setRigStatus("cpu-1", "running");
    // The rig reports what still runs: two trials and the judge's job.
    const report = async (work: Record<string, unknown>) =>
      await ingestReport(before.store, {
        rig: "cpu-1",
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { work },
      });
    await report({ trials: 2, judge_jobs: 1, draining: null });
    const s = await control(f.k, { store: before.store, secrets: before.secrets, tag: "2" });
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 drains first: it starts nothing new, and its pods restart on the new images once 2 trials and the judge's job finish/,
    );
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "draining");
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "no restart yet");
    const sent = s.store.commands.pending("cpu-1").map((c) => c.envelope);
    assert.deepEqual(
      sent.filter((e) => e.kind === "drain_rig").map((e) => e.payload),
      [{ drain: true, reason: "its images are about to change" }],
    );
    // Its page says what it waits for, with the two ways out.
    const page = await s.page("/ui/rigs/cpu-1");
    assert.match(page, /Draining before its pods restart on control's images/);
    assert.match(page, /It waits for 2 trials and the judge's job to finish/);
    assert.match(page, /Update now, without waiting/);
    assert.match(page, /Call the update off/);
    // Asked again, it goes on waiting; called off, the rig goes back to work.
    assert.match(await s.post("/ui/rigs/cpu-1/cluster/images", {}), /ok=cpu-1 is draining/);
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/drain-cancel", {}),
      /ok=cpu-1 goes back to work on its images/,
    );
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "running");
    assert.deepEqual(
      s.store.commands
        .pending("cpu-1")
        .map((c) => c.envelope)
        .filter((e) => e.kind === "drain_rig")
        .map((e) => (e.payload as { drain: boolean }).drain),
      [true, false],
    );
    // Drained again, then Update now: its pods restart at once, while work still runs.
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images-now", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
    assert.ok(f.calls.some((c) => c.args[0] === "apply"));
    // An idle rig is updated at once, with no drain.
    s.store.clusters.setRigStatus("cpu-1", "running");
    await report({ trials: 0, judge_jobs: 0, draining: null });
    const idle = await control(f.k, { store: s.store, secrets: s.secrets, tag: "3" });
    assert.match(
      await idle.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
  });

  test("a draining rig's pods restart once its report says nothing runs (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.clusters.setRigStatus("cpu-1", "running");
    const report = async (work: Record<string, unknown>) =>
      await ingestReport(before.store, {
        rig: "cpu-1",
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { work },
      });
    await report({ trials: 1, judge_jobs: 0, draining: null });
    const s = await control(f.k, {
      store: before.store,
      secrets: before.secrets,
      tag: "2",
      drainWatchMs: 20,
    });
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    f.calls.length = 0;
    // The rig took the drain, and its trial still runs: no restart.
    await report({ trials: 1, judge_jobs: 0, draining: { since: "x", reason: "r" } });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"));
    // Its trial ended and the judge has no job: the pods restart on the new images.
    await report({ trials: 0, judge_jobs: 0, draining: { since: "x", reason: "r" } });
    for (let i = 0; i < 50 && !f.calls.some((c) => c.args[0] === "apply"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      f.calls.some((c) => c.args[0] === "apply"),
      "restarted once nothing ran",
    );
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "updating");
  });

  test("a harness that started again while draining is asked to drain again, once (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.clusters.setRigStatus("cpu-1", "running");
    const report = async (work: Record<string, unknown>) =>
      await ingestReport(before.store, {
        rig: "cpu-1",
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { work },
      });
    await report({ trials: 1, judge_jobs: 0, draining: null });
    const s = await control(f.k, {
      store: before.store,
      secrets: before.secrets,
      tag: "2",
      drainWatchMs: 20,
    });
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    const drains = () =>
      s.store.commands.latest("cpu-1", "drain_rig").filter((c) => c.payload.drain === true);
    // Not yet taken: the report without a drain is not a reason to ask again.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drains().length, 1);
    // Taken; one report after it without the drain may have been read before it took effect.
    const first = drains()[0];
    assert.ok(first);
    answerCommand(s.store, "cpu-1", first.id, "delivered", {});
    await new Promise((r) => setTimeout(r, 5));
    await report({ trials: 1, judge_jobs: 0, draining: null });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drains().length, 1);
    // The next report has no drain either: the harness started again and forgot it.
    await report({ trials: 1, judge_jobs: 0, draining: null });
    for (let i = 0; i < 50 && drains().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(drains().length, 2);
    assert.match(
      s.store.rigHistory
        .list("cpu-1")
        .map((e) => e.detail ?? "")
        .join("\n"),
      /its harness started again and was not draining: asked again/,
    );
    // The new ask is on its way: not asked a third time, and no restart while the trial runs.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drains().length, 2);
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "draining");
    // Its history names the step in words.
    assert.match(
      await s.page("/ui/rigs/cpu-1"),
      /Draining: it starts nothing new until its work ends/,
    );
  });

  test("Update to control's version moves a busy rig's pods at once: its runs are paused, so no drain (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.clusters.setRigStatus("cpu-1", "running");
    await ingestReport(before.store, {
      rig: "cpu-1",
      ledger_id: "l-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { work: { trials: 2, judge_jobs: 1, draining: null } },
    });
    const s = await control(f.k, { store: before.store, secrets: before.secrets, tag: "2" });
    f.calls.length = 0;
    await s.post("/ui/rigs/cpu-1/update", {});
    for (let i = 0; i < 100 && !f.calls.some((c) => c.args[0] === "apply"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      f.calls.some((c) => c.args[0] === "apply"),
      "its pods move now",
    );
    assert.equal(s.store.commands.latest("cpu-1", "drain_rig").length, 0);
    assert.notEqual(s.store.clusters.rig("cpu-1")?.status, "draining");
  });

  test("CPU slots: the quota sets the rig's CPUs and memory; slots added later; a rig added over MCP", async () => {
    const quota = { "limits.cpu": "6", "limits.memory": "24Gi", "requests.storage": "200Gi" };
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-2": true, "thermite-slot-3": true },
      ruled: ["thermite-slot-2", "thermite-slot-3"],
      quota: { "thermite-slot-2": quota, "thermite-slot-3": quota },
    });
    const { store, page, post, api } = await control(f.k);
    await post("/ui/settings/add", {
      type: "k8s",
      name: "lab",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-2",
    });
    // A slot added later, from the cluster's row: read again with its rules and quota.
    assert.match(
      await post("/ui/settings/clusters/lab/slots", { slots: "thermite-slot-2, thermite-slot-3" }),
      /"lab" now has 2 slots, read again/,
    );
    const add = await page("/ui/rigs/add");
    assert.match(add, /name="k_cpus__lab" inputmode="decimal" value="6"/);
    assert.match(add, /name="k_mem__lab" inputmode="decimal" value="24"/);
    assert.match(add, /name="k_size__lab" value="200"/);

    // Over MCP, as an operator: a rig in each slot, sized by the quota.
    const client = await mcpClient(api, "operator-token-abcdef");
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { error: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
    };
    const tooBig = await call("add_cluster_rig", {
      rig: "cpu-2",
      cluster: "lab",
      slot: "thermite-slot-2",
      cpus: 8,
      memory_gib: 24,
    });
    assert.ok(tooBig.error);
    assert.match(String(tooBig.body.error), /The slot thermite-slot-2 allows 6 CPUs/);
    const added = await call("add_cluster_rig", {
      rig: "cpu-2",
      cluster: "lab",
      slot: "thermite-slot-2",
    });
    assert.deepEqual(added, { error: false, body: { rig: "cpu-2", status: "deploying" } });
    await new Promise((r) => setTimeout(r, 20));
    const list = JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as {
      items: {
        kind: string;
        metadata: { name: string };
        spec?: {
          template?: {
            spec?: {
              containers: { name: string; resources?: unknown }[];
              initContainers: { resources?: unknown }[];
            };
          };
        };
      }[];
    };
    const pods = list.items.filter((o) => o.kind === "Deployment");
    const res = (name: string) =>
      pods.flatMap((d) => d.spec?.template?.spec?.containers ?? []).find((c) => c.name === name)
        ?.resources;
    const both = (cpu: string, memory: string) => ({
      requests: { cpu, memory },
      limits: { cpu, memory },
    });
    assert.deepEqual(res("harness"), both("5500m", "22528Mi"));
    assert.deepEqual(res("supervisor"), both("500m", "2048Mi"));
    for (const d of pods)
      assert.deepEqual(d.spec?.template?.spec?.initContainers[0]?.resources, both("250m", "256Mi"));
    // The slot holding cpu-2 stays in the list.
    const dropped = await call("set_cluster_slots", { cluster: "lab", slots: ["thermite-slot-3"] });
    assert.ok(dropped.error);
    assert.match(String(dropped.body.error), /thermite-slot-2 still holds a rig \(cpu-2\)/);
    // An image update over MCP, as on the rig's page: refused while the rig still starts, then
    // nothing to do while the images match.
    assert.match(
      String((await call("update_rig_images", { rig: "cpu-2" })).body.error),
      /cpu-2 is starting: wait until its page shows it running, or failed/,
    );
    store.clusters.setRigStatus("cpu-2", "running"); // its first report (the fake has no rig)
    assert.deepEqual(await call("update_rig_images", { rig: "cpu-2" }), {
      error: false,
      body: { rig: "cpu-2", said: "cpu-2 already runs control's images." },
    });
    const unknown = await call("update_rig_images", { rig: "cpu-9" });
    assert.ok(unknown.error);
    assert.match(String(unknown.body.error), /Control didn't set cpu-9 up on a cluster/);
    // Where the rig is, its status there and each step of its setup, over MCP.
    const setup = await call("rig_setup", { rig: "cpu-2" });
    assert.equal(setup.error, false);
    const body = setup.body as unknown as {
      on: string;
      namespace: string;
      steps: { step: string }[];
    };
    assert.equal(body.on, "cluster");
    assert.equal(body.namespace, "thermite-slot-2");
    assert.ok(body.steps.length > 0);
    assert.ok((await call("rig_setup", { rig: "cpu-9" })).error);
    await client.close();
  });
});

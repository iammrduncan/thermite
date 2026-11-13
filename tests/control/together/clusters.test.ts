import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { cancelDrain, watchDrains } from "../../../src/control/clusters/drain.ts";
import type { ClusterKubectl } from "../../../src/control/clusters/kubectl.ts";
import { setClusterRigResources } from "../../../src/control/clusters/resize.ts";
import { awaitNewPods, setClusterRigUpAgain } from "../../../src/control/clusters/rigs.ts";
import { watchRunners } from "../../../src/control/clusters/runners.ts";
import type { ControlParts } from "../../../src/control/parts.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import { fakeCluster, KUBECONFIG } from "../../helpers/fake-cluster.ts";
import {
  DROPPED,
  failWrite,
  rowsOf,
  seen,
  WRITE_FAILED,
  watched,
  withWriteFailing,
} from "../../helpers/together.ts";

/**
 * The transactions of the rigs control set up on a cluster (control/clusters/): a drain with the
 * size it waits for, its command and its steps; a drain called off; a drain asked again; a rig
 * set up again with its new token; pods that did not come up; and a runner given to its rig with
 * the command that gives it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Control over a fake cluster of one slot, with the rig gpu-1 of 3 GPUs set up in it. */
async function slotRig() {
  const f = fakeCluster({
    canCreateNamespaces: false,
    slots: { "thermite-slot-1": true },
    nodeGpus: 8,
  });
  // While `pods.down`, the rig's two deployments show no pod of theirs running.
  const pods = { down: false };
  const k: ClusterKubectl = {
    ...f.k,
    kubectl: async (target, args, stdin, ms) =>
      pods.down && args[0] === "get" && args[1] === "deployment" && args[4] === "-n"
        ? { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" }
        : f.k.kubectl(target, args, stdin, ms),
  };
  const s = await controlOnly({
    tokens: { rigs: {} },
    options: {
      secrets: SecretBox.ephemeral(),
      clusterKubectl: k,
      publicUrl: "https://control.example.com",
      rigImages: {
        harness: "registry.example.com/harness:1",
        harnessCuda: "registry.example.com/harness-cuda:1",
        harnessCuda13: "registry.example.com/harness-cuda13:1",
        supervisor: "registry.example.com/supervisor:1",
      },
    },
  });
  const ui = await signIn(s.control);
  const csrf = ui.csrfOf(await ui.page("/ui/settings"));
  const post = async (path: string, form: Record<string, string>) =>
    decodeURIComponent(String((await ui.post(path, { csrf, ...form })).headers.get("location")));
  await post("/ui/settings/add", {
    type: "k8s",
    name: "k8s-g",
    kubeconfig: KUBECONFIG,
    placement: "slot",
    slots: "thermite-slot-1",
  });
  // The rig as Add a rig leaves it, with no work in the background: its token and its row.
  await s.store.enrollments.enroll("gpu-1", "b".repeat(64), "owner:ui");
  await s.store.clusters.addRig({
    rig: "gpu-1",
    cluster: "k8s-g",
    namespace: "thermite-slot-1",
    placement: "slot",
    spec: {
      gpus: 3,
      judgeGpus: 2,
      gpuMode: "device-plugin",
      storageGi: 50,
      images: {
        harness: "registry.example.com/harness-cuda:1",
        supervisor: "registry.example.com/supervisor:1",
      },
    },
    created_by: "owner:ui",
  });
  /** The rig's report, with this summary: the fake cluster has no rig to send one. */
  const report = async (summary: Record<string, unknown>) =>
    await ingestReport(s.store, {
      rig: "gpu-1",
      ledger_id: "l-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary,
    });
  return { ...s, pods, report };
}

/** The same, with the rig running and at work on one trial. */
async function workingRig() {
  const s = await slotRig();
  await s.store.clusters.setRigStatus("gpu-1", "running");
  await s.report({ work: { trials: 1, judge_jobs: 0 } });
  return s;
}

const statusOf = async (store: ControlStore) => (await store.clusters.rig("gpu-1"))?.status;

/** The drain commands control issued the rig, oldest first: each one's drain and status. */
const drains = async (store: ControlStore) =>
  (await store.commands.latest("gpu-1", "drain_rig", 20))
    .reverse()
    .map((c) => [(c.payload as { drain: boolean }).drain, c.status]);

const steps = async (store: ControlStore, step: string) =>
  (await store.rigHistory.list("gpu-1")).filter((e) => e.step === step).map((e) => e.detail);

/** Drains gpu-1 for a fourth GPU, as Edit rig does while the rig works. */
const resize = (parts: ControlParts) =>
  setClusterRigResources(parts, "gpu-1", { gpus: 4 }, "owner:api", { owner: true });

/**
 * One of control's loops, started by `start` with a period it never comes around in: the
 * function that runs one round of it now, and answers when the round has ended, well or not.
 */
function loopByHand(parts: ControlParts, name: string, start: (everyMs: number) => void) {
  const NEVER = 2 ** 30;
  let round: (() => void) | undefined;
  const timers = mock.method(globalThis, "setInterval", (fn: () => void) => {
    round = fn;
    return { unref() {} };
  });
  try {
    start(NEVER);
  } finally {
    timers.mock.restore();
  }
  assert.ok(round, "the loop was started");
  const run = round;
  return () =>
    new Promise<void>((ended) => {
      const loops = parts.loops as unknown as { tick?: (n: string) => void };
      // A round that ends, well or not, ticks its loop.
      loops.tick = (n: string) => {
        delete loops.tick;
        parts.loops.tick(n);
        if (n === name) ended();
      };
      run();
    });
}

describe("a cluster rig's drain", () => {
  test("setClusterRigResources: the size it waits for, the drain's command, its status, its step and its audit entry", async () => {
    const { store, parts } = await workingRig();
    // The last write of the drain, its audit entry, fails.
    const dropped = await withWriteFailing(
      store,
      store.auditLog,
      "add",
      () => resize(parts),
      (_by, action) => action === "cluster_rig_drain",
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await statusOf(store), "running", "not draining");
    assert.equal((await store.clusters.rig("gpu-1"))?.pending ?? null, null, "no size waits");
    assert.deepEqual(await drains(store), [], "no drain was asked of the rig");
    assert.deepEqual(await steps(store, "drain"), []);

    const kept = await watched(store, () => resize(parts));
    assert.match(String((kept.out as { ok?: string })?.ok), /gpu-1 drains first/);
    assert.equal(kept.txs.length, 1);
    assert.deepEqual(seen(kept), [
      {
        failed: false,
        changed: ["audit", "cluster_rig", "command", "rig_setup_event", "sqlite_sequence"],
      },
    ]);
    assert.equal(await statusOf(store), "draining");
    assert.equal((await store.clusters.rig("gpu-1"))?.pending?.gpus, 4);
    assert.deepEqual(await drains(store), [[true, "pending"]]);
    assert.deepEqual(await steps(store, "drain"), ["waiting for 1 trial to finish"]);
    assert.equal((await store.auditLog.list(5, { action: "cluster_rig_drain" })).length, 1);
  });

  test("cancelDrain: the command that ends the drain, the rig's status and its step", async () => {
    const { store, parts } = await workingRig();
    await resize(parts);
    assert.equal(await statusOf(store), "draining");
    const cancel = () => cancelDrain(parts, "gpu-1", "owner:ui");
    const dropped = await withWriteFailing(store, store.rigHistory, "add", cancel);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await statusOf(store), "draining", "still draining");
    assert.deepEqual(await drains(store), [[true, "pending"]], "the rig is not told to go on");
    assert.equal((await steps(store, "drain")).length, 1);

    const kept = await watched(store, cancel);
    assert.match(String((kept.out as { ok?: string })?.ok), /gpu-1 goes back to work/);
    assert.deepEqual(seen(kept), [
      {
        failed: false,
        changed: ["audit", "cluster_rig", "command", "rig_setup_event", "sqlite_sequence"],
      },
    ]);
    assert.equal(await statusOf(store), "running");
    assert.deepEqual(await drains(store), [
      [true, "pending"],
      [false, "pending"],
    ]);
    assert.match(String((await steps(store, "drain")).at(-1)), /^called off: /);
  });

  test("watchDrains, a drain asked again: the new command and its step", async () => {
    const { store, parts, report } = await workingRig();
    await resize(parts);
    const round = loopByHand(parts, "drains", (everyMs) => watchDrains(parts, everyMs));
    // The rig took the drain; then its harness started again, and reports no drain.
    const asked = (await store.commands.latest("gpu-1", "drain_rig", 1))[0];
    assert.ok(asked);
    await store.commands.confirmApplied(
      "gpu-1",
      asked.id,
      "delivered",
      JSON.stringify({ source: "harness", accepted: true }),
      new Date().toISOString(),
    );
    const reportsNoDrain = async () => {
      await sleep(3);
      await report({ work: { trials: 0, judge_jobs: 0 } });
    };
    /** Two reports with no drain, a round after each: the second round asks again. */
    const twoRounds = async () => {
      await reportsNoDrain();
      await round();
      await reportsNoDrain();
      return watched(store, round);
    };
    const putBack = failWrite(store.rigHistory, "add");
    const dropped = await twoRounds();
    putBack();
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await drains(store), [[true, "delivered"]], "no drain with no step");
    assert.equal((await steps(store, "drain")).length, 1);

    const kept = await twoRounds();
    assert.deepEqual(seen(kept), [
      { failed: false, changed: ["audit", "command", "rig_setup_event", "sqlite_sequence"] },
    ]);
    assert.deepEqual(await drains(store), [
      [true, "delivered"],
      [true, "pending"],
    ]);
    assert.equal(
      (await steps(store, "drain")).at(-1),
      "its harness started again and was not draining: asked again",
    );
  });
});

describe("a cluster rig's setup", () => {
  test("setClusterRigUpAgain: its node, its new token, its status, its step and its audit entry", async () => {
    const { store, parts } = await slotRig();
    // Its setup failed before it ever reported.
    await store.clusters.setRigStatus("gpu-1", "failed");
    const token = () => rowsOf(store, "rig_token").find((r) => r.rig === "gpu-1")?.token_sha256;
    const before = token();
    assert.ok(before, "the rig has a token");
    const again = () => setClusterRigUpAgain(parts, "gpu-1", undefined, "owner:ui");
    const dropped = await withWriteFailing(store, store.auditLog, "add", again);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await statusOf(store), "failed", "not being set up");
    assert.equal(token(), before, "its token is the one it had");
    assert.deepEqual(await steps(store, "set_up_again"), []);

    const kept = await watched(store, again);
    assert.match(String((kept.out as { ok?: string })?.ok), /^Control sets gpu-1 up again/);
    assert.equal(kept.txs.length, 1);
    assert.equal(kept.txs[0]?.failed, false);
    for (const table of ["audit", "cluster_rig", "rig_setup_event", "rig_token"])
      assert.ok(kept.txs[0]?.changed.includes(table), `${table}: ${kept.txs[0]?.changed}`);
    assert.notEqual(token(), before, "a new token");
    assert.deepEqual(await steps(store, "set_up_again"), ["on any node with room"]);
    assert.equal((await store.auditLog.list(5, { action: "cluster_rig_set_up_again" })).length, 1);
  });

  test("awaitNewPods: pods not running in time, the failed step and the rig's status", async (t) => {
    const { store, parts, pods } = await slotRig();
    pods.down = true;
    await store.clusters.setRigStatus("gpu-1", "updating");
    const r = await store.clusters.rig("gpu-1");
    const k = r ? await store.clusters.get(r.cluster) : undefined;
    assert.ok(r && k);
    // The wait's 15 minutes pass at its first look: the clock jumps after the deadline is set.
    const wait = async () => {
      const real = Date.now();
      let calls = 0;
      const clock = t.mock.method(Date, "now", () => real + (calls++ ? 16 * 60_000 : 0));
      try {
        return await awaitNewPods(parts, r, k);
      } finally {
        clock.mock.restore();
      }
    };
    const dropped = await withWriteFailing(store, store.clusters, "setRigStatus", wait);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await statusOf(store), "updating");
    assert.deepEqual(await steps(store, "images_running"), [], "no failed step with no status");

    const kept = await watched(store, wait);
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["cluster_rig", "rig_setup_event"] }]);
    assert.equal(await statusOf(store), "failed");
    assert.deepEqual(await steps(store, "images_running"), ["not running after 15 minutes"]);
  });
});

describe("a runner given to its rig", () => {
  test("giveRunner (watchRunners): the give, the rig's new settings on their way, and its step", async () => {
    const { store, parts, report } = await slotRig();
    await store.clusters.setRigStatus("gpu-1", "running");
    await report({ settings: { lanes: 2, promotion: "auto", runners: [] } });
    // A runner process control set up for the rig, running, not given to it yet.
    await store.rigRunners.add({
      rig: "gpu-1",
      runner: "runner-1",
      cluster: "k8s-g",
      namespace: "thermite-slot-1",
      placement: "slot",
      spec: {
        gpus: 0,
        gpuMode: "device-plugin",
        storageGi: 10,
        images: {
          harness: "registry.example.com/harness:1",
          supervisor: "registry.example.com/supervisor:1",
        },
        pools: ["judge"],
      },
      created_by: "owner:ui",
      tokenSha256: "a".repeat(64),
    });
    await store.rigRunners.setStatus("gpu-1", "runner-1", "running");
    const round = loopByHand(parts, "runners", (everyMs) => watchRunners(parts, everyMs));
    const sent = async () =>
      (await store.commands.pending("gpu-1"))
        .filter((c) => c.envelope.kind === "rig_settings")
        .map((c) => c.envelope.payload);
    const given = async () => (await store.rigRunners.get("gpu-1", "runner-1"))?.spec.given;

    // The give's step in the rig's history, its last write, fails.
    const dropped = await withWriteFailing(
      store,
      store.rigHistory,
      "add",
      round,
      (_rig, step) => step === "runner_given",
    );
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal(await given(), undefined, "no give is noted");
    assert.deepEqual(await sent(), [], "no settings are on their way to the rig");
    assert.deepEqual(await steps(store, "runner_given"), []);

    const kept = await watched(store, round);
    assert.equal(kept.txs.length, 1);
    assert.equal(kept.txs[0]?.failed, false);
    for (const table of ["command", "rig_runner", "rig_setup_event"])
      assert.ok(kept.txs[0]?.changed.includes(table), `${table}: ${kept.txs[0]?.changed}`);
    assert.deepEqual(await sent(), [{ runners: [{ name: "runner-1", pools: ["judge"] }] }]);
    const g = await given();
    assert.equal(g?.tries, 1);
    assert.equal(g?.command, (await store.commands.latest("gpu-1", "rig_settings", 1))[0]?.id);
    assert.equal((await steps(store, "runner_given")).length, 1);
  });
});

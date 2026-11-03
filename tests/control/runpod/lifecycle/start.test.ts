import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunpodRigView } from "../../../../src/control/runpod/rig-view.ts";
import { NO_FREE_GPU } from "../../../helpers/fake-runpod.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  pendingOf,
} from "../../../helpers/rig-results.ts";
import { HOUR, json, setup, working } from "./setup.ts";

/**
 * Starting and restarting a rig's pod on RunPod: no GPU free, the runs the stop paused resumed,
 * fewer GPUs than at the launch, the spend limit, and a restart with no export.
 */

describe("RunPod rigs: start and restart", () => {
  test("RunPod has no GPU free: the start says so, and the pod stays stopped", async () => {
    const s = setup({ noGpuOnStart: true });
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    await s.rigs.stop(v.rig, "owner:api");
    const r = await s.call(`/v1/rigs/${v.rig}/runpod/start`, {});
    assert.equal(r.status, 409);
    const { error } = await json<{ error: string }>(r);
    assert.match(error, /RunPod has no free GPU for pod pod1 now, so the pod stays stopped/);
    assert.ok(error.includes(NO_FREE_GPU), "RunPod's own words");
    assert.match(error, /Try again later, or terminate it and launch a new rig/);
    assert.deepEqual([s.view(v.rig).status, s.view(v.rig).op], ["EXITED", null]);
    assert.deepEqual(s.steps(v.rig).at(-1), ["runpod_start_refused", false]);
    // A GPU is free again: the start goes through.
    s.cloud.setNoGpuOnStart(false);
    const started = await json<RunpodRigView>(await s.call(`/v1/rigs/${v.rig}/runpod/start`, {}));
    assert.deepEqual([started.status, started.op, started.stopped_by], ["RUNNING", null, null]);
    assert.deepEqual(s.steps(v.rig).slice(-2), [
      ["runpod_starting", true],
      ["runpod_running", true],
    ]);
  });

  test("a start resumes the runs the stop paused, once the pod runs again", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    harnessApplies(s.store, rig, exportName(1));
    exportOnControl(s.store, rig, exportName(1));
    await s.advance();
    assert.equal(s.view(rig).status, "EXITED");
    await assert.rejects(s.rigs.restart(rig, "owner:api"), /stopped: start it instead/);
    const v = await s.rigs.start(rig, "owner:api");
    assert.equal(v.status, "RUNNING");
    assert.deepEqual(v.paused_runs, []);
    assert.deepEqual(
      pendingOf(s.store, rig).map((c) => [c.kind, c.payload]),
      [["resume_run", { run: "run-1" }]],
    );
    assert.match(
      String(s.store.rigHistory.list(rig).at(-1)?.detail),
      /with 1 GPU; runs resumed: run-1/,
    );
    await assert.rejects(
      s.rigs.start(rig, "owner:api"),
      /pod is not stopped: RunPod says it is RUNNING/,
    );
  });

  test("a pod that runs with fewer GPUs than it was launched with is said in its history", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", gpu_count: 2 }, "owner:api");
    await s.rigs.stop(v.rig, "owner:api");
    const pod = s.cloud.pods.get("pod1");
    assert.ok(pod);
    pod.count = 1;
    await s.rigs.start(v.rig, "owner:api");
    const last = s.store.rigHistory.list(v.rig).at(-1);
    assert.deepEqual([last?.step, last?.ok], ["runpod_running", false]);
    assert.match(String(last?.detail), /with 1 GPU; not the 2 it was launched with/);
  });

  test("no start while the pod has cost its spend limit", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", spend_limit_usd: 1 }, "owner:api");
    for (let i = 0; i < 4; i++) await s.advance(HOUR);
    assert.equal(s.view(v.rig).stopped_by, "spend_limit");
    await assert.rejects(
      s.rigs.start(v.rig, "owner:api"),
      /has cost \$1\.00, which is at its spend limit \(\$1\.00\): raise or clear the limit first/,
    );
    s.rigs.limits(v.rig, { spend_limit_usd: 2 }, "owner:api");
    assert.equal((await s.rigs.start(v.rig, "owner:api")).status, "RUNNING");
  });

  test("restart: the pod stops and starts again through RunPod, with no export", async () => {
    const s = setup();
    const rig = await working(s);
    // The route every rig has: RunPod's driver serves this rig with no THERMITE_LIFECYCLE.
    const partial = await s.call(`/v1/rigs/${rig}/restart`, { components: ["supervisor"] });
    assert.equal(partial.status, 409);
    assert.match((await json<{ error: string }>(partial)).error, /restart together/);
    const r = await s.call(`/v1/rigs/${rig}/restart`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { restarted: ["pod pod1: it stops, then starts again"] });
    assert.deepEqual(pendingOf(s.store, rig), [], "no pause and no export");
    assert.equal(s.view(rig).op_words, "restarting: waiting for the pod to stop");
    await s.advance();
    assert.deepEqual(s.cloud.actions(), [{ action: "stop" }, { action: "start" }]);
    const v = s.view(rig);
    assert.deepEqual([v.status, v.op, v.stopped_by], ["RUNNING", null, null]);
    assert.deepEqual(s.steps(rig).slice(1), [
      ["runpod_leaf_address", true],
      ["runpod_restarting", true],
      ["runpod_starting", true],
      ["runpod_running", true],
    ]);
    // A rig not on RunPod still needs THERMITE_LIFECYCLE's driver.
    const other = await s.call("/v1/rigs/local-1/restart", {});
    assert.equal(other.status, 409);
  });
});

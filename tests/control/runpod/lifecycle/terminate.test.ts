import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunpodRigView } from "../../../../src/control/runpod/rig-view.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  harnessRefusesExport,
  pendingOf,
  supervisorReports,
} from "../../../helpers/rig-results.ts";
import { json, setup, working } from "./setup.ts";

/**
 * Terminating a rig's pod on RunPod: removed only once every result has left it, refused while a
 * result can't leave, and a stopped pod or one that never reported.
 */

describe("RunPod rigs: terminate", () => {
  test("removes the pod only once every result has left it, then retires the rig", async () => {
    const s = setup();
    const rig = await working(s);
    const bad = await s.call(`/v1/rigs/${rig}/runpod/terminate`, { confirm: "yes" });
    assert.equal(bad.status, 400);
    assert.equal((await json<{ error: string }>(bad)).error, `confirm with "terminate ${rig}"`);
    const r = await s.call(`/v1/rigs/${rig}/runpod/terminate`, { confirm: `terminate ${rig}` });
    assert.equal(r.status, 200);
    assert.equal(
      (await json<RunpodRigView>(r)).op_words,
      "terminating: waiting until no judge job and no command waits on the rig",
    );
    // The pause waits for the rig: the full export comes after it.
    await s.advance();
    assert.deepEqual(
      pendingOf(s.store, rig).map((c) => c.kind),
      ["pause_run"],
    );
    harnessApplies(s.store, rig, exportName(1));
    await s.advance();
    assert.deepEqual(
      pendingOf(s.store, rig).map((c) => [c.kind, c.payload]),
      [["export_now", { full: true }]],
    );
    harnessApplies(s.store, rig, exportName(2));
    // Exports still wait on the rig: the pod stays, however long it takes.
    supervisorReports(s.store, rig, { waiting: 2 });
    exportOnControl(s.store, rig, exportName(2));
    for (let i = 0; i < 10; i++) await s.advance(60_000);
    assert.deepEqual(s.cloud.terminated(), [], "terminate refuses while exports are pending");
    assert.equal(s.view(rig).op_words, "terminating: waiting for every result to leave the pod");
    supervisorReports(s.store, rig, { champions_waiting: 1 });
    await s.advance();
    assert.deepEqual(s.cloud.terminated(), [], "a champion's patch still waits");
    supervisorReports(s.store, rig);
    await s.advance();
    assert.deepEqual(s.cloud.terminated(), ["pod1"]);
    const v = s.view(rig);
    assert.deepEqual([v.active, v.status, v.op], [false, "TERMINATED", null]);
    assert.ok(s.store.retired.get(rig), "control stops connecting to it; its records stay");
    assert.deepEqual(s.steps(rig).slice(-2), [
      ["runpod_terminating", true],
      ["runpod_terminated", true],
    ]);
    assert.ok(s.store.auditLog.list(80).some((a) => a.action === "runpod_rig_terminated"));
    // Gone: nothing more to do.
    await assert.rejects(s.rigs.stop(rig, "owner:api"), /pod is gone/);
  });

  test("refuses when a result can't leave: the pod keeps running, its runs paused", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.terminate(rig, "owner:api", `terminate ${rig}`);
    harnessApplies(s.store, rig, exportName(1));
    await s.advance();
    harnessApplies(s.store, rig, exportName(2));
    // The rig has nowhere to send its exports (an older supervisor).
    supervisorReports(s.store, rig, { to: "none" });
    await s.advance();
    assert.deepEqual(s.cloud.terminated(), []);
    assert.deepEqual(s.cloud.stops(), []);
    const v = s.view(rig);
    assert.deepEqual([v.active, v.status, v.op], [true, "RUNNING", null]);
    assert.deepEqual(v.paused_runs, ["run-1"]);
    assert.match(
      String(v.error),
      /^Not terminated: .*does not send exports to control.* The pod keeps running, with its runs paused/,
    );
    assert.deepEqual(s.steps(rig).at(-1), ["runpod_terminate_refused", false]);

    const t = setup();
    const other = await working(t);
    await t.rigs.terminate(other, "owner:api", `terminate ${other}`);
    harnessApplies(t.store, other, exportName(1));
    await t.advance();
    harnessRefusesExport(t.store, other);
    await t.advance();
    assert.deepEqual(t.cloud.terminated(), []);
    assert.match(String(t.view(other).error), /the export did not complete \(failed\)/);
  });

  test("a stopped pod: removed only when its results left it before it stopped", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    harnessRefusesExport(s.store, rig);
    await s.advance();
    await assert.rejects(
      s.rigs.terminate(rig, "owner:api", `terminate ${rig}`),
      /pod is stopped, and results may wait on its volume .*: start it, so they can leave, then terminate it/,
    );
    assert.deepEqual(s.cloud.terminated(), []);

    const t = setup();
    const done = await working(t);
    await t.rigs.stop(done, "owner:api");
    harnessApplies(t.store, done, exportName(1));
    exportOnControl(t.store, done, exportName(1));
    await t.advance();
    const v = await t.rigs.terminate(done, "owner:api", `terminate ${done}`);
    assert.deepEqual([v.active, v.status], [false, "TERMINATED"]);
    assert.deepEqual(t.cloud.terminated(), ["pod1"]);
  });

  test("a pod whose harness never reported is removed at once", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const gone = await s.rigs.terminate(v.rig, "owner:api", `terminate ${v.rig}`);
    assert.deepEqual([gone.active, gone.status], [false, "TERMINATED"]);
    assert.deepEqual(s.cloud.terminated(), ["pod1"]);
  });
});

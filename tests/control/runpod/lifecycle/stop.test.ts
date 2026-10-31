import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STOP_WAIT_MS } from "../../../../src/control/runpod/lifecycle.ts";
import type { RunpodRigView } from "../../../../src/control/runpod/rig-view.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  harnessRefusesExport,
  pendingOf,
  supervisorReports,
} from "../../../helpers/rig-results.ts";
import { HOUR, json, setup, working } from "./setup.ts";

/**
 * Stopping a rig's pod on RunPod: its runs paused and its results sent out first, a stop all the
 * same when the export fails or takes too long, and one change at a time.
 */

describe("RunPod rigs: stop", () => {
  test("pauses the runs and sends the results out first; the pod stops once they have left", async () => {
    const s = setup();
    const rig = await working(s);
    const r = await s.call(`/v1/rigs/${rig}/runpod/stop`, {});
    assert.equal(r.status, 200);
    const asked = await json<RunpodRigView>(r);
    assert.deepEqual(
      [asked.op?.kind, asked.op?.phase, asked.op?.by],
      ["stop", "exporting", "owner:api"],
    );
    assert.equal(asked.op_words, "stopping: waiting for its export");
    assert.deepEqual(asked.op?.paused, ["run-1"]);
    const sent = pendingOf(s.store, rig);
    assert.deepEqual(
      sent.map((c) => [c.kind, c.payload]),
      [
        ["pause_run", { run: "run-1", reason: "the owner stops the rig's pod" }],
        ["export_now", { full: false }],
      ],
    );
    // Nothing leaves yet: the pod runs on.
    await s.advance();
    assert.deepEqual(s.cloud.stops(), []);
    harnessApplies(s.store, rig, exportName(1));
    supervisorReports(s.store, rig, { waiting: 1 });
    await s.advance();
    assert.equal(s.view(rig).op?.phase, "leaving");
    assert.equal(s.view(rig).op_words, "stopping: waiting for its results to leave the pod");
    // On control, but another export still waits on the rig: not yet.
    exportOnControl(s.store, rig, exportName(1));
    await s.advance();
    assert.deepEqual(s.cloud.stops(), []);
    supervisorReports(s.store, rig);
    const spentBefore = s.view(rig).spend_usd;
    await s.advance();
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    const v = s.view(rig);
    assert.deepEqual([v.status, v.stopped_by, v.op], ["EXITED", "owner", null]);
    assert.deepEqual(v.paused_runs, ["run-1"], "the next start resumes it");
    assert.deepEqual([v.last_export, v.last_export_left], [exportName(1), true]);
    // Stopped: it costs nothing more.
    await s.advance(5 * HOUR);
    assert.ok(Math.abs((s.view(rig).spend_usd ?? 0) - (spentBefore ?? 0)) < 0.01);
    assert.deepEqual(s.steps(rig), [
      ["runpod_launched", true],
      ["runpod_leaf_address", true],
      ["runpod_stopping", true],
      ["runpod_stopped", true],
    ]);
    const audit = s.store.auditLog.list(50);
    assert.equal(audit.find((a) => a.action === "runpod_rig_stop")?.actor, "owner:api");
    const stoppedAudit = audit.find((a) => a.action === "runpod_rig_stopped");
    assert.equal((stoppedAudit?.body as { why?: string } | undefined)?.why, "owner");
  });

  test("stops all the same when the export fails or takes too long: the volume keeps the rest", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    harnessRefusesExport(s.store, rig);
    await s.advance();
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    const failed = s.store.rigHistory.list(rig).at(-1);
    assert.equal(failed?.step, "runpod_stopped");
    assert.match(
      String(failed?.detail),
      /the export did not complete \(failed\): what it had not sent out stays on its volume/,
    );
    assert.equal(s.view(rig).last_export_left, false);

    const t = setup();
    const slow = await working(t);
    await t.rigs.stop(slow, "owner:api");
    await t.advance(STOP_WAIT_MS - 60_000);
    assert.deepEqual(t.cloud.stops(), []);
    await t.advance(2 * 60_000);
    assert.deepEqual(t.cloud.stops(), [{ action: "stop" }]);
    assert.match(
      String(t.store.rigHistory.list(slow).at(-1)?.detail),
      /no export within 15 minutes/,
    );
  });

  test("a rig whose harness never reported holds no result: its pod stops at once", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const stopped = await s.rigs.stop(v.rig, "owner:mcp");
    assert.deepEqual([stopped.status, stopped.op], ["EXITED", null]);
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    assert.deepEqual(pendingOf(s.store, v.rig), []);
    await assert.rejects(s.rigs.stop(v.rig, "owner:api"), /pod is stopped already/);
  });

  test("one change at a time; the owner's own stop waits for a full reset", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    await assert.rejects(
      s.rigs.stop(rig, "owner:api"),
      /a stop of .* is under way: wait until it ends/,
    );
    await assert.rejects(
      s.rigs.terminate(rig, "owner:api", `terminate ${rig}`),
      /a stop of .* is under way/,
    );
    const t = setup();
    const other = await working(t);
    t.store.fullResets.create(other, "owner:api");
    await assert.rejects(
      t.rigs.stop(other, "owner:api"),
      /a full reset of .* is under way \(start\)/,
    );
  });
});

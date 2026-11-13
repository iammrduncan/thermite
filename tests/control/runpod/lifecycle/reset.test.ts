import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advanceResets, confirmReset } from "../../../../src/control/lifecycle.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  pendingOf,
  supervisorReports,
} from "../../../helpers/rig-results.ts";
import { json, setup, working } from "./setup.ts";

/**
 * A full reset of a rig on RunPod: every result leaves the pod first, the wipe waits for the
 * owner, the pod stays, and a stopped pod is refused.
 */

describe("RunPod rigs: the full reset", () => {
  test("every result leaves the pod first, the wipe waits for the owner, and the pod stays", async () => {
    const s = await setup();
    const rig = await working(s);
    const step = () =>
      advanceResets({
        store: s.store,
        privateKeyPem: s.control.privateKeyPem,
        driver: undefined,
        staleAfterMs: 180_000,
      });
    const r = await s.call(`/v1/rigs/${rig}/reset`, { confirm: `reset ${rig}` });
    assert.equal(r.status, 201);
    const { reset } = await json<{ reset: number }>(r);
    assert.equal(String((await s.store.fullResets.open(rig))?.state), "quiescing");
    await harnessApplies(s.store, rig, exportName(1));
    await step();
    assert.equal(String((await s.store.fullResets.open(rig))?.state), "exporting");
    await harnessApplies(s.store, rig, exportName(2));
    await step();
    // Control holds the export, but another export still waits on the pod: not yet.
    await exportOnControl(s.store, rig, exportName(2));
    await supervisorReports(s.store, rig, { waiting: 1 });
    await step();
    assert.equal(String((await s.store.fullResets.open(rig))?.state), "verifying");
    await supervisorReports(s.store, rig);
    await step();
    assert.equal(String((await s.store.fullResets.open(rig))?.state), "awaiting_owner");
    // While it runs, the owner's stop waits.
    await assert.rejects(s.rigs.stop(rig, "owner:api"), /a full reset of .* is under way/);
    await confirmReset(s.store, reset, "owner:api");
    await step();
    const wipe = await pendingOf(s.store, rig);
    assert.deepEqual(
      wipe.map((c) => c.kind),
      ["wipe_state"],
    );
    await harnessApplies(s.store, rig, exportName(3));
    await step();
    const done = (await s.store.fullResets.list(1))[0];
    assert.equal(done?.state, "done");
    assert.match(String(done?.detail), /the pod and its GPU stay/);
    assert.deepEqual(s.cloud.actions(), [], "the pod was never stopped");
    assert.deepEqual((await s.steps(rig)).slice(-2), [
      ["reset_requested", true],
      ["reset_done", true],
    ]);
  });

  test("refused while the pod is stopped: its results could not leave", async () => {
    const s = await setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    await s.rigs.stop(v.rig, "owner:api");
    const r = await s.call(`/v1/rigs/${v.rig}/reset`, { confirm: `reset ${v.rig}` });
    assert.equal(r.status, 409);
    assert.match((await json<{ error: string }>(r)).error, /pod is stopped: start it first/);
    // One made elsewhere (the dashboard) fails at its first step, in the same words.
    await s.store.fullResets.create(v.rig, "owner:ui");
    await advanceResets({
      store: s.store,
      privateKeyPem: s.control.privateKeyPem,
      driver: undefined,
      staleAfterMs: 180_000,
    });
    assert.equal((await s.store.fullResets.list(1))[0]?.state, "failed");
    assert.deepEqual((await s.steps(v.rig)).at(-1), ["reset_failed", false]);
  });
});

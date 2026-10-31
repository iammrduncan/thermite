import assert from "node:assert/strict";
import { test } from "node:test";
import { rigSetupView, SETUP_STEPS } from "../../../src/control/rigs/setup-view.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";

test("rig_setup gives a rig's newest steps, oldest first, and how many there are (goal 138)", () => {
  const events = Array.from({ length: 90 }, (_, i) => ({
    at: `2026-10-25T00:00:${String(i).padStart(2, "0")}Z`,
    step: "images",
    ok: true,
    detail: `step ${i}`,
  }));
  const store = {
    clusters: { rig: () => undefined },
    machines: { rig: () => ({ machine: "m-1", status: "running" }) },
    rigHistory: { list: () => events },
  } as unknown as ControlStore;
  const v = rigSetupView(store, undefined, "rig-1", SETUP_STEPS, true);
  assert.equal(v.steps_total, 90);
  assert.deepEqual(
    v.steps.map((s) => s.detail),
    Array.from({ length: 20 }, (_, i) => `step ${70 + i}`),
  );
  assert.equal(rigSetupView(store, undefined, "rig-1", 500, true).steps.length, 90);
  // A failed step's detail is the owner's and the operator's alone.
  assert.equal(rigSetupView(store, undefined, "rig-1", 1, false).steps[0]?.detail, null);
  const none = { ...store, machines: { rig: () => undefined } } as unknown as ControlStore;
  assert.throws(
    () => rigSetupView(none, undefined, "rig-2", 20, true),
    /control did not set rig-2 up/,
  );
});

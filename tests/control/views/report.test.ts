import assert from "node:assert/strict";
import { test } from "node:test";
import { programModeOf, readSettings } from "../../../src/control/views/report.ts";
import { PROGRAM_MODE_DEFAULT } from "../../../src/core/rig-settings.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";

test("a rig's program mode as its report gives it: the terminal by default, headless from a harness older than the mode (goal 169)", () => {
  // A harness writes every setting in its report, its defaults among them.
  assert.equal(PROGRAM_MODE_DEFAULT, "terminal");
  assert.equal(readSettings({ lanes: 1, program_mode: "terminal" })?.program_mode, "terminal");
  assert.equal(readSettings({ lanes: 1, program_mode: "headless" })?.program_mode, "headless");
  // A harness older than the terminal mode reports none, and runs its programs headless.
  assert.equal(readSettings({ lanes: 1 })?.program_mode, "headless");
  assert.equal(readSettings({ lanes: 1, program_mode: "tui" })?.program_mode, "headless");
  assert.equal(readSettings(undefined), null);
});

test("a rig's program mode as control knows it: the default before its first report, then its report's, headless from a harness older than settings (goal 169)", async () => {
  const store = controlStore();
  const report = (summary: Record<string, unknown>) =>
    ingestReport(store, {
      rig: "rig-1",
      ledger_id: "l-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary,
    });
  // A rig being added has not reported: it will run the default way.
  assert.equal(programModeOf(store, "rig-1"), PROGRAM_MODE_DEFAULT);
  await report({ settings: { program_mode: "headless" } });
  assert.equal(programModeOf(store, "rig-1"), "headless");
  await report({ settings: { program_mode: "terminal" } });
  assert.equal(programModeOf(store, "rig-1"), "terminal");
  // A harness that reports no settings is older than the terminal mode.
  await report({});
  assert.equal(programModeOf(store, "rig-1"), "headless");
});

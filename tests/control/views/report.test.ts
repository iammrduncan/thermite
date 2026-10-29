import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "../../../src/control/views/report.ts";
import { PROGRAM_MODE_DEFAULT } from "../../../src/core/rig-settings.ts";

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

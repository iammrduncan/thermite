import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { statusEvents } from "../../src/harness/run-status.ts";
import { appendOther } from "../helpers/kinds.ts";

test("a run's status changes are read under the names from before 2026-10-15 too (goal 163)", () => {
  const ledger = Ledger.open(":memory:");
  appendOther(ledger, "harness", "instance_status", "r-1", { status: "paused" });
  ledger.appendEvent("harness", "run_status", "r-2", { status: "running", reason: null });
  const resumed = ledger.appendEvent("harness", "run_status", "r-1", {
    status: "running",
    reason: null,
  });
  assert.deepEqual(
    statusEvents(ledger, "r-1").map((e) => e.status),
    ["paused", "running"],
  );
  assert.deepEqual(
    statusEvents(ledger, "r-1", resumed - 1).map((e) => [e.id, e.status]),
    [[resumed, "running"]],
  );
  ledger.close();
});

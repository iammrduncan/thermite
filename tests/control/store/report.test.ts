import assert from "node:assert/strict";
import { test } from "node:test";
import { controlStore, heldEvents, ingestReport } from "../../helpers/control-store.ts";

test("a reported event's run is kept and read back; an event that names none has none (goal 170)", async () => {
  const store = controlStore();
  const at = new Date().toISOString();
  const event = (id: number, kind: string, subject: string | null, run?: string | null) => ({
    id,
    at,
    actor: "harness",
    kind,
    subject,
    body: {},
    ...(run === undefined ? {} : { run }),
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: 3,
    events: [
      event(1, "verdict", "a-0123456789abcdef", "r-1"),
      event(2, "command", "c-1", null),
      event(3, "run_status", "r-1"),
    ],
    summary: {},
  });
  const runs = (await heldEvents(store, "rig-a")).map((e) => [e.kind, e.run]);
  assert.deepEqual(runs, [
    ["verdict", "r-1"],
    ["command", null],
    ["run_status", null],
  ]);
});

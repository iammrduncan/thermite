import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { appendOther } from "../../helpers/kinds.ts";

test("the ledger's events, read by kind: the newest, a list, a count, the last id; old kinds under new names (goal 125, T6)", () => {
  const ledger = Ledger.open(":memory:");
  const e = ledger.events;
  ledger.appendEvent("judge", "goal_complete", "r-1", { champion_seq: 2 });
  ledger.appendEvent("judge", "goal_complete", "r-1", { champion_seq: 3 });
  ledger.appendEvent("judge", "goal_complete", "r-2", { champion_seq: 3 });
  // An event a ledger recorded before the 2026-10-15 rename, under its old kind and keys.
  appendOther(ledger, "harness", "instance_status", "r-1", { status: "paused", instance: "r-1" });
  assert.equal(e.newest("goal_complete", { subject: "r-1" })?.body.champion_seq, 3);
  assert.equal(e.newest("goal_complete", { subject: "r-1", body: { champion_seq: 2 } })?.id, 1);
  assert.equal(e.newest("goal_complete", { subject: "r-3" }), undefined);
  assert.deepEqual(
    e.list("goal_complete", { body: { champion_seq: 3 } }).map((x) => x.subject),
    ["r-1", "r-2"],
  );
  assert.equal(e.count("goal_complete", { subject: "r-1" }), 2);
  assert.equal(e.count(["goal_complete", "run_status"], { after: 1 }), 3);
  assert.equal(e.lastId("goal_complete"), 3);
  assert.equal(e.lastId("verdict"), 0);
  const status = e.newest("run_status", { subject: "r-1" });
  assert.ok(status);
  assert.equal(status.kind, "run_status");
  assert.equal((status.body as unknown as { run?: string }).run, "r-1");
  assert.equal(e.kindOf(4), "run_status");
  assert.deepEqual(e.countsByKind(2), { goal_complete: 1, run_status: 1 });
  assert.throws(() => e.newest("goal_complete", { body: { "x') or ('1": 1 } }), /not a body key/);
});

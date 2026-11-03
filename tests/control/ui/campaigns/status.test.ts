import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignKind } from "../../../../src/control/ui/campaigns/list.ts";
import type { CampaignView, RunView } from "../../../../src/control/views/index.ts";
import { rig, statusRun } from "./fixtures.ts";

/** The words for a run's and a campaign's state, on the Campaigns list and in Earlier runs. */

test("a paused run reads as paused, whatever decision waits in it", async () => {
  const { runState } = await import("../../../../src/control/ui/components/index.ts");
  const r = (status: string, more: Partial<RunView> = {}) =>
    ({
      status,
      audits: [],
      pending_promotions: [],
      conclusions: [],
      reviews: [],
      ...more,
    }) as unknown as RunView;
  const approval = { pending_promotions: [{}] } as unknown as Partial<RunView>;
  const audit = { audits: [{ decision: null }] } as unknown as Partial<RunView>;
  assert.equal(runState(r("paused", approval)).text, "Paused");
  assert.equal(runState(r("paused", audit)).text, "Paused");
  assert.equal(runState(r("running", approval)).text, "Approval");
  // An open audit is the auditor's to decide; a blocked result waits on the owner.
  assert.deepEqual(
    [runState(r("running", audit)).text, runState(r("running", audit)).cls],
    ["Auditing", "info"],
  );
  const blocked = { audits: [{ decision: "block" }] } as unknown as Partial<RunView>;
  assert.deepEqual(
    [runState(r("running", blocked)).text, runState(r("running", blocked)).cls],
    ["Audit", "warn"],
  );
  assert.equal(runState(r("closed", approval)).text, "Finished");
});

test("a closed goal run that met its goals reads Completed; any other closed run, Finished (goal 099)", async () => {
  const { runState } = await import("../../../../src/control/ui/components/index.ts");
  const met = { goals_complete: true } as Partial<RunView>;
  const st = (r: RunView) => [runState(r).text, runState(r).cls];
  assert.deepEqual(st(statusRun("q-1", "closed", "2026-10-20T00:00:00Z", met)), [
    "Completed",
    "ok",
  ]);
  // Closed with its goals unmet (the owner closed it, or "not possible"): Finished.
  assert.deepEqual(st(statusRun("q-1", "closed", "2026-10-20T00:00:00Z")), ["Finished", "muted"]);
  // Only a goal run completes: a hill climb never meets goals.
  assert.deepEqual(
    st(statusRun("h-1", "closed", "2026-10-20T00:00:00Z", { ...met, mode: "hill_climb" })),
    ["Finished", "muted"],
  );
  // A paused or running run keeps its word, whatever its last report said.
  assert.equal(runState(statusRun("q-1", "paused", "2026-10-20T00:00:00Z", met)).text, "Paused");
  assert.equal(runState(statusRun("q-1", "running", "2026-10-20T00:00:00Z", met)).text, "Running");
});

test("a campaign reads as its newest run when none is at work; a run at work still wins (goal 099)", async () => {
  const { campaignState } = await import("../../../../src/control/ui/components/index.ts");
  const met = { goals_complete: true } as Partial<RunView>;
  const k = (...runs: RunView[]): CampaignView => ({
    name: "quality",
    mode: "goal",
    runs: runs.map((run) => ({ rig, run })),
  });
  const old = statusRun("q-1", "paused", "2026-10-20T00:00:00Z");
  const older = statusRun("q-0", "paused", "2026-10-19T00:00:00Z");
  const done = statusRun("q-2", "closed", "2026-10-21T00:00:00Z", met);
  // Two older paused runs and a newer one that completed: Completed, in any order.
  const both = k(older, done, old);
  assert.deepEqual([campaignState(both).text, campaignState(both).cls], ["Completed", "ok"]);
  assert.equal(campaignKind(both), "finished");
  // A newer paused run after a completed one: Paused, and the list counts it as paused.
  const again = k(done, statusRun("q-3", "paused", "2026-10-22T00:00:00Z"));
  assert.equal(campaignState(again).text, "Paused");
  assert.equal(campaignKind(again), "paused");
  // A newer run closed without meeting its goals: Finished.
  assert.equal(
    campaignState(k(old, statusRun("q-4", "closed", "2026-10-22T00:00:00Z"))).text,
    "Finished",
  );
  // Any run at work wins over the newest run's end, and the most urgent of those first.
  const working = statusRun("q-5", "running", "2026-10-18T00:00:00Z");
  assert.equal(campaignState(k(done, working)).text, "Running");
  assert.equal(campaignKind(k(done, working)), "active");
  const asks = statusRun("q-6", "running", "2026-10-17T00:00:00Z", {
    pending_promotions: ["a-1"],
  });
  assert.equal(campaignState(k(working, done, asks)).text, "Approval");
  // Every run paused: Paused.
  assert.equal(campaignState(k(older, old)).text, "Paused");
  assert.equal(campaignState(k()).text, "Idle");
});

test("Earlier runs reads Completed for a run that met its goals, and marks a judge-only run (goal 099)", async () => {
  const { earlierRuns } = await import("../../../../src/control/ui/campaigns/list.ts");
  const html = earlierRuns(
    [
      statusRun("q-2", "closed", "2026-10-21T00:00:00Z", { goals_complete: true }),
      statusRun("q-1", "closed", "2026-10-20T00:00:00Z", { has_agents: false }),
    ].map((run) => ({ rig, run, result: "", action: "" })),
    Date.parse("2026-10-22T00:00:00Z"),
  );
  assert.match(
    html,
    /<td><span class="kst ok">Completed<\/span><\/td><td><a [^>]*><b>q-2<\/b><\/a><\/td>/,
  );
  assert.match(
    html,
    /<td><span class="kst done">Finished<\/span><\/td><td><a [^>]*><b>q-1<\/b><\/a> <span class="chip" title="[^"]*">judge only<\/span><\/td>/,
  );
});

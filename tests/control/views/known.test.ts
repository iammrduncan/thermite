import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { campaignKnown, campaignModes, rigViews } from "../../../src/control/views/index.ts";
import { closeBus, controlStore } from "../../helpers/control-store.ts";
import { report } from "../../helpers/view-events.ts";

/**
 * The checks of whether a rig or a campaign exists, which build no view (goal 125, T12): a rig a
 * report named and not retired; a campaign as campaignModes lists it.
 */
describe("what control knows, without a view", () => {
  test("a rig is listed once it reported, and not once it is retired", async () => {
    const store = controlStore();
    await report(store, "rig-1", "ledger-1", [
      { kind: "run_created", subject: "r-1", body: { campaign: "speed", mode: "hill_climb" } },
    ]);
    assert.equal(store.reportedRigs.listed("rig-1"), true);
    assert.equal(store.reportedRigs.listed("rig-2"), false);
    assert.deepEqual(
      rigViews(store).map((v) => v.id),
      ["rig-1"],
    );
    store.retired.add("rig-1", "owner:ui");
    assert.equal(store.reportedRigs.listed("rig-1"), false);
    closeBus(store);
  });

  test("a campaign is known as campaignModes lists it: a rig's run under it, or a run that is its own", async () => {
    const store = controlStore();
    await report(store, "rig-1", "ledger-1", [
      { kind: "run_created", subject: "r-1", body: { campaign: "speed", mode: "hill_climb" } },
      { kind: "run_created", subject: "loose-1", body: { mode: "goal" } },
    ]);
    const listed = campaignModes(store, rigViews(store));
    for (const name of ["speed", "loose-1"]) {
      assert.ok(listed.has(name), name);
      assert.equal(campaignKnown(store, name), true, name);
    }
    for (const name of ["other", "r-1"]) {
      assert.ok(!listed.has(name), name);
      assert.equal(campaignKnown(store, name), false, name);
    }
    closeBus(store);
  });
});

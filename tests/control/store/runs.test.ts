import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runNameUsed } from "../../../src/control/run-names.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";
import { keepOldRows, withEventsTable } from "../../helpers/old-store.ts";

/**
 * Control's run registry (goal 170): every run control signed an assignment for and every run a
 * rig created. A name is used while its assignment goes through, or once a rig created it.
 */
const assignment = (id: string, rig: string, run: string, campaign = "sort-speed") =>
  ({
    envelope: {
      v: 1,
      id,
      rig,
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run, contract: { campaign } },
    },
    signature: "not checked by the store",
  }) as unknown as SignedCommand;

const created = async (store: ControlStore, rig: string, run: string, campaign = "sort-speed") =>
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: 1,
    events: [
      {
        id: 1,
        at: new Date().toISOString(),
        actor: "harness",
        kind: "run_created",
        subject: run,
        body: { campaign },
      },
    ],
    summary: {},
  });

describe("control's run registry", () => {
  test("an assignment uses its name until it is refused; a run a rig created keeps it", async () => {
    const store = controlStore();
    store.commands.enqueue(assignment("c-1", "rig-a", "sort-speed-1"));
    store.commands.enqueue(assignment("c-2", "rig-a", "sort-speed-2"));
    assert.equal(runNameUsed(store, "sort-speed-1"), "rig-a");
    assert.deepEqual([...store.runRegistry.usedNames("sort-speed-")].sort(), [
      "sort-speed-1",
      "sort-speed-2",
    ]);
    // A refused assignment frees its name; a delivered one keeps it.
    store.commands.ack("rig-a", "c-2", "failed", { error: "x" });
    store.commands.ack("rig-a", "c-1", "delivered", {});
    assert.equal(runNameUsed(store, "sort-speed-2"), undefined);
    assert.deepEqual(
      store.runRegistry.assignedCampaigns("rig-a"),
      new Map([["sort-speed-1", "sort-speed"]]),
    );
    // A run a rig reports creating uses its name, though control never assigned it there.
    await created(store, "rig-b", "other-1", "other");
    assert.equal(runNameUsed(store, "other-1"), "rig-b");
    // What a rig claims is not what control assigned it.
    assert.deepEqual(store.runRegistry.assignedCampaigns("rig-b"), new Map());
  });

  test("a run's campaign on a rig is known once the rig reports creating it", async () => {
    const store = controlStore();
    store.commands.enqueue(assignment("c-1", "rig-a", "sort-speed-1"));
    // Assigned, not created yet: the rig has no such run.
    assert.equal(store.runRegistry.createdOn("sort-speed-1", "rig-a"), undefined);
    assert.equal(store.runRegistry.campaignOf("sort-speed-1", "rig-a"), undefined);
    await created(store, "rig-a", "sort-speed-1");
    assert.equal(store.runRegistry.campaignOf("sort-speed-1", "rig-a"), "sort-speed");
    assert.equal(store.runRegistry.createdOn("sort-speed-1", "rig-a")?.ledger_id, "ledger-rig-a");
    // Another rig has no run of that name.
    assert.equal(store.runRegistry.createdOn("sort-speed-1", "rig-b"), undefined);
    assert.equal(store.runRegistry.campaignOf("sort-speed-1", "rig-b"), undefined);
    // A run created without a campaign is its own: it has none to give.
    await ingestReport(store, {
      rig: "rig-b",
      ledger_id: "ledger-rig-b",
      cursor: 0,
      next: 1,
      events: [
        {
          id: 1,
          at: new Date().toISOString(),
          actor: "harness",
          kind: "run_created",
          subject: "solo-1",
          body: {},
        },
      ],
      summary: {},
    });
    assert.equal(store.runRegistry.createdOn("solo-1", "rig-b")?.campaign, null);
    assert.equal(store.runRegistry.campaignOf("solo-1", "rig-b"), undefined);
  });

  test("a rig's word is no run: a name control assigned another rig is refused, and a campaign control knows is never taken from a rig", async () => {
    const store = controlStore();
    store.campaigns.put({
      campaign: "saved-only",
      version: 1,
      contract: { campaign: "saved-only" },
      sha: "0".repeat(64),
      by: "owner:ui",
    });
    store.commands.enqueue(assignment("c-1", "rig-a", "sort-speed-1"));
    await created(store, "rig-a", "sort-speed-1");
    // rig-b claims rig-a's run: not registered, and the audit log says so.
    await created(store, "rig-b", "sort-speed-1", "sort-speed");
    assert.equal(store.runRegistry.createdOn("sort-speed-1", "rig-b"), undefined);
    assert.equal(store.runRegistry.created("sort-speed-1")?.rig, "rig-a");
    assert.deepEqual(store.runRegistry.rigsOf("sort-speed-1"), ["rig-a"]);
    assert.deepEqual(
      store.auditLog.list(10, { action: "run_refused" }).map((e) => e.body),
      [
        {
          rig: "rig-b",
          run: "sort-speed-1",
          why: "control assigned this run's name to another rig",
        },
      ],
    );
    // A run control did not assign, naming a campaign control assigned or saved: its own campaign.
    await created(store, "rig-b", "planted-1", "sort-speed");
    await created(store, "rig-b", "planted-2", "saved-only");
    assert.equal(store.runRegistry.createdOn("planted-1", "rig-b")?.campaign, null);
    assert.equal(store.runRegistry.createdOn("planted-2", "rig-b")?.campaign, null);
    assert.deepEqual(
      store.runRegistry.ofCampaign("sort-speed").map((r) => [r.run, r.rig]),
      [["sort-speed-1", "rig-a"]],
    );
    assert.deepEqual(store.runRegistry.ofCampaign("saved-only"), []);
    // A campaign control knows nothing of (a rig check, a run started on the rig) is taken.
    await created(store, "rig-b", "rig-check-smoke-1", "rig-check-smoke-cpu-0123abcd");
    assert.equal(
      store.runRegistry.createdOn("rig-check-smoke-1", "rig-b")?.campaign,
      "rig-check-smoke-cpu-0123abcd",
    );
    // An assigned run's campaign is its assignment's, whatever its event names.
    store.commands.enqueue(assignment("c-2", "rig-b", "sort-speed-2"));
    await created(store, "rig-b", "sort-speed-2", "something-else");
    assert.equal(store.runRegistry.campaignOf("sort-speed-2", "rig-b"), "sort-speed");
  });

  test("a store from before has its registry made from its commands and its rigs' events", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");
    const old = new ControlStore(path);
    old.commands.enqueue(assignment("c-1", "rig-a", "sort-speed-1"));
    old.commands.enqueue(assignment("c-2", "rig-a", "sort-speed-2"));
    old.commands.ack("rig-a", "c-2", "failed", { error: "x" });
    // As a store at version 5 left it: its events in its events table, no registry yet.
    withEventsTable(old.db, 5);
    keepOldRows(old.db, [
      {
        rig: "rig-b",
        ledger: "ledger-rig-b",
        id: 1,
        kind: "run_created",
        subject: "other-1",
        body: { campaign: "other" },
      },
    ]);
    old.db.exec("drop table run_registry");
    old.db.close();
    const store = new ControlStore(path);
    assert.deepEqual([...store.runRegistry.usedNames()].sort(), ["other-1", "sort-speed-1"]);
    assert.deepEqual(
      store.runRegistry.assignedCampaigns("rig-a"),
      new Map([["sort-speed-1", "sort-speed"]]),
    );
    store.db.close();
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setCampaignAdditions } from "../../../src/control/campaigns/additions.ts";
import { setCampaignKbWrites } from "../../../src/control/campaigns/kb-writes.ts";
import { decideProposal, proposeSetting } from "../../../src/control/campaigns/proposals.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { type ControlStore, openControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { enrollRigs } from "../../helpers/control-store.ts";
import {
  DROPPED,
  HELD,
  seen,
  WRITE_FAILED,
  watched,
  withAnotherCaller,
  withTurns,
  withWriteFailing,
} from "../../helpers/together.ts";

/**
 * The transactions of a campaign's saved versions and proposals (control/campaigns/): a new
 * version is built from the newest as one piece, and kept with its audit entry; the owner's
 * decision on a proposal is kept with what it changes; and an assignment's contract is looked
 * for and saved as one piece.
 */

const C = "c".repeat(40);
const example = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../examples/contracts/goal-example.json"), "utf8"),
) as Record<string, unknown>;
const contract = (fields: Record<string, unknown>) => {
  const r = parseContract({ ...example, ...fields });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
};

/** A store with version 1 of the campaigns `gemv` and `survey`, each saved on control. */
async function setup() {
  const store = openControlStore(":memory:");
  for (const campaign of ["gemv", "survey"]) {
    const c = contract({ campaign, version: 1 });
    await store.campaigns.put({
      campaign,
      version: 1,
      contract: c.contract,
      sha: c.sha,
      sources: { assignment: { imports: [], seed: { repo: "my-project", commit: C } } },
      by: "owner:ui",
    });
  }
  return store;
}

const versions = async (store: ControlStore, campaign = "gemv") =>
  (await store.campaigns.versions(campaign)).map((v) => v.version);

const newest = async (store: ControlStore) =>
  (await store.campaigns.versions("gemv"))[0]?.contract as Record<string, unknown>;

const audits = async (store: ControlStore, action: string) =>
  (await store.auditLog.list(50, { action })).map((e) => e.body as Record<string, unknown>);

const ADDITIONS = { planner: "Prefer the smallest change that can be measured." };
const WRITES = { worker: ["finding" as const], planner: [] };

describe("a campaign's new version", () => {
  test("saveWithField (setCampaignAdditions): the version and its audit entry", async () => {
    const store = await setup();
    const set = () =>
      setCampaignAdditions(store, { campaign: "gemv", additions: ADDITIONS }, "owner:api");
    const dropped = await withWriteFailing(store, store.auditLog, "add", set);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await versions(store), [1], "no version 2 with no audit entry");
    assert.deepEqual(await audits(store, "campaign_additions_set"), []);

    const kept = await watched(store, set);
    assert.equal(kept.out?.state, "saved");
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "campaign_version"] }]);
    assert.deepEqual(await versions(store), [2, 1]);
    assert.deepEqual((await newest(store)).role_additions, ADDITIONS);
    assert.deepEqual(
      (await audits(store, "campaign_additions_set")).map((b) => [b.campaign, b.version]),
      [["gemv", 2]],
    );
    await store.close();
  });

  test("saveWithField: the newest version is read and the next one saved as one piece", async () => {
    await withTurns(async () => {
      const store = await setup();
      // While the additions' transaction is open, with the newest version read, the owner sets
      // who writes in the collection: it waits, and builds on the version the additions saved.
      const held = await withAnotherCaller(
        store,
        store.campaigns,
        "versions",
        () => setCampaignAdditions(store, { campaign: "gemv", additions: ADDITIONS }, "owner:ui"),
        () => setCampaignKbWrites(store, { campaign: "gemv", kb_writes: WRITES }, "owner:api"),
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(held.out.state, "saved");
      assert.deepEqual(await versions(store), [3, 2, 1]);
      const last = await newest(store);
      assert.deepEqual(last.role_additions, ADDITIONS, "the later version keeps the earlier one's");
      assert.deepEqual(last.kb_writes, WRITES);
      await store.close();
    });
  });
});

describe("the owner's decision on a proposal", () => {
  test("decideProposal, declined: the decision and its audit entry", async () => {
    const store = await setup();
    const p = await proposeSetting(
      store,
      { campaign: "gemv", field: "role_additions", value: ADDITIONS },
      "operator:mcp",
    );
    assert.equal(p.state, "proposed");
    const id = (p as { id: number }).id;
    const decline = () => decideProposal(store, id, false, "owner:ui");
    const dropped = await withWriteFailing(store, store.auditLog, "add", decline);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.equal((await store.proposals.get(id))?.decision, null, "it waits for the owner still");

    const kept = await watched(store, decline);
    assert.equal(kept.out?.state, "declined");
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "campaign_proposal"] }]);
    assert.equal((await store.proposals.get(id))?.decision, "declined");
    assert.equal((await audits(store, "campaign_setting_declined")).length, 1);
    assert.deepEqual(await versions(store), [1]);
    await store.close();
  });

  test("decideProposal, a setting approved: the new version, the decision and the audit entries", async () => {
    const store = await setup();
    const p = await proposeSetting(
      store,
      { campaign: "gemv", field: "role_additions", value: ADDITIONS },
      "operator:mcp",
    );
    const id = (p as { id: number }).id;
    const approve = () => decideProposal(store, id, true, "owner:ui");
    // The decision's write fails after the new version was saved, in a transaction inside this
    // one: the version goes with the decision.
    const dropped = await withWriteFailing(store, store.proposals, "decide", approve);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await versions(store), [1], "no version from a proposal not approved");
    assert.equal((await store.proposals.get(id))?.decision, null);
    assert.deepEqual(await audits(store, "campaign_additions_set"), []);

    const kept = await watched(store, approve);
    assert.equal(kept.out?.state, "approved");
    assert.deepEqual(seen(kept), [
      {
        failed: false,
        changed: ["audit", "campaign_proposal", "campaign_version"],
      },
    ]);
    assert.deepEqual(await versions(store), [2, 1]);
    assert.deepEqual((await newest(store)).role_additions, ADDITIONS);
    assert.equal((await store.proposals.get(id))?.decision, "approved");
    assert.deepEqual(
      (await audits(store, "campaign_setting_approved")).map((b) => [b.proposal, b.version]),
      [[id, 2]],
    );
    assert.equal((await audits(store, "campaign_additions_set")).length, 1);
    await store.close();
  });

  test("decideProposal, a grant approved: the grant, the decision and the audit entries", async () => {
    const store = await setup();
    const p = await proposeSetting(
      store,
      { campaign: "gemv", field: "kb_grant", value: "survey" },
      "operator:mcp",
    );
    assert.equal(p.state, "proposed");
    const id = (p as { id: number }).id;
    const approve = () => decideProposal(store, id, true, "owner:ui");
    const dropped = await withWriteFailing(store, store.proposals, "decide", approve);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await store.kb().reads("gemv"), [], "no grant from a proposal not approved");
    assert.equal((await store.proposals.get(id))?.decision, null);

    const kept = await watched(store, approve);
    assert.equal(kept.out?.state, "approved");
    assert.equal(kept.txs.length, 1);
    assert.equal(kept.txs[0]?.failed, false);
    assert.ok(kept.txs[0]?.changed.includes("campaign_proposal"), String(kept.txs[0]?.changed));
    assert.deepEqual(await store.kb().reads("gemv"), ["survey"]);
    assert.equal((await store.proposals.get(id))?.decision, "approved");
    assert.equal((await audits(store, "kb_grant")).length, 1);
    assert.equal((await audits(store, "campaign_setting_approved")).length, 1);
    await store.close();
  });

  test("decideProposal: the proposal is read and decided as one piece", async () => {
    await withTurns(async () => {
      const store = await setup();
      const first = await proposeSetting(
        store,
        { campaign: "gemv", field: "role_additions", value: ADDITIONS },
        "operator:mcp",
      );
      const id = (first as { id: number }).id;
      const OTHER = { planner: "Try the largest change first." };
      // While the approval's transaction is open, with the proposal read, the operator proposes
      // other additions: that waits, so the owner approved what the owner read, and the new
      // proposal waits for a decision of its own.
      let second: Awaited<ReturnType<typeof proposeSetting>> | undefined;
      const held = await withAnotherCaller(
        store,
        store.proposals,
        "get",
        () => decideProposal(store, id, true, "owner:ui"),
        async () => {
          second = await proposeSetting(
            store,
            { campaign: "gemv", field: "role_additions", value: OTHER },
            "operator:mcp",
          );
        },
      );
      assert.deepEqual(held.order, HELD);
      assert.equal(held.out.state, "approved");
      assert.deepEqual((await newest(store)).role_additions, ADDITIONS);
      assert.equal(second?.state, "proposed");
      const waiting = await store.proposals.waiting("gemv");
      assert.deepEqual(
        waiting.map((w) => w.value),
        [OTHER],
      );
      assert.deepEqual(await versions(store), [2, 1], "nothing of the new proposal is saved");
      await store.close();
    });
  });
});

describe("an assignment's campaign", () => {
  test("keepAssignedCampaign: the look for the version and its save are one piece", async () => {
    await withTurns(async () => {
      const store = openControlStore(":memory:");
      await enrollRigs(store, ["rig-a", "rig-b"]);
      const { privateKeyPem } = generateSigningKeys();
      const c = contract({ campaign: "pn-prefill", version: 1 });
      const assign = (rig: string, run: string) =>
        issueCommand(store, privateKeyPem, {
          rig,
          kind: "assign_campaign",
          payload: {
            run,
            contract: c.contract,
            contract_sha: c.sha,
            seed: { repo: "my-project", commit: C },
            promotion: "owner_approval",
          },
          issuedBy: "owner:mcp",
        });
      // While the first assignment's transaction is open, with its look for the version made,
      // the same contract is assigned to another rig: that waits, and finds the version saved.
      const held = await withAnotherCaller(
        store,
        store.campaigns,
        "versions",
        () => assign("rig-a", "pn-prefill-1"),
        () => assign("rig-b", "pn-prefill-2"),
      );
      assert.deepEqual(held.order, HELD);
      const saved = await store.campaigns.versions("pn-prefill");
      assert.deepEqual(
        saved.map((v) => [v.version, v.sha]),
        [[1, c.sha]],
        "saved once",
      );
      assert.equal((await audits(store, "campaign_version_created")).length, 1);
      assert.equal((await store.commands.latest("rig-a", "assign_campaign", 5)).length, 1);
      assert.equal((await store.commands.latest("rig-b", "assign_campaign", 5)).length, 1);
      await store.close();
    });
  });
});

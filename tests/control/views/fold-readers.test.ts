import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, test } from "node:test";
import { copiedFromRecords } from "../../../src/control/campaigns/index.ts";
import { keepChampionPatch } from "../../../src/control/champions.ts";
import { checkRows } from "../../../src/control/command-progress.ts";
import { saveRunpodRig } from "../../../src/control/runpod/index.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { findRun, rigChecks, runMessages } from "../../../src/control/views/index.ts";
import { callUsage } from "../../../src/core/usage.ts";
import { applied, controlStore } from "../../helpers/control-store.ts";
import { report, SET_START, type SetEvent } from "../../helpers/view-events.ts";

/**
 * What control read from its copy of the rigs' events with a query of its own, it reads from what
 * it keeps already (goal 168, step 4): the folds of the rigs' events and the run registry. For each
 * reader, a store filled through ingest gives the answer the query gave: the owner's messages Live
 * checks a run's lines against, a rig's checks, a run's rounds, a champion's published patch, the
 * experiments a new run copies, the runs a pod's spend goes to and the campaign of a model call.
 */

const ev = (
  kind: string,
  subject: string | null,
  body: Record<string, unknown> = {},
): SetEvent => ({
  kind,
  subject,
  body,
});
/** When the event at `i` (from 0) of a report happened, as await report() times them. */
const at = (i: number) => new Date(SET_START + i * 60_000).toISOString();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const BASE = "b".repeat(40);
const OLD = Buffer.from("diff --git a/sort.c b/sort.c\n+the old run's champion\n");
const FIRST = Buffer.from("diff --git a/sort.c b/sort.c\n+champion 2, first published\n");
const SECOND = Buffer.from("diff --git a/sort.c b/sort.c\n+champion 2, published again\n");
const THIRD = Buffer.from("diff --git a/sort.c b/sort.c\n+champion 3\n");
const published = (run: string, seq: number, patch: Buffer) =>
  ev("champion_published", run, {
    seq,
    repo: "proj",
    base_commit: BASE,
    tree: "t".repeat(40),
    sha256: sha(patch),
    path: `champions/${run}/${seq}.patch`,
    export: "e-1",
  });

/**
 * rig-a ran r-0 of sort, then had a full reset; in its new ledger r-1 of sort is at work and r-2
 * of sort is paused. rig-b runs r-3 of another campaign. Applied from the events stream: the model
 * call's record and the knowledge base's runs.
 */
async function seeded(): Promise<ControlStore> {
  const store = controlStore();
  await report(store, "rig-a", "ledger-1", [
    ev("run_created", "r-0", { campaign: "sort", mode: "hill_climb" }),
    ev("agent_message", "r-0", { id: 1, to: "all", text: "The old run's words.", keep: false }),
    ev("epoch_started", "r-0", { n: 1, source: "planner" }),
    published("r-0", 2, OLD),
    ev("rig_check_finished", null, { check: "model", id: "chk-0", ok: false, summary: "old" }),
  ]);
  await report(store, "rig-a", "ledger-2", [
    ev("run_created", "r-1", { campaign: "sort", mode: "hill_climb" }),
    ev("run_created", "r-2", { campaign: "sort", mode: "hill_climb" }),
    ev("run_status", "r-2", { status: "paused", reason: "the owner paused it" }),
    ev("agent_message", "r-1", { id: 1, to: "planner", text: "Try tiling first.", keep: true }),
    ev("agent_message", "r-1", { id: 2, to: "lane-1", text: "Mind the tail.", keep: false }),
    ev("agent_message_read", "r-1", { message: 1, by: "planner", round: 1 }),
    ev("agent_message", "r-2", { id: 3, to: "all", text: "Another run's words.", keep: false }),
    ev("epoch_started", "r-1", { n: 1, source: "planner" }),
    ev("experiment_added", "r-1", {
      id: "x-1",
      title: "tile 64",
      family: "tiling",
      by: "planner",
      state: "queued",
    }),
    ev("experiment_edited", "r-1", { id: "x-1", by: "owner", title: "tile 64, then 128" }),
    ev("experiment_edited", "r-1", { id: "x-1", by: "owner", why: "it won before" }),
    ev("experiment_added", "r-1", {
      id: "x-2",
      title: "vector loads",
      details: "Use wide loads.",
      by: "owner",
      state: "queued",
    }),
    ev("epoch_started", "r-1", { n: 2, source: "fallback" }),
    published("r-1", 2, FIRST),
    published("r-1", 3, THIRD),
    published("r-1", 2, SECOND),
    ev("rig_check_started", null, { check: "smoke", id: "chk-1" }),
    ev("rig_check_finished", null, { check: "smoke", id: "chk-1", ok: true, summary: "ok" }),
    ev("rig_check_started", null, { check: "isolation", id: "chk-2" }),
    ev("model_call", "r-1", {
      trial: null,
      round: "1",
      agent: "planner",
      harness: "pi",
      provider: "lab",
      model: "wide-model",
      ...callUsage({ at: at(19), calls: 1, tokensIn: 100, cachedIn: null, tokensOut: 20 }),
    }),
  ]);
  await report(store, "rig-b", "ledger-b", [
    ev("run_created", "r-3", { campaign: "other", mode: "hill_climb" }),
    ev("experiment_added", "r-3", { id: "x-1", title: "unroll", by: "planner", state: "queued" }),
  ]);
  await applied(store);
  return store;
}

describe("control's readers of the rigs' events read what it keeps already", () => {
  let store: ControlStore;
  before(async () => {
    store = await seeded();
  });

  test("Live checks a run's message lines against the owner's messages on its rig's current ledger", () => {
    assert.deepEqual(
      [...runMessages(store, "rig-a", "r-1")],
      [
        [1, { to: "planner", text: "Try tiling first.", keep: true }],
        [2, { to: "lane-1", text: "Mind the tail.", keep: false }],
      ],
    );
    assert.deepEqual(
      [...runMessages(store, "rig-a", "r-2")],
      [[3, { to: "all", text: "Another run's words.", keep: false }]],
    );
    // A run of the rig's earlier ledger, another rig's run and an unknown rig have none.
    assert.deepEqual([...runMessages(store, "rig-a", "r-0")], []);
    assert.deepEqual([...runMessages(store, "rig-b", "r-1")], []);
    assert.deepEqual([...runMessages(store, "rig-9", "r-1")], []);
  });

  test("a check's row reads each check's newest run on the rig's current ledger", () => {
    const smoke = {
      check: "smoke",
      started_at: at(16),
      finished_at: at(17),
      ok: true,
      summary: "ok",
      note: null,
      id: "chk-1",
    };
    const isolation = {
      check: "isolation",
      started_at: at(18),
      finished_at: null,
      ok: null,
      summary: null,
      note: null,
      id: "chk-2",
    };
    assert.deepEqual(rigChecks(store, "rig-a"), { smoke, isolation });
    assert.deepEqual(rigChecks(store, "rig-9"), {});
    // The earlier ledger's model check is not the rig's now: its row has none.
    const rows = checkRows(store, "rig-a", Date.parse(at(30)));
    assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.state])), {
      model: "none",
      isolation: "running",
      smoke: "passed",
    });
  });

  test("a run page's rounds are the times its rounds started, in the ledger it ran in", async () => {
    assert.deepEqual((await findRun(store, "r-1"))?.run.round_starts, [at(7), at(12)]);
    assert.deepEqual((await findRun(store, "r-0"))?.run.round_starts, [at(2)]);
    assert.deepEqual((await findRun(store, "r-3"))?.run.round_starts, []);
  });

  test("a champion's patch is kept when it is the newest one its run published as that champion", async () => {
    const s = await seeded();
    assert.equal(await keepChampionPatch(s, "rig-a", "r-1", 2, FIRST), "mismatch");
    assert.equal(await keepChampionPatch(s, "rig-a", "r-1", 2, SECOND), "stored");
    assert.equal(await keepChampionPatch(s, "rig-a", "r-1", 3, THIRD), "stored");
    assert.equal(await keepChampionPatch(s, "rig-a", "r-1", 4, THIRD), "not_published");
    assert.equal(await keepChampionPatch(s, "rig-b", "r-1", 2, SECOND), "not_published");
    // A run from before the rig's full reset keeps its own, in its own ledger.
    assert.equal(await keepChampionPatch(s, "rig-a", "r-0", 2, OLD), "stored");
    const patch = async (run: string, seq: number) => {
      const x = await findRun(s, run);
      return x && s.championPatches.get(x.rig.id, x.rig.ledger_id, run, seq);
    };
    assert.deepEqual(await patch("r-1", 2), {
      patch: SECOND,
      sha256: sha(SECOND),
      base_commit: BASE,
    });
    assert.deepEqual((await patch("r-1", 3))?.patch, THIRD);
    assert.deepEqual((await patch("r-0", 2))?.patch, OLD);
    assert.equal(s.championPatches.get("rig-a", "ledger-1", "r-1", 2), undefined);
  });

  test("a copied experiment takes its author and its words after every edit from its run", async () => {
    const from = (run: string, id: string) => ({ run, id });
    assert.deepEqual(
      await copiedFromRecords(store, "sort", [
        { title: "the caller's words", by: "someone", from: from("r-1", "x-1") },
        { title: "vector", details: "the caller's details", from: from("r-1", "x-2") },
        { title: "no such experiment", from: from("r-1", "x-9") },
        { title: "of a campaign sort may not read", from: from("r-3", "x-1") },
      ]),
      [
        {
          from: from("r-1", "x-1"),
          title: "tile 64, then 128",
          family: "tiling",
          why: "it won before",
          by: "planner",
        },
        {
          from: from("r-1", "x-2"),
          title: "vector loads",
          details: "Use wide loads.",
          by: "owner",
        },
        { title: "no such experiment", from: from("r-1", "x-9"), by: "copied" },
        { title: "of a campaign sort may not read", from: from("r-3", "x-1"), by: "copied" },
      ],
    );
  });

  test("a pod's spend goes to the runs its rig runs on its current ledger, with their campaign", async () => {
    const s = await seeded();
    s.runpod.addRig({ rig: "rig-a", cloud: "rp", pod: "p-1", state: { spent_usd: 0 }, by: "t" });
    saveRunpodRig(s, "rig-a", { spent_usd: 0.5 }, true);
    assert.deepEqual(
      s.usage.podSpend({ kind: "system" }, null).map((r) => [r.rig, r.run, r.campaign, r.usd]),
      [["rig-a", "r-1", "sort", 0.5]],
    );
  });

  test("a model call's record has the campaign of the run its rig created", () => {
    assert.deepEqual(
      store.usage.rows({ kind: "system" }, null).map((r) => [r.rig, r.run, r.campaign]),
      [["rig-a", "r-1", "sort"]],
    );
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEADLINE_STEP } from "../../../src/control/clusters/index.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import { control, fakeCluster, KUBECONFIG, mcpWith, OPERATOR } from "../../helpers/fake-cluster.ts";

const SINCE = "2026-10-29T08:00:00.000Z";
const DEADLINE = "2026-10-29T09:00:00.000Z";
const OPEN = {
  trial: "t-7",
  run: "r-1",
  lane: "lane-1",
  started_at: "2026-10-29T07:30:00.000Z",
  task: "Tile the inner loop",
  question: null,
  turns: 40,
  tool_calls: 31,
  tokens_in: 120_000,
  claims: null,
  refused_again: null,
};

/** A rig's work with a drain past its deadline, as its harness reports it. */
const overdue = (trials = 1) => ({
  trials,
  judge_jobs: 1,
  draining: {
    since: SINCE,
    reason: "its images are about to change",
    by: "control:owner:ui",
    deadline: DEADLINE,
    deadline_reached: DEADLINE,
  },
  open: trials ? [OPEN] : [],
});

/** A cluster rig control set up and asked to update, with a drain watch every 20 ms. */
async function drainingRig() {
  const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
  const before = await control(f.k);
  await before.post("/ui/settings/add", {
    type: "k8s",
    name: "k8s-c",
    kubeconfig: KUBECONFIG,
    placement: "slot",
    slots: "thermite-slot-1",
  });
  await before.post("/ui/rigs/add", {
    place: "cluster:k8s-c",
    rig: "cpu-1",
    "k_gpus__k8s-c": "0",
    "k_slot__k8s-c": "thermite-slot-1",
  });
  await new Promise((r) => setTimeout(r, 20));
  before.store.clusters.setRigStatus("cpu-1", "running");
  const report = async (work: Record<string, unknown>, rig = "cpu-1") =>
    await ingestReport(before.store, {
      rig,
      ledger_id: `l-${rig}`,
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { work },
    });
  await report({ trials: 1, judge_jobs: 0, draining: null });
  const s = await control(f.k, {
    store: before.store,
    secrets: before.secrets,
    tag: "2",
    drainWatchMs: 20,
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  const steps = (rig = "cpu-1") => s.store.rigHistory.list(rig).map((x) => x.step);
  const drains = (rig = "cpu-1") =>
    s.store.commands.latest(rig, "drain_rig").map((c) => c.payload as Record<string, unknown>);
  const applied = () => f.calls.some((c) => c.args[0] === "apply");
  return { f, s, report, until, steps, drains, applied };
}

describe("a drain that ends (goal 173)", () => {
  test("an update gives its drain a deadline; a drain that ends by itself before it asks nothing", async () => {
    const { f, s, report, until, steps, drains, applied } = await drainingRig();
    const op = await mcpWith(s.api, OPERATOR);
    const r = await op.call("update_rig_images", { rig: "cpu-1", drain_minutes: 30 });
    await op.close();
    assert.equal(r.error, false, JSON.stringify(r.body));
    assert.deepEqual(drains()[0], {
      drain: true,
      reason: "its images are about to change",
      deadline_minutes: 30,
    });
    f.calls.length = 0;
    // The rig took the drain: its page says when its deadline falls.
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
    await report({
      trials: 1,
      judge_jobs: 0,
      draining: { since: new Date().toISOString(), reason: "r", deadline },
    });
    assert.match(
      await s.page("/ui/rigs/cpu-1"),
      new RegExp(`Its deadline is ${deadline.slice(11, 16)} UTC, in (29|30) min`),
    );
    // Its trial ends before the deadline: the pods restart, and nothing asks the owner.
    await report({
      trials: 0,
      judge_jobs: 0,
      draining: { since: SINCE, reason: "r", deadline: DEADLINE },
    });
    await until(applied);
    assert.ok(applied(), "restarted once nothing ran");
    assert.ok(!steps().includes(DEADLINE_STEP));
    assert.doesNotMatch(await s.page("/ui"), /passed its deadline/);
  });

  test("one that reaches its deadline records the step once, and asks the owner with both choices", async () => {
    const { f, s, report, until, steps, applied } = await drainingRig();
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    f.calls.length = 0;
    await report(overdue());
    await until(() => steps().includes(DEADLINE_STEP));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(steps().filter((x) => x === DEADLINE_STEP).length, 1, "once");
    assert.match(
      s.store.rigHistory.list("cpu-1").find((x) => x.step === DEADLINE_STEP)?.detail ?? "",
      /its deadline passed after 60 min, with 1 trial and the judge's job still at work/,
    );
    // Nothing is chosen for the owner.
    assert.ok(!applied());
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "draining");
    const needs = await s.page("/ui");
    assert.match(needs, /cpu-1&#39;s drain passed its deadline|cpu-1's drain passed its deadline/);
    assert.match(needs, /action="\/ui\/rigs\/cpu-1\/drain\/apply"/);
    assert.match(needs, /action="\/ui\/rigs\/cpu-1\/drain\/end"/);
    assert.match(needs, /Update it now/);
    assert.match(needs, /the update is called off/);
    const page = await s.page("/ui/rigs/cpu-1");
    assert.match(page, /Its deadline passed at 09:00 UTC/);
  });

  test("the owner's choice: go ahead now, which stops what still runs", async () => {
    const { f, s, report, until, steps, applied } = await drainingRig();
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    f.calls.length = 0;
    await report(overdue());
    assert.match(
      await s.post("/ui/rigs/cpu-1/drain/apply", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
    await until(applied);
    assert.ok(applied());
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "updating");
    assert.ok(steps().includes("images"));
  });

  test("the owner's choice: end the drain, and the update waits", async () => {
    const { f, s, report, drains, applied } = await drainingRig();
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    f.calls.length = 0;
    await report(overdue());
    assert.match(
      await s.post("/ui/rigs/cpu-1/drain/end", {}),
      /ok=cpu-1 goes back to work on its images/,
    );
    assert.ok(drains().some((d) => d.drain === false));
    assert.equal(s.store.clusters.rig("cpu-1")?.status, "running");
    assert.ok(!applied());
  });

  test("on a rig whose change is not control's: stop what still runs, or end the drain", async () => {
    const { s, report, until, steps } = await drainingRig();
    await report(overdue(), "local-1");
    await until(() => steps("local-1").includes(DEADLINE_STEP));
    assert.match(await s.page("/ui"), /Stop what still runs/);
    assert.match(
      await s.post("/ui/rigs/local-1/drain/apply", {}),
      /ok=1 trial of local-1 stops now, each with its task back in its run's queue/,
    );
    const stop = s.store.commands.latest("local-1", "stop_trial")[0];
    assert.deepEqual(stop?.payload, {
      run: "r-1",
      trial: "t-7",
      reason: "the drain reached its deadline",
    });
    assert.match(await s.post("/ui/rigs/local-1/drain/end", {}), /ok=local-1 goes back to work/);
    assert.deepEqual(s.store.commands.latest("local-1", "drain_rig")[0]?.payload, {
      drain: false,
      reason: "the owner ended the drain at its deadline",
    });
    // A rig that does not drain has nothing to choose.
    await report({ trials: 0, judge_jobs: 0, draining: null }, "local-2");
    assert.match(await s.post("/ui/rigs/local-2/drain/end", {}), /error=local-2 is not draining/);
  });
});

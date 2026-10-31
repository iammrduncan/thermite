import assert from "node:assert/strict";
import { test } from "node:test";
import type { RigView, RunView } from "../../../../src/control/views/index.ts";
import { applied, controlStore, ingestReport } from "../../../helpers/control-store.ts";
import { rig, statusRun } from "./fixtures.ts";

/**
 * A run's Experiments and Planner tabs: a judge-only run's queue, and the planner's rounds
 * counted and said in words.
 */

test("a judge-only run's queue says no worker takes it, and how to carry it to a run with workers (goal 099)", async () => {
  const { experimentsTab, judgeOnlyQueueLine } = await import(
    "../../../../src/control/ui/campaigns/queue/index.ts"
  );
  const waiting = (state: string) =>
    [
      {
        id: "x-000000000001",
        title: "tile the loop",
        state,
        position: 0,
        by: "teacher",
        family: "",
        why: "",
        at: "2026-10-21T00:00:00Z",
        updated_at: "2026-10-21T00:00:00Z",
      },
    ] as unknown as RunView["queue"];
  const run = (has_agents: boolean, queue: RunView["queue"]) =>
    statusRun("q-1", "running", "2026-10-20T00:00:00Z", {
      has_agents,
      queue,
      at_work: {},
    } as Partial<RunView>);
  const LINE =
    /<b>Judge only:<\/b> no worker takes these experiments, so they wait for a run with workers\. To carry them over, <a href="\/ui\/campaigns\/quality\?start=1&amp;copy=q-1">Start a run<\/a> of the campaign with <b>Copy the untried experiments of<\/b> q-1 ticked\./;
  const tab = (r: RunView) =>
    experimentsTab({
      u: rig,
      r,
      now: Date.parse("2026-10-22T00:00:00Z"),
      csrf: "c",
      back: "/ui/campaigns/quality/runs/q-1/experiments",
      cmd: () => "",
      families: [],
    });
  assert.match(tab(run(false, waiting("queued"))), LINE);
  assert.match(judgeOnlyQueueLine(run(false, waiting("proposed"))), LINE);
  // A run with workers, or nothing waiting: no line.
  assert.doesNotMatch(tab(run(true, waiting("queued"))), /Judge only/);
  assert.equal(judgeOnlyQueueLine(run(false, [])), "");
  assert.equal(judgeOnlyQueueLine(run(false, waiting("done"))), "");
});

test("the Planner tab counts rounds, and says plainly when the planner is off", async () => {
  const { plannerTab } = await import("../../../../src/control/ui/campaigns/queue/index.ts");
  const tab = (settings: Record<string, unknown> | null, epochs: number) =>
    plannerTab({
      u: { id: "rig-a", settings } as unknown as RigView,
      r: {
        id: "r-1",
        mode: "hill_climb",
        rules: [],
        directions: [],
        handouts: [],
        queue: [],
        messages: [],
        agents: { epochs, planner_valid: epochs - 1, fallbacks: 1 },
      } as unknown as RunView,
      now: Date.parse("2026-10-20T01:00:00Z"),
      csrf: "c",
      back: "/ui/campaigns/x/runs/r-1/planner",
      cmd: () => "",
      model: "m",
      figures: "",
      propagate: "",
    });
  const on = tab({ planner: true }, 3);
  assert.match(on, /3 rounds so far: 2 planned by the model, 1 in queue order by the fixed rules/);
  assert.doesNotMatch(on, /hand-outs:/);
  assert.match(tab({ planner: true }, 1), /1 round so far:/);
  assert.match(on, /Send to the planner/);
  const off = tab({ planner: false }, 3);
  assert.match(off, /The planner is off on this rig, so it reads no messages/);
  assert.doesNotMatch(off, /Send to the planner/);
});

test("a research run's rounds are counted as research rounds, not as planner fallbacks (goal 079)", async () => {
  const { rigView } = await import("../../../../src/control/views/index.ts");
  const store = controlStore();
  const ev = (kind: string, subject: string, body: Record<string, unknown>) => ({
    kind,
    subject,
    actor: "scheduler",
    at: "2026-10-22T00:00:00Z",
    body,
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "l-1",
    cursor: 0,
    next: 3,
    generated_at: "2026-10-22T00:00:00Z",
    events: [
      ev("run_created", "r-1", { mode: "research", campaign: "c" }),
      ev("epoch_started", "r-1", {
        n: 1,
        source: "fallback",
        plan: "research",
        planner_valid: false,
      }),
      ev("epoch_started", "r-1", {
        n: 2,
        source: "fallback",
        plan: "research",
        planner_valid: false,
      }),
    ].map((e, i) => ({ id: i + 1, ...e })),
    summary: {},
  } as never);
  await applied(store);
  const v = rigView(store, "rig-a", { staleAfterMs: 600_000 });
  const a = v?.runs.find((r) => r.id === "r-1")?.agents;
  assert.deepEqual([a?.epochs, a?.research_rounds, a?.fallbacks], [2, 2, 0]);
});

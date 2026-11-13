import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlStore } from "../../src/control/store/index.ts";
import { runStatsTab } from "../../src/control/ui/usage.ts";
import { modelUsage } from "../../src/control/usage-report.ts";
import { callUsage, type UsageReport } from "../../src/core/usage.ts";
import { applied, controlStore, ingestReport } from "../helpers/control-store.ts";

/**
 * Goal 193 (issue 52): a run's usage lists every agent its rig gives a model to. One with records
 * is marked configured; one with none has a line of its own, with no records and why: its part off
 * on Edit rig, its newest Live line that says it had no answer, else when it works. Only for one
 * run over all its time, and not for a closed run.
 */

const AT = "2026-11-03T19:00:00.000Z";
const NO_ANSWER =
  "teacher-2 has no answer after 30 s: Claude Code is not in this supervisor's image: build the supervisor with CLAUDE_CODE_VERSION";

const call = (agent: string, harness: string, provider: string, model: string) => ({
  trial: null,
  round: null,
  agent,
  harness,
  provider,
  model,
  ...callUsage({ at: AT, calls: 1, tokensIn: 1000, cachedIn: 0, tokensOut: 100, callMs: 1000 }),
});

async function stack(): Promise<ControlStore> {
  const store = controlStore();
  for (const [name, type] of [
    ["lab", "openai"],
    ["chatgpt-plan", "chatgpt"],
    ["claude-sub", "claude"],
  ] as const)
    await store.modelProviders.put({
      name,
      type,
      base_url: "https://models.example/v1",
      key: { sealed: "sealed-for-the-tests", hint: "…test" },
    });
  await store.agentModels.assignRig("rig-t", {
    provider: "lab",
    model: "wide-model",
    harness: "pi",
  });
  await store.agentModels.assignRole("rig-t", "teachers", {
    provider: "chatgpt-plan",
    model: "gpt-6.1",
    harness: "codex",
  });
  await store.agentModels.assignRole("rig-t", "second_teacher", {
    provider: "claude-sub",
    model: "sonnet-5.5",
    harness: "claude-code",
  });
  await store.agentModels.assignRole("rig-t", "merged_by", {
    provider: "lab",
    model: "wide-model",
    harness: "pi",
  });
  await store.agentModels.assignRole("rig-t", "auditor", {
    provider: "claude-sub",
    model: "opus-5.5",
    harness: "claude-code",
  });
  const events: [string, string, Record<string, unknown>][] = [
    ["run_created", "g-1", { campaign: "gemv", mode: "goal", version: 1, agents: true }],
    ["run_status", "g-1", { status: "running" }],
    ["run_created", "g-0", { campaign: "gemv", mode: "goal", version: 1, agents: true }],
    ["run_status", "g-0", { status: "closed" }],
    ["model_call", "g-1", call("workers", "pi", "lab", "wide-model")],
    ["model_call", "g-1", call("teachers", "codex", "chatgpt-plan", "gpt-6.1")],
    // Claude Code records a subscription's model by its own name.
    ["model_call", "g-1", call("auditor", "claude-code", "claude-sub", "claude-opus-5-5")],
    ["model_call", "g-0", call("workers", "pi", "lab", "wide-model")],
  ];
  await ingestReport(store, {
    rig: "rig-t",
    ledger_id: "ledger-t",
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: i + 1,
      at: AT,
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: { settings: { planner: false } },
  });
  await applied(store);
  await store.liveLines.add(
    "rig-t",
    "log-1",
    [
      {
        seq: 1,
        at: AT,
        source: "advisor:teacher-2",
        kind: "status",
        text: "teacher-2 starts, in Claude Code's own terminal",
        run: "g-1",
      },
      {
        seq: 2,
        at: "2026-11-03T19:06:00.000Z",
        source: "advisor:teacher-2",
        kind: "status",
        text: NO_ANSWER,
        run: "g-1",
      },
    ],
    false,
  );
  return store;
}

const lineOf = (l: UsageReport["by_agent_model"][number]) => [
  l.agent,
  l.harness,
  l.model,
  l.records,
  l.configured ?? false,
  l.why ?? null,
];

describe("a run's usage lists every agent with a model (goal 193)", () => {
  test("lines with records are marked; agents with none get a line, with why", async () => {
    const store = await stack();
    const r = await modelUsage(store, { run: "g-1" });
    assert.deepEqual(r.by_agent_model.map(lineOf), [
      ["workers", "pi", "wide-model", 1, true, null],
      [
        "planner",
        "pi",
        "wide-model",
        0,
        true,
        "The planner is off on Edit rig: the fixed rules plan each round.",
      ],
      ["teachers", "codex", "gpt-6.1", 1, true, null],
      ["teachers", "claude-code", "sonnet-5.5", 0, true, NO_ANSWER],
      [
        "merged_by",
        "pi",
        "wide-model",
        0,
        true,
        "It merges the teachers' reviews after a round of two teachers in which at least one gave a review.",
      ],
      ["auditor", "claude-code", "claude-opus-5-5", 1, true, null],
    ]);
    const second = r.by_agent_model.find((l) => l.model === "sonnet-5.5");
    assert.equal(second?.why_at, "2026-11-03T19:06:00.000Z");
    assert.equal(second?.calls, 0);
    // The totals count records only.
    assert.equal(r.total.records, 3);
  });

  test("none for part of the run's time, nor for a closed run", async () => {
    const store = await stack();
    const today = await modelUsage(store, { run: "g-1", period: "7d" });
    assert.ok(today.by_agent_model.every((l) => l.configured === undefined && l.records > 0));
    const closed = await modelUsage(store, { run: "g-0" });
    assert.deepEqual(closed.by_agent_model.map(lineOf), [
      ["workers", "pi", "wide-model", 1, false, null],
    ]);
  });

  test("the Stats tab: No calls yet, with why, in place of the figures", async () => {
    const store = await stack();
    const html = runStatsTab({
      report: await modelUsage(store, { run: "g-1" }),
      rows: [],
      roundStarts: [],
      trials: 0,
      rounds: 0,
      wallMs: null,
      rig: "rig-t",
      teacher: (_p, model) => (model === "sonnet-5.5" ? "teacher 2" : "teacher 1"),
      live: "/ui/campaigns/gemv/runs/g-1/live?view=lines",
    });
    assert.equal(html.match(/<tr class="u-none">/g)?.length, 3);
    assert.match(
      html,
      /<b>Teachers<\/b><span class="us">teacher 2<\/span>.*No calls yet .*On Live at 19:06 UTC: <code>teacher-2 has no answer after 30 s: Claude Code is not in this supervisor's image/,
    );
    assert.match(
      html,
      /<a href="\/ui\/campaigns\/gemv\/runs\/g-1\/live\?view=lines">Open Live ›<\/a>/,
    );
    assert.match(html, /The planner is off on Edit rig: the fixed rules plan each round\./);
  });
});

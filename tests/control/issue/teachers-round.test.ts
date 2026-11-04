import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { teachersRoundAsked } from "../../../src/control/issue/index.ts";
import { ADMIN, controlOnly, mcpClient } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 194 (issue 53): the owner or an operator asks a run's teachers for a round now. Control
 * signs one start_teachers_round for the run's rig, from REST, MCP or the dashboard, and refuses
 * before signing a run its rig reports paused or closed, a rig with no teachers and a rig with
 * its teachers off. An agent's token has no such tool.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  rigs: {},
};

const TEACHER = {
  harness: "pi",
  model: "model-a",
  provider: null,
  api: "openai",
  context_window: 200_000,
  compact_at: null,
};
const FILE = { teachers: [TEACHER], merged_by: null, auditor: null, review_panel: [] };

type Ev = [string, string, Record<string, unknown>];

/** A rig's report of runs and their statuses, with its settings. */
async function report(
  store: ReturnType<typeof controlOnly>["store"],
  rig: string,
  events: Ev[],
  settings: Record<string, unknown> = {},
) {
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-11-03T20:00:00Z") + i * 60_000).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: { settings },
  });
}

const created = (run: string): Ev => [
  "run_created",
  run,
  { campaign: "gemv", mode: "goal", agents: true },
];
const status = (run: string, s: string): Ev => ["run_status", run, { status: s }];

async function stack() {
  const { store, keys, control } = controlOnly({ tokens: TOKENS });
  await report(store, "rig-t", [
    created("tr-1"),
    status("tr-1", "running"),
    created("tr-2"),
    status("tr-2", "paused"),
    created("tr-3"),
    status("tr-3", "closed"),
    created("tr-4"),
  ]);
  store.reportedRigs.setSupervisor("rig-t", { advisors: { file: FILE } });
  await report(store, "rig-n", [created("tn-1"), status("tn-1", "running")]);
  store.reportedRigs.setSupervisor("rig-n", { advisors: null });
  await report(store, "rig-o", [created("to-1"), status("to-1", "running")], { teachers: false });
  store.reportedRigs.setSupervisor("rig-o", { advisors: { file: FILE } });
  const rest = (run: string) =>
    control.request(`/v1/runs/${run}/teachers-round`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
  return { store, keys, control, rest };
}

describe("a teachers' round on request, at control (goal 194)", () => {
  test("refused before signing: a paused or closed run, no teachers, teachers off", async () => {
    const { store } = await stack();
    const asked = (rig: string, run: string) => teachersRoundAsked(store, rig, { run });
    assert.equal(asked("rig-t", "tr-1"), "");
    assert.equal(
      asked("rig-t", "tr-2"),
      "tr-2 is paused: resume it first, and its teachers review it at their next round.",
    );
    assert.equal(asked("rig-t", "tr-3"), "tr-3 is closed: its teachers review only a running run.");
    // A run whose status the rig has not reported yet, or not at all: the rig's to check.
    assert.equal(asked("rig-t", "tr-4"), "");
    assert.equal(asked("rig-t", "tr-9"), "");
    assert.equal(asked("rig-n", "tn-1"), "rig-n has no teachers: give them a model on Edit rig.");
    assert.equal(asked("rig-o", "to-1"), "rig-o's teachers are off: switch them on on Edit rig.");
    // Teachers control gives the rig count as its own, whatever its file says.
    store.modelProviders.put({
      name: "oai",
      type: "openai",
      base_url: "https://models.example/v1",
      key: { sealed: "sealed-for-the-tests", hint: "…test" },
    });
    store.agentModels.assignRole("rig-n", "teachers", { provider: "oai", model: "m1" });
    assert.equal(asked("rig-n", "tn-1"), "");
  });

  test("REST signs one start_teachers_round for the run's rig, or refuses in words", async () => {
    const { store, rest } = await stack();
    const ok = await rest("tr-1");
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.started, true);
    assert.equal(body.rig, "rig-t");
    assert.equal(
      body.said,
      "rig-t's teachers review tr-1 within a minute, or when a round under way ends.",
    );
    const signed = store.commands.list(10);
    assert.deepEqual(
      signed.map((c) => [c.kind, c.rig, c.issued_by, c.id === body.id]),
      [["start_teachers_round", "rig-t", "owner:api", true]],
    );
    const paused = await rest("tr-2");
    assert.equal(paused.status, 409);
    assert.match(((await paused.json()) as { error: string }).error, /^tr-2 is paused: resume it/);
    const none = await rest("nowhere-1");
    assert.equal(none.status, 404);
    assert.equal(store.commands.list(10).length, 1, "nothing more was signed");
  });

  test("MCP: the owner's and an operator's tool, never an agent's", async () => {
    const { store, control } = await stack();
    const operator = await mcpClient(control, TOKENS.operator);
    const out = await operator.callTool({
      name: "start_teachers_round",
      arguments: { run: "tr-1" },
    });
    assert.ok(!out.isError, JSON.stringify(out));
    const said = JSON.parse((out.content as { text: string }[])[0]?.text ?? "{}");
    assert.equal(said.started, true);
    assert.equal(store.commands.list(10)[0]?.issued_by, "owner:operator");
    const refused = await operator.callTool({
      name: "start_teachers_round",
      arguments: { run: "tr-3" },
    });
    assert.ok(refused.isError);
    assert.match(JSON.stringify(refused.content), /tr-3 is closed/);
    await operator.close();
    const agent = await mcpClient(control, TOKENS.agent);
    const tools = (await agent.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.includes("start_teachers_round"));
    const issued = await agent.callTool({
      name: "issue_command",
      arguments: { kind: "start_teachers_round", payload: { run: "tr-1" } },
    });
    assert.ok(issued.isError, "not among an agent's kinds");
    await agent.close();
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HOURS_SPENT } from "../../../src/core/contract.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 198, item 2: the owner or an operator adds hours to a run's stop time. Control signs one
 * add_run_hours for the run's rig, from REST, MCP or the run's page, whose Add hours shows on a
 * run its hours paused; a closed run is refused before signing. An agent's token has no such tool.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  rigs: {},
};

type Ev = [string, string, Record<string, unknown>];

async function stack() {
  const { store, control } = await controlOnly({ tokens: TOKENS });
  const events: Ev[] = [
    ["run_created", "h-1", { campaign: "gemv", mode: "hill_climb", version: 1, agents: true }],
    ["run_status", "h-1", { status: "paused", reason: HOURS_SPENT }],
    ["run_created", "h-0", { campaign: "gemv", mode: "hill_climb", version: 1, agents: true }],
    ["run_status", "h-0", { status: "closed", reason: "done" }],
  ];
  await ingestReport(store, {
    rig: "rig-h",
    ledger_id: "ledger-h",
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-11-04T01:00:00Z") + i * 60_000).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: {},
  });
  const rest = (run: string, body: unknown) =>
    control.request(`/v1/runs/${run}/hours`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { store, control, rest };
}

describe("hours added to a run, at control (goal 198)", () => {
  test("REST signs one add_run_hours for the run's rig, or refuses in words", async () => {
    const { store, rest } = await stack();
    const ok = await rest("h-1", { hours: 24 });
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.rig, "rig-h");
    assert.equal(
      body.said,
      "rig-h adds 24 hours to h-1 within a minute: a run whose hours ran out resumes.",
    );
    assert.deepEqual(
      (await store.commands.list(10)).map((c) => [c.kind, c.rig, c.issued_by]),
      [["add_run_hours", "rig-h", "owner:api"]],
    );
    const closed = await rest("h-0", { hours: 24 });
    assert.equal(closed.status, 409);
    assert.equal(
      ((await closed.json()) as { error: string }).error,
      "h-0 is closed: start a new run of its campaign instead.",
    );
    const none = await rest("h-1", { hours: 0 });
    assert.equal(none.status, 400);
    assert.equal((await store.commands.list(10)).length, 1, "nothing more was signed");
  });

  test("MCP: the owner's and an operator's tool, never an agent's", async () => {
    const { store, control } = await stack();
    const operator = await mcpClient(control, TOKENS.operator);
    const out = await operator.callTool({
      name: "add_run_hours",
      arguments: { run: "h-1", hours: 12 },
    });
    assert.ok(!out.isError, JSON.stringify(out));
    assert.equal((await store.commands.list(10))[0]?.issued_by, "owner:operator");
    await operator.close();
    const agent = await mcpClient(control, TOKENS.agent);
    const tools = (await agent.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.includes("add_run_hours"));
    await agent.close();
  });

  test("the run's page offers Add hours on a run its hours paused", async () => {
    const { control } = await stack();
    const { page } = await signIn(control);
    const html = await page("/ui/campaigns/gemv/runs/h-1");
    assert.match(html, /<summary class="btn primary">Add hours<\/summary>/);
    assert.match(html, /name="kind" value="add_run_hours"/);
    assert.match(html, /<button class="sm">Add hours and resume<\/button>/);
    // A closed run has none.
    assert.doesNotMatch(await page("/ui/campaigns/gemv/runs/h-0"), /Add hours/);
  });
});

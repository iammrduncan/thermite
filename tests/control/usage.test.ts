import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { saveRunpodRig } from "../../src/control/runpod/index.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { modelUsage } from "../../src/control/usage.ts";
import { rigView } from "../../src/control/views/index.ts";
import { callUsage } from "../../src/core/usage.ts";
import { ADMIN, controlOnly, mcpClient } from "../helpers/control-stack.ts";
import { applied, controlStore, heldEvents, ingestReport } from "../helpers/control-store.ts";

/**
 * Model usage on control (goal 075): the rigs' model_call events become rows the sums read, for a
 * run, a campaign (all its runs on every rig) or the whole system, over a period; REST and MCP
 * give the same report. The pages built from every event leave the calls out.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A model_call event's body: the record's context and its measure. */
const call = (o: {
  agent?: string;
  harness?: string;
  model?: string;
  at: string;
  tokensIn: number;
  cachedIn?: number | null;
  tokensOut: number;
  callMs?: number | null;
  calls?: number | null;
  trial?: string | null;
}) => ({
  trial: o.trial ?? null,
  round: null,
  agent: o.agent ?? "workers",
  harness: o.harness ?? "pi",
  provider: "lab",
  model: o.model ?? "wide-model",
  ...callUsage({
    at: o.at,
    calls: o.calls === undefined ? 1 : o.calls,
    tokensIn: o.tokensIn,
    cachedIn: o.cachedIn ?? null,
    tokensOut: o.tokensOut,
    callMs: o.callMs ?? null,
  }),
});

async function ingest(
  store: ControlStore,
  rig: string,
  ledger: string,
  events: [string, string, Record<string, unknown>][],
  first = 1,
) {
  await ingestReport(store, {
    rig,
    ledger_id: ledger,
    cursor: first - 1,
    next: first - 1 + events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: first + i,
      at: new Date(NOW).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: {},
  });
  // The usage rows are written as the apply of the events stream applies the events.
  await applied(store);
}

/** rig-a ran r-1 of matmul; rig-b ran r-2 of matmul and r-3 of gemv. */
async function stack() {
  const store = controlStore();
  await ingest(store, "rig-a", "ledger-a", [
    ["run_created", "r-1", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
    [
      "model_call",
      "r-1",
      call({
        trial: "t-1",
        at: ago(1),
        tokensIn: 1000,
        cachedIn: 600,
        tokensOut: 100,
        callMs: 1000,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({ trial: "t-1", at: ago(2), tokensIn: 1000, cachedIn: 0, tokensOut: 100, callMs: 4000 }),
    ],
    [
      "model_call",
      "r-1",
      call({ agent: "planner", model: "small-model", at: ago(30), tokensIn: 500, tokensOut: 50 }),
    ],
    // A body that does not read as a record stays an event, and no sum counts it.
    ["model_call", "r-1", { agent: "workers", tokens_in: "lots" }],
  ]);
  await ingest(store, "rig-b", "ledger-b", [
    ["run_created", "r-2", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
    ["run_created", "r-3", { campaign: "gemv", mode: "goal", version: 1, agents: true }],
    [
      "model_call",
      "r-2",
      call({ harness: "codex", at: ago(3), tokensIn: 7000, tokensOut: 300, calls: null }),
    ],
    [
      "model_call",
      "r-3",
      call({
        agent: "auditor",
        harness: "claude-code",
        at: ago(24 * 9),
        tokensIn: 400,
        tokensOut: 100,
      }),
    ],
  ]);
  const { control: api } = controlOnly({
    store,
    tokens: TOKENS,
    options: { staleAfterMs: 600_000 },
  });
  const get = (q: string, token = TOKENS.admin) =>
    api.request(`/v1/usage${q}`, { headers: { authorization: `Bearer ${token}` } });
  return { store, api, get };
}

describe("model usage on control (goal 075)", () => {
  test("a run's usage: its records only, by agent and by model; a figure none reports is null", async () => {
    const s = await stack();
    const r = modelUsage(s.store, { run: "r-1" });
    assert.deepEqual(r.scope, { kind: "run", run: "r-1" });
    assert.equal(r.total.records, 3);
    assert.equal(r.total.calls, 3);
    assert.equal(r.total.tokens_in, 2500);
    assert.equal(r.total.cached_in, 600);
    assert.equal(r.total.cached_share, 0.3);
    assert.equal(r.total.tokens_out, 250);
    assert.equal(r.total.reasoning, null);
    assert.equal(r.total.call_ms, 5000);
    assert.deepEqual(r.total.out_per_s, { median: 62.5, p10: 32.5, p90: 92.5 });
    assert.deepEqual(r.total.not_reported, { cached: 1, reasoning: 3, time: 1, first_token: 3 });
    assert.deepEqual(
      r.by_agent.map((a) => [a.agent, a.name, a.records]),
      [
        ["workers", "Workers", 2],
        ["planner", "Planner", 1],
      ],
    );
    assert.deepEqual(
      r.by_model.map((m) => [m.harness, m.provider, m.model]),
      [
        ["pi", "lab", "wide-model"],
        ["pi", "lab", "small-model"],
      ],
    );
    assert.equal(r.by_run, undefined);
    // Today, and the last 7 days.
    assert.equal(modelUsage(s.store, { run: "r-1", period: "7d" }).total.records, 3);
    const week = modelUsage(s.store, { run: "r-1", period: "today" });
    assert.ok(week.since?.endsWith("T00:00:00.000Z"));
    assert.ok(week.total.records <= 2);
  });

  test("a campaign's usage sums all its runs on every rig, with each run's share; the system's, each campaign's", async () => {
    const s = await stack();
    const c = modelUsage(s.store, { campaign: "matmul" });
    assert.equal(c.total.records, 4);
    assert.equal(c.total.calls, 3);
    assert.equal(c.total.calls_not_reported, 1, "a Codex turn says no count of calls");
    assert.deepEqual(
      c.by_run?.map((x) => [x.rig, x.run, x.share]),
      [
        ["rig-b", "r-2", 0.7264],
        ["rig-a", "r-1", 0.2736],
      ],
    );
    const all = modelUsage(s.store, {});
    assert.equal(all.total.records, 5);
    assert.deepEqual(
      all.by_campaign?.map((x) => x.campaign),
      ["matmul", "gemv"],
    );
    // The last 7 days leave out the audit nine days ago.
    assert.equal(modelUsage(s.store, { period: "7d" }).total.records, 4);
    assert.equal(modelUsage(s.store, { campaign: "nope" }).total.records, 0);
  });

  test("a rig's records stay when it leaves its ledger: the calls were made", async () => {
    const s = await stack();
    await ingest(s.store, "rig-a", "ledger-a2", [
      ["run_created", "r-9", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
      ["model_call", "r-9", call({ at: ago(1), tokensIn: 10, tokensOut: 1 })],
    ]);
    assert.equal(modelUsage(s.store, { campaign: "matmul" }).total.records, 5);
    // A run is named alone (goal 170): its records wherever it ran.
    assert.equal(modelUsage(s.store, { run: "r-1" }).total.records, 3);
  });

  test("the pages built from every event leave the calls out; the rig's event list keeps them", async () => {
    const s = await stack();
    const v = rigView(s.store, "rig-a", { staleAfterMs: 600_000 });
    assert.ok(v);
    assert.ok(v.recent.every((e) => e.kind !== "model_call"));
    assert.ok(v.runs.every((r) => r.timeline.every((e) => e.kind !== "model_call")));
    const held = await heldEvents(s.store, "rig-a");
    assert.equal(held.filter((e) => e.kind === "model_call").length, 4);
  });

  test("REST: the owner's or the reader's token; a query that does not read is refused in words", async () => {
    const s = await stack();
    const r = await s.get("?campaign=matmul&period=all", TOKENS.read);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { total: { records: number }; by_run: unknown[] };
    assert.equal(body.total.records, 4);
    assert.equal(body.by_run.length, 2);
    // An empty field is no field.
    assert.equal((await s.get("?run=&campaign=gemv")).status, 200);
    const refused = async (q: string, words: RegExp) => {
      const x = await s.get(q);
      assert.equal(x.status, 400, q);
      assert.match(String(((await x.json()) as { error: string }).error), words, q);
    };
    await refused("?run=r-1&campaign=matmul", /^Give a run or a campaign, not both\.$/);
    await refused("?period=month", /^The period is today, 7d or all\.$/);
    // A run is named alone (goal 170): a rig is no part of its query.
    await refused("?run=r-1&rig=rig-a", /^It takes run, campaign, period and tz, not rig\.$/);
    await refused("?model=x", /^It takes run, campaign, period and tz, not model\.$/);
    await refused("?tz=Nowhere%2FTown", /^The time zone is a name such as Europe\/Paris/);
    await refused(`?run=${"x".repeat(101)}`, /^A run is 1 to 100 characters\.$/);
    assert.equal((await s.api.request("/v1/usage")).status, 401);
  });

  test("MCP: model_usage gives the same report", async () => {
    const s = await stack();
    const client = await mcpClient(s.api, TOKENS.operator);
    const out = (await client.callTool({
      name: "model_usage",
      arguments: { run: "r-1", period: "7d" },
    })) as { content: { text: string }[]; isError?: boolean };
    const { since, ...report } = JSON.parse(out.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    const { since: _, ...expected } = JSON.parse(
      JSON.stringify(modelUsage(s.store, { run: "r-1", period: "7d" })),
    ) as Record<string, unknown>;
    assert.deepEqual(report, expected);
    assert.ok(Date.parse(String(since)) < NOW - 6 * 86_400_000);
    const bad = (await client.callTool({
      name: "model_usage",
      arguments: { run: "r-1", campaign: "matmul" },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]?.text ?? "", /Give a run or a campaign, not both/);
    await client.close();
  });
});

describe("model usage cost on control (goal 075)", () => {
  /** lab lists wide-model's price and not small-model's; sub is a Claude subscription. */
  async function priced() {
    const s = await stack();
    for (const [name, type] of [
      ["lab", "openai"],
      ["sub", "claude"],
    ] as const)
      s.store.modelProviders.put({
        name,
        type,
        base_url: "https://models.example.com/v1",
        key: { sealed: "sealed-for-tests", hint: "…ests" },
      });
    s.store.modelProviders.setModels("lab", [
      { id: "wide-model", price: { input: 3, cached_input: 0.3, output: 15 } },
      { id: "small-model" },
    ]);
    s.store.modelProviders.setModels("sub", [{ id: "opus-5.5" }]);
    const post = (body: unknown, token = TOKENS.admin) =>
      s.api.request("/v1/model-prices", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { ...s, post };
  }

  test("each call at its model's price: the provider's list's, else the owner's; a subscription's on its plan; else no price", async () => {
    const s = await priced();
    const r1 = modelUsage(s.store, { run: "r-1" });
    // wide-model: 400 in, 600 cached, 100 out; then 1000 in and 100 out. small-model: no price.
    assert.deepEqual(r1.total.cost, {
      usd: 0.00738,
      input_usd: 0.0042,
      cached_input_usd: 0.00018,
      output_usd: 0.003,
      pod_usd: null,
      priced: 2,
      on_plan: 0,
      no_price: 1,
      free: 0,
      on_plan_tokens: 0,
      no_price_tokens: 550,
      free_tokens: 0,
      priced_as_not_cached: 0,
    });
    // The owner prices small-model: every one of its calls, the earlier ones too.
    const set = await s.post({ provider: "lab", model: "small-model", input: 1, output: 2 });
    assert.equal(set.status, 200, await set.clone().text());
    assert.match(
      String(((await set.json()) as { said: string }).said),
      /^small-model of lab costs 1 USD per million tokens in and 2 USD out\./,
    );
    const again = modelUsage(s.store, { run: "r-1" }).total.cost;
    assert.equal(again.usd, 0.00798);
    assert.equal(again.no_price, 0);
    // Claude Code's calls are on a subscription's plan: no price, counted apart.
    const gemv = modelUsage(s.store, { campaign: "gemv" }).total.cost;
    assert.deepEqual([gemv.usd, gemv.on_plan, gemv.no_price], [null, 1, 0]);
    const prices = (await (
      await s.api.request("/v1/model-prices", {
        headers: { authorization: `Bearer ${TOKENS.read}` },
      })
    ).json()) as { prices: { model: string; source: string }[] };
    assert.deepEqual(
      prices.prices.map((p) => [p.model, p.source]),
      [
        ["wide-model", "list"],
        ["small-model", "owner"],
      ],
    );
    // Refused in words.
    const refused = async (body: unknown, status: number, words: RegExp) => {
      const r = await s.post(body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.match(String(((await r.json()) as { error: string }).error), words);
    };
    await refused(
      { provider: "lab", model: "wide-model", input: 1, output: 1 },
      409,
      /^lab's model list gives wide-model its price, and model usage uses that one\.$/,
    );
    await refused(
      { provider: "sub", model: "opus-5.5", input: 1, output: 1 },
      409,
      /^sub is a subscription: its calls are on its plan/,
    );
    await refused({ provider: "nope", model: "m", input: 1, output: 1 }, 404, /no provider nope/);
    await refused(
      { provider: "lab", model: "other", input: 1, output: 1 },
      404,
      /^lab has no model other: add it/,
    );
    await refused(
      { provider: "lab", model: "small-model", input: 1 },
      400,
      /^Give input and output/,
    );
    await refused(
      { provider: "lab", model: "small-model", input: -1, output: 1 },
      400,
      /^input: a number of US dollars per million tokens/,
    );
    // Only the owner's token sets a price over REST.
    assert.equal(
      (await s.post({ provider: "lab", model: "small-model", clear: true }, TOKENS.read)).status,
      401,
    );
    const cleared = await s.post({ provider: "lab", model: "small-model", clear: true });
    assert.equal(cleared.status, 200);
    assert.equal(modelUsage(s.store, { run: "r-1" }).total.cost.no_price, 1);
  });

  test("a pod's spend goes to the run its rig was running when control counted it; idle spend to the system only", async () => {
    const s = await priced();
    s.store.runpod.addRig({
      rig: "rig-a",
      cloud: "rp",
      pod: "p-1",
      state: { spent_usd: 0 },
      by: "t",
    });
    // r-1 is the run at work on rig-a.
    saveRunpodRig(s.store, "rig-a", { spent_usd: 0.5 }, true);
    // Paused (the stack gave rig-a five events): the pod's spend belongs to no run.
    await ingest(s.store, "rig-a", "ledger-a", [["run_status", "r-1", { status: "paused" }]], 6);
    saveRunpodRig(s.store, "rig-a", { spent_usd: 0.8 }, true);
    // Two runs running: the spend is split between them.
    await ingest(
      s.store,
      "rig-a",
      "ledger-a",
      [
        ["run_status", "r-1", { status: "running" }],
        ["run_created", "r-4", { campaign: "matmul", mode: "hill_climb", version: 1 }],
      ],
      7,
    );
    saveRunpodRig(s.store, "rig-a", { spent_usd: 1.0 }, true);
    // A save that adds nothing counts nothing.
    saveRunpodRig(s.store, "rig-a", { spent_usd: 1.0 }, true);
    assert.equal(modelUsage(s.store, { run: "r-1" }).total.cost.pod_usd, 0.6);
    const c = modelUsage(s.store, { campaign: "matmul" });
    assert.equal(c.total.cost.pod_usd, 0.7);
    assert.deepEqual(
      c.by_run?.map((x) => [x.run, x.cost.pod_usd]),
      [
        ["r-2", null],
        ["r-1", 0.6],
        ["r-4", 0.1],
      ],
    );
    assert.equal(modelUsage(s.store, {}).total.cost.pod_usd, 1);
  });

  test("MCP: an operator sets a price with set_model_price; providers lists the prices in use", async () => {
    const s = await priced();
    const client = await mcpClient(s.api, TOKENS.operator);
    const out = (await client.callTool({
      name: "set_model_price",
      arguments: { provider: "lab", model: "small-model", input: 1, cached_input: 0.1, output: 2 },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(out.isError, undefined, out.content[0]?.text);
    assert.deepEqual(JSON.parse(out.content[0]?.text ?? "{}").price, {
      input: 1,
      cached_input: 0.1,
      output: 2,
    });
    const providers = (await client.callTool({ name: "providers", arguments: {} })) as {
      content: { text: string }[];
    };
    assert.deepEqual(
      (
        JSON.parse(providers.content[0]?.text ?? "{}") as {
          model_prices: { model: string; source: string }[];
        }
      ).model_prices.map((p) => [p.model, p.source]),
      [
        ["wide-model", "list"],
        ["small-model", "owner"],
      ],
    );
    const refused = (await client.callTool({
      name: "set_model_price",
      arguments: { provider: "sub", model: "opus-5.5", input: 1, output: 1 },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? "", /is a subscription/);
    await client.close();
  });
});

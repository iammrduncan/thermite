import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CallUsage,
  callUsage,
  costOf,
  knownTimeZone,
  type PodSpendRow,
  quantile,
  startOfDay,
  sumUsage,
  type UsageRow,
  usageReport,
  usageSince,
} from "../../src/core/usage.ts";

const row = (o: Partial<UsageRow> = {}): UsageRow => ({
  rig: "rig-1",
  run: "run-1",
  campaign: "matmul",
  agent: "workers",
  harness: "pi",
  provider: "p",
  model: "m-1",
  calls: 1,
  at: "2026-10-21T10:00:00.000Z",
  tokens_in: 1000,
  cached_in: null,
  tokens_out: 100,
  reasoning: null,
  first_token_ms: null,
  call_ms: null,
  ...o,
});

describe("model usage records", () => {
  test("a measure becomes a record: whole numbers, cached input within the input, the rest not cached", () => {
    const u = callUsage({
      at: Date.parse("2026-10-21T10:00:00Z"),
      calls: 1,
      tokensIn: 1200.4,
      cachedIn: 1500,
      tokensOut: 50,
      reasoning: 80,
      firstTokenMs: -5,
      callMs: 2000,
    });
    assert.deepEqual(u, {
      calls: 1,
      at: "2026-10-21T10:00:00.000Z",
      tokens_in: 1200,
      cached_in: 1200,
      uncached_in: 0,
      tokens_out: 50,
      reasoning: 50,
      first_token_ms: 0,
      call_ms: 2000,
    });
    assert.ok(CallUsage.safeParse(u).success);
  });

  test("a figure the harness does not report stays null, never 0", () => {
    const u = callUsage({ at: 0, tokensIn: 300, tokensOut: 20 });
    assert.equal(u.calls, null);
    assert.equal(u.cached_in, null);
    assert.equal(u.uncached_in, null);
    assert.equal(u.reasoning, null);
    assert.equal(u.first_token_ms, null);
    assert.equal(u.call_ms, null);
    // A time beyond a week is not a call's time.
    assert.equal(
      callUsage({ at: 0, tokensIn: 1, tokensOut: 1, callMs: 8 * 86_400_000 }).call_ms,
      null,
    );
  });

  test("a record whose cache figures do not add up, or whose reasoning passes its output, is refused", () => {
    const good = callUsage({ at: 0, tokensIn: 100, cachedIn: 40, tokensOut: 10 });
    assert.ok(CallUsage.safeParse(good).success);
    assert.equal(CallUsage.safeParse({ ...good, uncached_in: 59 }).success, false);
    assert.equal(CallUsage.safeParse({ ...good, cached_in: null }).success, false);
    assert.equal(CallUsage.safeParse({ ...good, reasoning: 11 }).success, false);
    assert.equal(CallUsage.safeParse({ ...good, tokens_in: -1 }).success, false);
  });
});

describe("model usage sums", () => {
  test("quantiles interpolate between ranks, as R's type 7 does", () => {
    const xs = [1, 2, 3, 4];
    assert.equal(quantile(xs, 0.5), 2.5);
    assert.ok(Math.abs((quantile(xs, 0.1) as number) - 1.3) < 1e-9);
    assert.ok(Math.abs((quantile(xs, 0.9) as number) - 3.7) < 1e-9);
    assert.equal(quantile([7], 0.9), 7);
    assert.equal(quantile([], 0.5), undefined);
  });

  test("sums count each figure over the records that report it, and say how many do not", () => {
    const rows = [
      row({ cached_in: 600, reasoning: 30, call_ms: 1000, first_token_ms: 200, tokens_out: 100 }),
      row({ cached_in: 0, call_ms: 2000, first_token_ms: 400, tokens_out: 100 }),
      row({ call_ms: 4000, tokens_out: 100 }),
      // A Codex turn: no count of calls, no time.
      row({ calls: null, harness: "codex", tokens_in: 5000, tokens_out: 0 }),
      // A call that failed: a time, no output; left out of the speed.
      row({ call_ms: 500, tokens_in: 0, tokens_out: 0 }),
    ];
    const s = sumUsage(rows);
    assert.equal(s.records, 5);
    assert.equal(s.calls, 4);
    assert.equal(s.calls_not_reported, 1);
    assert.equal(s.tokens_in, 8000);
    assert.equal(s.tokens_out, 300);
    assert.equal(s.cached_in, 600);
    assert.equal(s.uncached_in, 1400);
    assert.equal(s.cached_share, 0.3);
    assert.equal(s.reasoning, 30);
    assert.equal(s.call_ms, 7500);
    // Speeds 100, 50 and 25 tokens a second.
    assert.deepEqual(s.out_per_s, { median: 50, p10: 30, p90: 90 });
    assert.equal(s.first_token_ms, 300);
    assert.deepEqual(s.not_reported, { cached: 3, reasoning: 4, time: 1, first_token: 3 });
  });

  test("with no record reporting a figure, its sum is null, never 0", () => {
    const s = sumUsage([row(), row({ calls: null })]);
    assert.equal(s.cached_in, null);
    assert.equal(s.uncached_in, null);
    assert.equal(s.cached_share, null);
    assert.equal(s.reasoning, null);
    assert.equal(s.out_per_s, null);
    assert.equal(s.call_ms, null);
    assert.equal(s.first_token_ms, null);
    const none = sumUsage([]);
    assert.equal(none.records, 0);
    assert.equal(none.tokens_in, 0);
    assert.equal(none.cached_in, null);
  });

  test("periods: today from midnight UTC, the last 7 days, or all", () => {
    const now = new Date("2026-10-21T15:30:00Z");
    assert.equal(usageSince("today", now), "2026-10-21T00:00:00.000Z");
    assert.equal(usageSince("7d", now), "2026-10-14T15:30:00.000Z");
    assert.equal(usageSince("all", now), null);
  });

  test("today in a time zone: from its midnight, also on a day its clocks change", () => {
    const at = (iso: string) => new Date(iso);
    // 03:00 UTC is still the evening before in Chicago (UTC-5 in October).
    assert.equal(
      usageSince("today", at("2026-10-21T03:00:00Z"), "America/Chicago"),
      "2026-10-20T05:00:00.000Z",
    );
    // Half an hour off the hour, ahead of UTC.
    assert.equal(
      usageSince("today", at("2026-10-21T15:30:00Z"), "Asia/Kolkata"),
      "2026-10-20T18:30:00.000Z",
    );
    // Paris: the day summer time starts began at midnight in winter time (UTC+1)...
    assert.equal(
      usageSince("today", at("2026-03-29T12:00:00Z"), "Europe/Paris"),
      "2026-03-28T23:00:00.000Z",
    );
    // ...and the day it ends, at midnight in summer time (UTC+2).
    assert.equal(
      new Date(startOfDay(Date.parse("2026-10-25T20:00:00Z"), "Europe/Paris")).toISOString(),
      "2026-10-24T22:00:00.000Z",
    );
    // The last 7 days do not depend on the zone.
    assert.equal(
      usageSince("7d", at("2026-10-21T15:30:00Z"), "Asia/Kolkata"),
      "2026-10-14T15:30:00.000Z",
    );
    assert.equal(knownTimeZone("Europe/Paris"), true);
    assert.equal(knownTimeZone("UTC"), true);
    assert.equal(knownTimeZone("Nowhere/Town"), false);
  });

  test("by agent and model: each agent's calls to each model, in the agents' order, then most tokens first", () => {
    const r = usageReport(
      [
        row({ agent: "merged_by", model: "m-3" }),
        row({ agent: "teachers", model: "m-2", tokens_in: 10 }),
        row({ agent: "teachers", model: "m-1", tokens_in: 5000 }),
        row({ agent: "workers", harness: "codex", model: "m-1" }),
        row({ agent: "workers", model: "m-1", tokens_in: 9000 }),
      ],
      { kind: "run", run: "run-1" },
      "all",
      null,
    );
    assert.deepEqual(
      r.by_agent_model.map((l) => [l.agent, l.name, l.harness, l.model, l.records]),
      [
        ["workers", "Workers", "pi", "m-1", 1],
        ["workers", "Workers", "codex", "m-1", 1],
        ["teachers", "Teachers", "pi", "m-1", 1],
        ["teachers", "Teachers", "pi", "m-2", 1],
        ["merged_by", "Teachers (merged by)", "pi", "m-3", 1],
      ],
    );
    assert.equal(r.tz, "UTC");
  });

  test("a report: by agent in the agents' order, by model most tokens first, a campaign's runs with their shares", () => {
    const rows = [
      row({ agent: "review_panel", tokens_in: 100, tokens_out: 0 }),
      row({ agent: "workers", run: "run-2", rig: "rig-2", tokens_in: 2900, tokens_out: 100 }),
      row({ agent: "planner", model: "m-2", tokens_in: 900, tokens_out: 0 }),
    ];
    const r = usageReport(rows, { kind: "campaign", campaign: "matmul" }, "all", null);
    assert.deepEqual(
      r.by_agent.map((a) => [a.agent, a.name]),
      [
        ["workers", "Workers"],
        ["planner", "Planner"],
        ["review_panel", "Review panel"],
      ],
    );
    assert.deepEqual(
      r.by_model.map((m) => [m.model, m.tokens_in + m.tokens_out]),
      [
        ["m-1", 3100],
        ["m-2", 900],
      ],
    );
    assert.deepEqual(
      r.by_run?.map((x) => [x.rig, x.run, x.share]),
      [
        ["rig-2", "run-2", 0.75],
        ["rig-1", "run-1", 0.25],
      ],
    );
    assert.equal(r.by_campaign, undefined);
    const all = usageReport(rows, { kind: "system" }, "today", "2026-10-21T00:00:00.000Z");
    assert.deepEqual(
      all.by_campaign?.map((c) => [c.campaign, c.share]),
      [["matmul", 1]],
    );
    assert.equal(all.by_run, undefined);
    assert.equal(all.since, "2026-10-21T00:00:00.000Z");
  });
});

describe("model usage cost", () => {
  const price = { input: 3, cached_input: 0.3, output: 15 };
  const priced = (o: Partial<UsageRow> = {}): UsageRow =>
    row({ pricing: { kind: "priced", price, source: "list" }, ...o });

  test("a record's tokens at its price, by part; cached input at the input price when it has none", () => {
    assert.deepEqual(
      costOf({ tokens_in: 1_000_000, cached_in: 600_000, tokens_out: 100_000 }, price),
      { input: 1.2, cached_input: 0.18, output: 1.5 },
    );
    const c = costOf(
      { tokens_in: 1_000_000, cached_in: 600_000, tokens_out: 0 },
      { ...price, cached_input: null },
    );
    assert.equal(c.cached_input, 1.8);
    // Cache not reported: every input token at the input price.
    assert.equal(costOf({ tokens_in: 1_000_000, cached_in: null, tokens_out: 0 }, price).input, 3);
  });

  test("the sums cost the priced records, count those on a plan or with no price, and add the pods' spend", () => {
    const pods: PodSpendRow[] = [
      { rig: "rig-1", run: "run-1", campaign: "matmul", at: "2026-10-21T10:00:00Z", usd: 0.25 },
    ];
    const s = sumUsage(
      [
        priced({ tokens_in: 1_000_000, cached_in: 600_000, tokens_out: 100_000 }),
        row({ pricing: { kind: "plan" } }),
        row({ pricing: { kind: "none" } }),
        row(),
      ],
      pods,
    );
    assert.deepEqual(s.cost, {
      usd: 3.13,
      input_usd: 1.2,
      cached_input_usd: 0.18,
      output_usd: 1.5,
      pod_usd: 0.25,
      priced: 1,
      on_plan: 1,
      no_price: 2,
      free: 0,
      on_plan_tokens: 1100,
      no_price_tokens: 2200,
      free_tokens: 0,
      priced_as_not_cached: 0,
    });
    // Nothing priced and no pod: no cost, never 0.
    const none = sumUsage([row({ pricing: { kind: "plan" } }), row()]);
    assert.equal(none.cost.usd, null);
    assert.equal(none.cost.pod_usd, null);
    assert.equal(none.cost.on_plan, 1);
    assert.equal(none.cost.no_price, 1);
    // A pod alone is a cost.
    assert.equal(sumUsage([], pods).cost.usd, 0.25);
  });

  test("a free model is priced at 0 and counted apart; tokens in priced as not cached are counted where it matters", () => {
    const free = {
      kind: "priced" as const,
      price: { input: 0, cached_input: null, output: 0 },
      source: "list" as const,
    };
    const s = sumUsage([
      row({ pricing: free, tokens_in: 500, tokens_out: 50 }),
      // No cache figure, and a cached price below the input price: priced as not cached.
      priced({ tokens_in: 1_000_000, cached_in: null, tokens_out: 0 }),
      // No cached price: the cache does not change the cost, so nothing to say.
      row({
        pricing: {
          kind: "priced",
          price: { input: 1, cached_input: null, output: 1 },
          source: "owner",
        },
        tokens_in: 7,
        cached_in: null,
      }),
      row({ pricing: { kind: "plan" }, tokens_in: 40, tokens_out: 2 }),
    ]);
    assert.equal(s.cost.free, 1);
    assert.equal(s.cost.free_tokens, 550);
    assert.equal(s.cost.priced, 3);
    assert.equal(s.cost.priced_as_not_cached, 1_000_000);
    assert.equal(s.cost.on_plan_tokens, 42);
    assert.equal(s.cost.no_price_tokens, 0);
    // A free model alone costs $0, and says it is free: never "no price".
    const alone = sumUsage([row({ pricing: free })]);
    assert.deepEqual([alone.cost.usd, alone.cost.free, alone.cost.no_price], [0, 1, 0]);
  });

  test("a pod's spend goes to its run and campaign, not to an agent or a model; idle spend only to the total", () => {
    const pods: PodSpendRow[] = [
      { rig: "rig-1", run: "run-1", campaign: "matmul", at: "2026-10-21T10:00:00Z", usd: 1 },
      { rig: "rig-2", run: "run-2", campaign: "matmul", at: "2026-10-21T10:00:00Z", usd: 2 },
      { rig: "rig-2", run: null, campaign: null, at: "2026-10-21T10:00:00Z", usd: 4 },
    ];
    const c = usageReport(
      [priced({ tokens_in: 1_000_000, cached_in: 0, tokens_out: 0 })],
      { kind: "campaign", campaign: "matmul" },
      "all",
      null,
      pods.slice(0, 2),
    );
    assert.equal(c.total.cost.usd, 6);
    assert.deepEqual(
      c.by_run?.map((r) => [r.run, r.records, r.cost.usd, r.cost.pod_usd]),
      [
        ["run-1", 1, 4, 1],
        ["run-2", 0, 2, 2],
      ],
    );
    assert.equal(c.by_agent[0]?.cost.pod_usd, null);
    assert.equal(c.by_model[0]?.cost.usd, 3);
    const all = usageReport([], { kind: "system" }, "all", null, pods);
    assert.equal(all.total.cost.pod_usd, 7);
    assert.deepEqual(
      all.by_campaign?.map((x) => [x.campaign, x.cost.pod_usd]),
      [["matmul", 3]],
    );
  });
});

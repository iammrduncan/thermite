import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { saveRunpodRig } from "../../../src/control/runpod/index.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { PRICE_CORE_JS } from "../../../src/control/ui/providers/client.ts";
import { bars, dayEdges, PRICE_WORDS } from "../../../src/control/ui/usage.ts";
import { callUsage, startOfDay } from "../../../src/core/usage.ts";
import { ADMIN, controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Model use and cost on the screens (goal 075, as the owner approved the mockup v010-usage): the
 * top of a run's page on every tab (one line and two cards) with the details on its Stats tab, a
 * campaign page's sidebar, the Metrics page with today from midnight in the viewer's time zone,
 * and one table of model prices in Settings › Providers. Every figure a harness does not report
 * says "not reported"; a cost says "on a plan", "no price" or "free", never $0.
 */

const TOKENS = { admin: ADMIN, rigs: {} };
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A model_call event's body. */
const call = (o: {
  agent: string;
  harness?: string;
  provider?: string | null;
  model: string;
  at?: string;
  tokensIn: number;
  cachedIn?: number | null;
  tokensOut: number;
  callMs?: number | null;
  calls?: number | null;
  trial?: string | null;
  firstTokenMs?: number | null;
}) => ({
  trial: o.trial ?? null,
  round: null,
  agent: o.agent,
  harness: o.harness ?? "pi",
  provider: o.provider === undefined ? "lab" : o.provider,
  model: o.model,
  ...callUsage({
    at: o.at ?? ago(1),
    calls: o.calls === undefined ? 1 : o.calls,
    tokensIn: o.tokensIn,
    cachedIn: o.cachedIn ?? null,
    tokensOut: o.tokensOut,
    callMs: o.callMs ?? null,
    firstTokenMs: o.firstTokenMs ?? null,
  }),
});

async function ingest(
  store: ControlStore,
  rig: string,
  events: [string, string, Record<string, unknown>][],
  first = 1,
) {
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: first - 1,
    next: first - 1 + events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: first + i,
      at: typeof body.at === "string" ? body.at : new Date(NOW).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

/**
 * rig-a runs r-1 of matmul (three rounds): workers on lab's wide-model (listed price) in two
 * trials, the planner on lab's small-model (no price), two teachers (wide-model, and opus-5.5 on
 * the Claude subscription sub, in Claude Code), their merged by model on zen's free model, and
 * the auditor in OpenCode, which does not report the cache. rig-b ran r-2 of gemv long ago.
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const { store, control: api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, secrets },
  });
  for (const [name, type] of [
    ["lab", "openai"],
    ["zen", "opencode"],
    ["sub", "claude"],
  ] as const)
    store.modelProviders.put({
      name,
      type,
      base_url: type === "openai" ? "https://models.example.com/v1" : "",
      key: { sealed: secrets.seal("key-for-tests"), hint: "…ests" },
    });
  store.modelProviders.setModels("lab", [
    {
      id: "wide-model",
      context_window: 131_072,
      price: { input: 3, cached_input: 0.3, output: 15 },
    },
    { id: "small-model" },
  ]);
  store.modelProviders.setModels("zen", [
    { id: "free-model", price: { input: 0, cached_input: null, output: 0 } },
  ]);
  store.modelProviders.setModels("sub", [{ id: "opus-5.5" }]);
  store.agentModels.assignRole("rig-a", "teachers", { provider: "lab", model: "wide-model" });
  store.agentModels.assignRole("rig-a", "second_teacher", { provider: "sub", model: "opus-5.5" });
  await ingest(store, "rig-a", [
    [
      "run_created",
      "r-1",
      { campaign: "matmul", mode: "hill_climb", version: 1, agents: true, at: ago(6) },
    ],
    ["epoch_started", "r-1", { n: 1, at: ago(5) }],
    ["epoch_started", "r-1", { n: 2, at: ago(3) }],
    ["epoch_started", "r-1", { n: 3, at: ago(1.5) }],
    [
      "model_call",
      "r-1",
      call({
        agent: "workers",
        model: "wide-model",
        trial: "t-1",
        at: ago(4),
        tokensIn: 1_000_000,
        cachedIn: 600_000,
        tokensOut: 20_000,
        callMs: 400_000,
        firstTokenMs: 1500,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "workers",
        model: "wide-model",
        trial: "t-2",
        at: ago(1),
        tokensIn: 1_000_000,
        cachedIn: 0,
        tokensOut: 20_000,
        callMs: 200_000,
        calls: 3,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "planner",
        model: "small-model",
        at: ago(4.5),
        tokensIn: 5000,
        cachedIn: 0,
        tokensOut: 500,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "teachers",
        model: "wide-model",
        at: ago(2),
        tokensIn: 4000,
        cachedIn: 0,
        tokensOut: 400,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "teachers",
        harness: "claude-code",
        provider: "sub",
        model: "opus-5.5",
        at: ago(2),
        tokensIn: 9000,
        cachedIn: 8000,
        tokensOut: 900,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "merged_by",
        harness: "opencode",
        provider: "zen",
        model: "free-model",
        at: ago(2),
        tokensIn: 3000,
        tokensOut: 300,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "auditor",
        harness: "opencode",
        model: "wide-model",
        at: ago(2),
        tokensIn: 7000,
        tokensOut: 70,
      }),
    ],
  ]);
  await ingest(store, "rig-b", [
    ["run_created", "r-2", { campaign: "gemv", mode: "goal", version: 1, agents: true }],
    ["run_status", "r-2", { status: "closed" }],
    [
      "model_call",
      "r-2",
      call({
        agent: "workers",
        model: "small-model",
        at: ago(24 * 30),
        tokensIn: 100,
        tokensOut: 5,
      }),
    ],
  ]);
  const session = await signIn(api);
  const { page } = session;
  const csrf = session.csrfOf(await page("/ui/settings"));
  const post = async (path: string, form: Record<string, string>) => {
    const r = await session.post(path, { csrf, ...form });
    return { status: r.status, to: decodeURIComponent(r.headers.get("location") ?? "") };
  };
  return { store, api, page, post };
}

/** The part of a page from a marker to the end of its block (the next `</table>` and beyond). */
const from = (html: string, marker: string, until: string) => {
  const i = html.indexOf(marker);
  assert.ok(i >= 0, `the page has ${marker}`);
  const j = html.indexOf(until, i);
  return html.slice(i, j < 0 ? undefined : j);
};
/** A table row that holds some text, alone. */
const rowWith = (html: string, text: string) => {
  const i = html.indexOf(text);
  assert.ok(i >= 0, `the page has ${text}`);
  return html.slice(html.lastIndexOf("<tr", i), html.indexOf("</tr>", i));
};
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("model use on the screens (goal 075)", () => {
  test("a run's page: one line and two cards above the tabs, on every tab; its Stats tab has the calls and the table by agent and model", async () => {
    const s = await stack();
    const html = await s.page("/ui/campaigns/matmul/runs/r-1");
    const block = from(html, '<div class="block" id="model-use">', '<nav class="tabs">');
    assert.ok(
      html.indexOf('id="model-use"') < html.indexOf('<nav class="tabs">'),
      "above the tabs",
    );
    // One line: trials, rounds, the run's time (it started 6 hours ago) and the time in calls
    // (two of its seven records report theirs: 400 s and 200 s). Its i says what each part is, and
    // how many records leave their time out.
    const line = from(block, '<div class="u-clock">', '<div class="u-two');
    assert.match(line, /<span>0 trials · 3 rounds · 6 h 0 m · 10 m in calls<\/span>/);
    assert.match(
      unesc(line),
      /data-tip="Trials done, rounds, the run's time since it started .* 5 records do not report their time: not in the time in calls\."/,
    );
    // A hill climb's three cards: its champion (goal 142), Cost, and the tokens in and out
    // together with the speed. Each label has its info icon.
    for (const label of ["Champion #1", "Cost", "Tokens", "Output speed"])
      assert.match(
        block,
        new RegExp(`<span class="lb">${label}<i class="ii" tabindex="0" data-tip="`),
      );
    assert.equal(block.match(/<div class="fact /g)?.length, 3);
    assert.ok(block.indexOf("uf-champ") < block.indexOf("uf-cost"), "the champion is left of Cost");
    for (const gone of ["Calls", "Time in calls", "By agent and model", "<table"])
      assert.ok(!block.includes(gone), `${gone} is not at the top`);
    assert.match(unesc(block), /Each model's own speed is on the Stats tab\./);
    // The Stats tab, last, after Planner.
    assert.match(
      html,
      /Planner<\/a><a class="" href="\/ui\/campaigns\/matmul\/runs\/r-1\/prompts">Prompts<\/a><a class="" href="\/ui\/campaigns\/matmul\/runs\/r-1\/stats">Stats<\/a><\/nav>/,
    );
    const stats = await s.page("/ui/campaigns/matmul/runs/r-1/stats");
    assert.match(stats, /<a class="on" href="[^"]*\/stats">Stats<\/a>/);
    assert.match(stats, /id="model-use"/, "the top is there too");
    const tab = from(stats, '<div id="run-stats">', "</table>");
    // Nine calls; the workers made 4 in 2 trials; the first token's median.
    assert.match(tab, /<span class="lb">Calls<i class="ii" tabindex="0" data-tip="/);
    assert.match(
      tab,
      /<div class="v">9<\/div><div class="s">2 a trial · first token 1\.5 s<\/div>/,
    );
    // The calls in each of the three rounds: 2 (the planner, a worker), 4 (the advisors), 3.
    assert.match(tab, /The bars: calls in each round\./);
    assert.equal(
      (tab.match(/<div class="uspark"[^>]*>(.*?)<\/div>/)?.[1] ?? "").split("<i ").length - 1,
      3,
    );
    assert.match(tab, /<span>round 1<\/span><span>round 3<\/span>/);
    assert.match(tab, /<div class="u-h">By agent and model<\/div>/);
    // The groups and the agents' names (goal 074), with the teachers told apart by the rig's settings.
    const table = from(tab, '<table class="ut">', "</table>");
    for (const word of ["The work", "The advisors", "Workers", "Planner", "Teachers", "Auditor"])
      assert.ok(table.includes(word), word);
    assert.match(
      rowWith(table, "Claude Code · sub"),
      /<b>Teachers<\/b><span class="us">teacher 2<\/span>/,
    );
    assert.match(
      rowWith(table, "OpenCode v2 · zen"),
      /<b>Teachers<\/b><span class="us">merged by<\/span>/,
    );
    assert.ok(table.indexOf("Workers") < table.indexOf("Planner"));
    assert.ok(table.indexOf("Planner") < table.indexOf("The advisors"));
    // Cost words: a listed price in dollars, no price, on a plan, free.
    const workers = rowWith(table, "<b>Workers</b>");
    // 1.4M in not cached at $3, 0.6M cached at $0.30, 40k out at $15: $4.20 + $0.18 + $0.60.
    assert.match(workers, /\$4\.98<\/td>/);
    assert.match(rowWith(table, "<b>Planner</b>"), /<span class="nr">no price<\/span>/);
    assert.match(rowWith(table, "Claude Code · sub"), /<span class="nr">on a plan<\/span>/);
    assert.match(rowWith(table, "OpenCode v2 · zen"), /<span class="nr">free<\/span>/);
    // The auditor's harness does not report the cache: "not reported", never 0, and its cost says
    // how its tokens in were priced.
    const auditor = rowWith(table, "<b>Auditor</b>");
    assert.equal(
      auditor.match(/<span class="nr">not reported<\/span>/g)?.length,
      3,
      "cached, not cached, speed",
    );
    assert.match(
      unesc(auditor),
      /7\.0k tokens in priced as not cached: OpenCode v2 does not report cached tokens\./,
    );
    // The card stays brief: what its dollars leave out is on the Stats tab's table, not under them.
    const cost = from(block, "uf-cost", "uf-tok");
    assert.doesNotMatch(cost, /<div class="s">|tokens on a plan/);
    // Tokens in and out in one: the split of tokens in, cached, not cached, and not reported (with
    // the harness).
    const tokens = from(block, "uf-tok", "Output speed");
    assert.match(tokens, /<span class="u"> in · <\/span>[^<]+<span class="u"> out<\/span>/);
    assert.match(tokens, /not reported by OpenCode v2/);
    // On every tab.
    for (const view of ["history", "attempts", "planner"])
      assert.match(await s.page(`/ui/campaigns/matmul/runs/r-1/${view}`), /id="model-use"/, view);
  });

  test("a RunPod rig's run: its pod's spend is a line of its own, with its time at the pod's price", async () => {
    const s = await stack();
    s.store.runpod.addRig({
      rig: "rig-a",
      cloud: "rp",
      pod: "p-1",
      state: { spent_usd: 0, price_per_hr: 1.65 },
      by: "t",
    });
    saveRunpodRig(s.store, "rig-a", { spent_usd: 1.65, price_per_hr: 1.65 }, true);
    const html = await s.page("/ui/campaigns/matmul/runs/r-1/stats");
    const gpu = rowWith(html, "<b>GPU time on RunPod</b>");
    assert.match(gpu, /1 h 0 m at \$1\.65\/h/);
    assert.match(gpu, /\$1\.65<\/td>/);
    assert.match(html, /<tr class="grp"><td colspan="10">The rig<\/td><\/tr>/);
    assert.match(from(html, "uf-cost", "uf-tok"), /GPU time on RunPod/);
  });

  test("a run with no records yet says so; a try of a kit, with no agents, shows nothing and has no Stats tab", async () => {
    const s = await stack();
    await ingest(
      s.store,
      "rig-a",
      [
        [
          "run_created",
          "r-3",
          { campaign: "matmul", mode: "hill_climb", version: 1, agents: true },
        ],
      ],
      12,
    );
    const fresh = await s.page("/ui/campaigns/matmul/runs/r-3");
    assert.match(
      from(fresh, '<div class="block" id="model-use">', '<nav class="tabs">'),
      /<span>0 trials · 0 rounds · \d+ s · no model call yet<\/span>/,
    );
    assert.doesNotMatch(fresh, /<div class="u-two">/);
    assert.match(
      await s.page("/ui/campaigns/matmul/runs/r-3/stats"),
      /No model call recorded yet\. Code counts each call of the agents when it ends\./,
    );
    await ingest(
      s.store,
      "rig-a",
      [
        [
          "run_created",
          "matmul-try-1",
          { campaign: "matmul", mode: "hill_climb", version: 1, agents: false },
        ],
      ],
      13,
    );
    const tried = await s.page("/ui/campaigns/matmul/runs/matmul-try-1");
    assert.doesNotMatch(tried, /id="model-use"/);
    assert.doesNotMatch(tried, /\/stats"/);
  });

  test("a campaign's page: its model use in the sidebar, over all its runs, each run linked", async () => {
    const s = await stack();
    const html = await s.page("/ui/campaigns/matmul");
    const side = from(
      html,
      '<div class="side"><div class="block" id="camp-use">',
      "By model, on Metrics",
    );
    assert.match(side, /1 run<\/span>/);
    assert.match(
      side,
      /<a href="\/ui\/campaigns\/matmul\/runs\/r-1"><b>r-1<\/b><\/a><span class="us">at work · rig-a<\/span>/,
    );
    for (const label of ["Cost", "Tokens in", "Tokens out", "Calls", "Output speed", "In", "Out"])
      assert.match(side, new RegExp(`<span class="lb">${label}<i class="ii"`), label);
    // The cached part is of the tokens that report the cache, and the i says how many did not.
    assert.match(
      unesc(side),
      /10k of 2\.0M tokens in: not reported by OpenCode v2\. Of the rest, 30% was cached\./,
    );
    // Its cost stays brief: the tokens with no dollars are on Metrics, which keeps them.
    assert.doesNotMatch(from(side, "uside-cost", "umini"), /tokens on a plan/);
    assert.match(html, /<a href="\/ui\/metrics">By model, on Metrics ›<\/a>/);
    // The main column keeps the runs at work and the knowledge.
    assert.ok(html.indexOf("At work now") < html.indexOf('<div class="side">'));
  });

  test("Metrics: in the main navigation; the system by model and by campaign; today from midnight in the viewer's zone", async () => {
    const s = await stack();
    let html = await s.page("/ui/metrics");
    assert.match(
      html,
      /<a href="\/ui\/metrics" class="on"><svg[^>]*>.*?<\/svg><span>Metrics<\/span><\/a>/,
    );
    assert.ok(
      html.indexOf(">Rigs<") < html.indexOf(">Metrics<") &&
        html.indexOf(">Metrics<") < html.indexOf(">Live<"),
    );
    // 7 days by default; rig-b's month-old call is out.
    assert.match(html, /<a class="fchip on" href="\/ui\/metrics\?period=7d">7 days<\/a>/);
    assert.match(html, /every campaign and rig · times in UTC/);
    assert.match(html, /1 run · 1 campaign/);
    assert.match(from(html, "uf-cost", "uf-in"), /tokens on a plan · 5\.5k no price · 3\.3k free/);
    const byModel = from(html, '<div class="u-h">By model</div>', "</table>");
    // One row for each provider's model, with every harness that ran it.
    assert.match(
      byModel,
      /<span class="u-m">wide-model<\/span><span class="us">lab · Pi, OpenCode v2<\/span>/,
    );
    assert.equal(byModel.match(/<span class="u-m">wide-model<\/span>/g)?.length, 1);
    assert.match(
      unesc(rowWith(byModel, "lab · Pi, OpenCode v2")),
      /7\.0k of 2\.0M tokens in: not reported by OpenCode v2\. Of the rest, 30% was cached\./,
    );
    assert.match(
      byModel,
      /<span class="u-m">opus-5\.5<\/span><span class="us">sub · Claude Code<\/span>/,
    );
    const byCamp = from(html, '<div class="u-h">By campaign</div>', "</table>");
    assert.match(byCamp, /href="\/ui\/campaigns\/matmul">.*<b>matmul<\/b>/);
    assert.doesNotMatch(byCamp, /gemv/);
    // All: both campaigns.
    html = await s.page("/ui/metrics?period=all");
    assert.match(from(html, '<div class="u-h">By campaign</div>', "</table>"), /gemv/);
    assert.match(html, /2 runs · 2 campaigns/);
    // Today, from midnight where the viewer is: a call a minute before that midnight is out, one
    // a second ago is in.
    const tz = "America/Chicago";
    const midnight = startOfDay(NOW, tz);
    await ingest(
      s.store,
      "rig-b",
      [
        ["run_created", "r-4", { campaign: "late", mode: "hill_climb", version: 1, agents: true }],
        [
          "model_call",
          "r-4",
          call({
            agent: "workers",
            model: "small-model",
            at: new Date(midnight - 60_000).toISOString(),
            tokensIn: 10,
            tokensOut: 1,
          }),
        ],
        [
          "model_call",
          "r-4",
          call({
            agent: "workers",
            model: "small-model",
            at: new Date(NOW - 1000).toISOString(),
            tokensIn: 10,
            tokensOut: 1,
            calls: 7,
          }),
        ],
      ],
      4,
    );
    const today = await s.page(`/ui/metrics?period=today&tz=${encodeURIComponent(tz)}`);
    assert.match(today, /times in America\/Chicago/);
    assert.match(
      today,
      /<a class="fchip on" href="\/ui\/metrics\?period=today&amp;tz=America%2FChicago">Today<\/a>/,
    );
    // The bars need two hours of today: in the first hour after that midnight there is one.
    const bars = /The bars: calls in each hour of today, from midnight in America\/Chicago\./;
    if (NOW - midnight >= 3_600_000) assert.match(unesc(today), bars);
    else assert.doesNotMatch(unesc(today), bars);
    const usage = (await (
      await s.api.request(`/v1/usage?period=today&tz=${encodeURIComponent(tz)}&campaign=late`, {
        headers: { authorization: `Bearer ${TOKENS.admin}` },
      })
    ).json()) as { since: string; tz: string; total: { calls: number } };
    assert.equal(usage.since, new Date(midnight).toISOString());
    assert.equal(usage.tz, tz);
    assert.equal(usage.total.calls, 7, "the call before that midnight is yesterday's");
    // A zone this runtime does not know: UTC, and the page says so; the API refuses it in words.
    assert.match(await s.page("/ui/metrics?period=today&tz=Nowhere%2FTown"), /times in UTC/);
    const refused = await s.api.request("/v1/usage?period=today&tz=Nowhere%2FTown", {
      headers: { authorization: `Bearer ${TOKENS.admin}` },
    });
    assert.equal(refused.status, 400);
    assert.match(
      String(((await refused.json()) as { error: string }).error),
      /^The time zone is a name such as Europe\/Paris/,
    );
  });

  test("Settings › Providers: one Model prices table under the providers, no subscription in it; Save prices sets and clears a price", async () => {
    const s = await stack();
    let html = await s.page("/ui/settings");
    // Under the providers, before Add a provider; nothing about prices inside a provider.
    assert.ok(html.indexOf("<h2>Providers</h2>") < html.indexOf('id="model-prices"'));
    assert.ok(html.indexOf('id="model-prices"') < html.indexOf("<h2>Add a provider</h2>"));
    assert.doesNotMatch(html, /Prices, \$ for a million tokens|So far:|data-pr-prov/);
    const block = from(html, '<div class="block" id="model-prices">', "</form>");
    assert.match(
      block,
      /<h2>Model prices<\/h2><span class="right">\$ for a million tokens<\/span>/,
    );
    for (const label of ["Model", "Provider", "In", "Cached in", "Out", "Price from"])
      assert.match(block, new RegExp(`<span class="lb">${label}<i class="ii"`), label);
    assert.match(block, /<form method="post" action="\/ui\/settings\/prices" data-mp-form>/);
    // A listed price is text, not a field.
    const wide = rowWith(block, '<span class="u-m">wide-model</span>');
    assert.doesNotMatch(wide, /<input/);
    assert.match(
      wide,
      /<td class="num">3\.00<\/td><td class="num">0\.30<\/td><td class="num">15\.00<\/td><td><span class="chip">provider's list<\/span>/,
    );
    const small = rowWith(block, '<span class="u-m">small-model</span>');
    assert.match(small, /<input type="hidden" name="p0" value="lab">/);
    assert.match(small, /name="in0"[^>]*value=""/);
    assert.match(small, /<span class="chip warn">no price<\/span>/);
    assert.match(
      rowWith(block, '<span class="u-m">free-model</span>'),
      /<td class="num">0\.00<\/td><td class="num"><span class="muted">–<\/span><\/td><td class="num">0\.00<\/td><td><span class="chip">free<\/span>/,
    );
    // A subscription's models are on a plan: not in the table.
    assert.doesNotMatch(block, /opus-5\.5/);
    assert.equal(block.match(/<tr data-mp=/g)?.length, 1, "one row to fill in");
    assert.equal(block.match(/Save prices/g)?.length, 1, "one Save");
    // Save: small-model gets a price; a listed price posted anyway is left as it is.
    const form = {
      p0: "lab",
      m0: "small-model",
      in0: "0.60",
      cached0: "0.1",
      out0: "2.5",
      p1: "lab",
      m1: "wide-model",
      in1: "9",
      cached1: "",
      out1: "9",
    };
    let r = await s.post("/ui/settings/prices", form);
    assert.equal(r.status, 303);
    assert.equal(r.to, "/ui/settings?at=prices&ok=saved#model-prices");
    assert.deepEqual(
      s.store.usage.prices().map((x) => [x.provider, x.model, x.price]),
      [["lab", "small-model", { input: 0.6, cached_input: 0.1, output: 2.5 }]],
    );
    assert.equal(
      s.store.modelProviders.get("lab")?.models.find((m) => m.id === "wide-model")?.price?.input,
      3,
    );
    html = await s.page("/ui/settings?at=prices&ok=saved");
    const saved = from(html, '<div class="block" id="model-prices">', "</form>");
    assert.match(saved, /<b class="ok">Saved\.<\/b> Every cost follows\./);
    const mine = rowWith(saved, '<span class="u-m">small-model</span>');
    assert.match(mine, /<span class="chip info">yours<\/span>/);
    assert.match(mine, /name="in0"[^>]*value="0\.60"/);
    assert.match(mine, /name="cached0"[^>]*value="0\.10"/);
    // The page's own note at the top stays empty: the flash is in Model prices.
    assert.doesNotMatch(html, /<div class="card" style="margin-bottom:16px"><b class="ok">saved/);
    // Every call of the model, the earlier ones too, is costed at it.
    const run = await s.page("/ui/campaigns/matmul/runs/r-1/stats");
    assert.doesNotMatch(rowWith(run, "<b>Planner</b>"), /no price/);
    // The same again changes nothing; refusals in words, and nothing changes.
    assert.equal(
      (await s.post("/ui/settings/prices", form)).to,
      "/ui/settings?at=prices&ok=same#model-prices",
    );
    r = await s.post("/ui/settings/prices", { ...form, in0: "lots" });
    assert.match(
      r.to,
      /&error=small-model of lab: a price is a number, such as 0\.60\.#model-prices$/,
    );
    r = await s.post("/ui/settings/prices", { ...form, out0: "" });
    assert.match(r.to, /&error=small-model of lab: set In and Out, or leave all three empty\./);
    assert.equal(s.store.usage.prices()[0]?.price.output, 2.5);
    // A subscription's model, posted anyway, is refused in words.
    r = await s.post("/ui/settings/prices", {
      p0: "sub",
      m0: "opus-5.5",
      in0: "1",
      cached0: "",
      out0: "1",
    });
    assert.match(r.to, /&error=sub is a subscription: its calls are on its plan/);
    html = await s.page(
      `/ui/settings?at=prices&error=${encodeURIComponent("small-model of lab: a price is a number, such as 0.60.")}`,
    );
    assert.match(
      from(html, '<div class="block" id="model-prices">', "</form>"),
      /<b class="bad">Not saved\.<\/b> small-model of lab: a price is a number/,
    );
    // All three empty: no price again.
    r = await s.post("/ui/settings/prices", { ...form, in0: "", cached0: "", out0: "" });
    assert.match(r.to, /ok=saved/);
    assert.deepEqual(s.store.usage.prices(), []);
    // Each change is in the audit log, as the owner's on the dashboard.
    const audit = s.store.db
      .prepare("select actor, action from audit where action like 'model_price%' order by id")
      .all() as { actor: string; action: string }[];
    assert.deepEqual(
      audit.map((a) => [a.actor, a.action]),
      [
        ["owner:ui", "model_price_set"],
        ["owner:ui", "model_price_cleared"],
      ],
    );
  });

  test("Model prices: the page's script refuses what the server refuses, in the same words", async () => {
    const judge = new Function(`${PRICE_CORE_JS}; return prJudge;`)() as (
      v: Record<string, string>,
    ) => [string, string];
    assert.deepEqual(judge({ in: "3", cached: "0.3", out: "15" }), ["set", ""]);
    assert.deepEqual(judge({ in: "0.000001", cached: "", out: "0" }), ["set", ""]);
    assert.deepEqual(judge({ in: "", cached: "", out: "" }), ["none", ""]);
    const s = await stack();
    for (const v of [
      { in: "1,5", cached: "", out: "2" },
      { in: "1", cached: "", out: "" },
      { in: "", cached: "0.1", out: "" },
      { in: "1", cached: "-1", out: "2" },
    ]) {
      const [state, why] = judge(v);
      assert.equal(state, "bad", JSON.stringify(v));
      assert.ok(why === PRICE_WORDS.number || why === PRICE_WORDS.pair, why);
      const r = await s.post("/ui/settings/prices", {
        p0: "lab",
        m0: "small-model",
        in0: v.in,
        cached0: v.cached,
        out0: v.out,
      });
      assert.equal(r.to, `/ui/settings?at=prices&error=small-model of lab: ${why}#model-prices`);
    }
    // What the script lets through, the server saves.
    assert.match(
      (
        await s.post("/ui/settings/prices", {
          p0: "lab",
          m0: "small-model",
          in0: "0.000001",
          cached0: "",
          out0: "0",
        })
      ).to,
      /ok=saved/,
    );
    assert.deepEqual(s.store.usage.prices()[0]?.price, {
      input: 0.000001,
      cached_input: null,
      output: 0,
    });
  });

  test("the bars: each record in the span it started in; days in a time zone, 23 or 25 hours on the days the clocks change", () => {
    const t = (iso: string) => Date.parse(iso);
    const edges = [t("2026-10-21T00:00:00Z"), t("2026-10-21T01:00:00Z"), t("2026-10-21T02:00:00Z")];
    assert.deepEqual(
      bars(
        [
          { at: "2026-10-20T23:00:00Z", calls: 2 },
          { at: "2026-10-21T00:59:59Z", calls: 1 },
          { at: "2026-10-21T01:00:00Z", calls: null },
          { at: "2026-10-21T05:00:00Z", calls: 4 },
        ],
        edges,
      ),
      [3, 1, 4],
    );
    // Paris moves to summer time on 29 March 2026 and back on 25 October.
    const spring = dayEdges(t("2026-03-28T12:00:00Z"), t("2026-03-30T12:00:00Z"), "Europe/Paris");
    assert.deepEqual(
      spring.map((x) => new Date(x).toISOString()),
      ["2026-03-27T23:00:00.000Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    );
    const autumn = dayEdges(t("2026-10-25T12:00:00Z"), t("2026-10-26T12:00:00Z"), "Europe/Paris");
    assert.deepEqual(
      autumn.map((x) => new Date(x).toISOString()),
      ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
    );
  });
});

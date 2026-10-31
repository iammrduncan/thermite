import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { callUsage } from "../../../../src/core/usage.ts";
import { ModelSource } from "../../../../src/harness/agents/model/source.ts";
import {
  type PlannerCallOptions,
  plannerHarness,
  Scheduler,
} from "../../../../src/harness/agents/scheduler/index.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { Compactions } from "../../../../src/harness/compactions.ts";
import { ResearchFolder } from "../../../../src/harness/research/folder.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/**
 * The planner with a model of its own runs in the harness its route names (goal 073): Pi,
 * OpenCode, Claude Code or Codex, and its plan is checked as before. Following the workers, it
 * plans as it did: in OpenCode for OpenCode's own models, in Codex when the workers run there,
 * else in Pi. Through OpenCode or Codex, its calls reach its own provider through the harness's
 * proxy, with a credential minted for that route.
 */

const keyed = (o: Partial<ModelConfig> = {}): ModelConfig => ({
  baseUrl: "http://127.0.0.1:9/v1",
  model: "planner-model",
  apiKey: "planner-key",
  contextWindow: 0,
  maxTokens: 0,
  ...o,
});

const PLAN = JSON.stringify({
  new_families: [{ id: "tidy", description: "Small tidy-ups." }],
  assignments: [{ lane: "lane-1", family: "tidy", focus: "tidy the kernel", parent: "champion" }],
  notes: "planned",
});

/** One planning round with the planner's own model and the workers'; which harness was asked. */
async function planWith(
  planner: ModelConfig | undefined,
  workers: ModelConfig,
): Promise<{ asked: string[]; source: string; models: string[] }> {
  const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
  await env.start();
  const asked: string[] = [];
  const models: string[] = [];
  const ask = async (via: string, m: ModelConfig) => {
    asked.push(via);
    models.push(m.model);
    return PLAN;
  };
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: workers,
    plannerModel: () => planner,
    owner: "planner-harness-test",
    ask,
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
  });
  await scheduler.tick();
  await scheduler.idle();
  const epoch = env.ledger.db.prepare("select source from epoch where n = 1").get() as {
    source: string;
  };
  return { asked, source: epoch.source, models };
}

describe("the planner's own harness", () => {
  test("which harness a planner call runs in", () => {
    // Its own model: the harness its route names.
    assert.equal(plannerHarness(keyed({ harness: "opencode" }), true), "opencode");
    assert.equal(plannerHarness(keyed({ harness: "codex" }), true), "codex");
    assert.equal(
      plannerHarness(keyed({ api: "claude", harness: "claude-code" }), true),
      "claude-code",
    );
    assert.equal(plannerHarness(keyed(), true), "pi");
    assert.equal(plannerHarness(keyed({ api: "opencode", harness: "opencode" }), true), "opencode");
    // Following the workers: OpenCode only for OpenCode's own models, Codex with them.
    assert.equal(plannerHarness(keyed({ harness: "opencode" }), false), "pi");
    assert.equal(plannerHarness(keyed({ harness: "codex" }), false), "codex");
    assert.equal(
      plannerHarness(keyed({ api: "opencode", harness: "opencode" }), false),
      "opencode",
    );
    assert.equal(
      plannerHarness(keyed({ api: "claude", harness: "claude-code" }), false),
      "claude-code",
    );
    assert.equal(plannerHarness(undefined, false), "pi");
  });

  test("a planner with its own model plans in its own harness, whatever the workers run in", async () => {
    const workersInCodex = keyed({ api: "chatgpt", harness: "codex", model: "workers-model" });
    for (const [harness, extra] of [
      ["opencode", {}],
      ["codex", {}],
      ["claude-code", { api: "claude" as const }],
    ] as const) {
      const r = await planWith(keyed({ harness, ...extra }), workersInCodex);
      assert.deepEqual(r.asked, [harness], harness);
      assert.deepEqual(r.models, ["planner-model"], harness);
      assert.equal(r.source, "planner", `${harness}: the plan was checked and used`);
    }
    // Its own model in Pi: not Codex, though the workers run there (its model is unreachable
    // here, so the fixed rules plan).
    const pi = await planWith(keyed({ harness: "pi" }), workersInCodex);
    assert.deepEqual(pi.asked, []);
    assert.equal(pi.source, "fallback");
  });

  test("a planner that follows the workers plans as before: Codex with them, Pi beside OpenCode on a key", async () => {
    const codex = await planWith(undefined, keyed({ harness: "codex", model: "workers-model" }));
    assert.deepEqual(codex.asked, ["codex"]);
    assert.deepEqual(codex.models, ["workers-model"]);
    const opencode = await planWith(undefined, keyed({ harness: "opencode" }));
    assert.deepEqual(opencode.asked, []);
    const own = await planWith(undefined, keyed({ api: "opencode", harness: "opencode" }));
    assert.deepEqual(own.asked, ["opencode"]);
  });

  test("a planner call through Claude Code, Codex or OpenCode keeps its conversation before each of their own compactions in the run's research folder (goal 070)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    const folder = new ResearchFolder({
      ledger: env.service.ledger,
      scratchRoot: join(env.paths.scratchDir, "research"),
      stateRoot: join(env.paths.stateDir, "research-work"),
      runner: new LocalRunner(env.paths.scratchDir),
    });
    env.service.compactions = new Compactions({
      ledger: env.service.ledger,
      live: env.service.live,
      folder,
    });
    const given: (PlannerCallOptions | undefined)[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: keyed({ api: "claude", harness: "claude-code", model: "claude-opus-5-5" }),
      owner: "planner-compaction-test",
      ask: async (_via, _m, _prompt, _signal, o) => {
        given.push(o);
        // Claude Code compacted the call's conversation once, and the harness keeps it.
        o?.compaction?.compacted({
          number: 1,
          tokensBefore: 120_000,
          tokensAfter: 9_000,
          markdown: "# The planner: the conversation before compaction 1\n\nPlanning.\n",
          own: true,
          summary: `Planned. Kept in ${o.compaction.keptAt.dir}/${o.compaction.keptAt.stem}-1.md.`,
        });
        return PLAN;
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    const keeping = given[0]?.compaction;
    assert.ok(keeping, "the call is told where its conversation is kept");
    const run = (env.ledger.db.prepare("select id from run").get() as { id: string }).id;
    assert.equal(keeping.keptAt.dir, join(env.paths.scratchDir, "research", run, "compactions"));
    assert.match(keeping.keptAt.stem, /^planner-[0-9a-f]{12}$/);
    assert.equal(keeping.keptAt.readable, false, "the planner is not told it may read it");
    const e = env.ledger
      .eventsAfter(0, 100_000)
      .events.filter((x) => x.kind === "context_compacted")
      .map((x) => x.body as Record<string, unknown>);
    assert.equal(e.length, 1);
    assert.equal(e[0]?.harness, "claude-code");
    assert.equal(e[0]?.lane, "planner");
    assert.equal(e[0]?.trial, null);
    assert.equal(e[0]?.snapshot, `compactions/${keeping.keptAt.stem}-1.md`);
    assert.match(
      String(e[0]?.summary),
      /^Planned\. Kept in .*\/compactions\/planner-[0-9a-f]{12}-1\.md\.$/,
    );
    assert.match(
      readFileSync(join(keeping.keptAt.dir, `${keeping.keptAt.stem}-1.md`), "utf8"),
      /^# The planner: the conversation before compaction 1/,
    );
    // A call through Codex is told too.
    const viaCodex: (PlannerCallOptions | undefined)[] = [];
    const codexEnv = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await codexEnv.start();
    codexEnv.service.compactions = env.service.compactions;
    const codex = new Scheduler({
      service: codexEnv.service,
      runner: new LocalRunner(codexEnv.paths.scratchDir),
      model: keyed({ harness: "codex" }),
      owner: "planner-compaction-codex",
      ask: async (_via, _m, _p, _s, o) => {
        viaCodex.push(o);
        return PLAN;
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await codex.tick();
    await codex.idle();
    assert.match(viaCodex[0]?.compaction?.keptAt.stem ?? "", /^planner-/);
  });

  test("each planner call's model usage is in the run's records, with its round, its harness and its provider", async () => {
    // Through another harness: what its output reported, handed back with the answer.
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: keyed({ api: "chatgpt", harness: "codex", model: "workers-model", provider: "sub" }),
      owner: "planner-usage-test",
      ask: async (_via, _m, _prompt, _signal, o) => {
        o?.usage?.(callUsage({ at: 0, tokensIn: 900, cachedIn: 300, tokensOut: 40 }));
        return PLAN;
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    const calls = env.ledger.eventsAfter(0, 10_000).events.filter((e) => e.kind === "model_call");
    assert.equal(calls.length, 1);
    const b = calls[0]?.body as Record<string, unknown>;
    assert.deepEqual(
      [b.agent, b.round, b.trial, b.harness, b.provider, b.model, b.tokens_in, b.cached_in],
      ["planner", "epoch 1", null, "codex", "sub", "workers-model", 900, 300],
    );
    // In Pi: each model call, as the meter reads it.
    const fake = await startFakeModel(() => ({
      toolCalls: [{ name: "submit_plan", args: JSON.parse(PLAN) }],
      usage: { prompt: 1200, completion: 80 },
    }));
    try {
      const pi = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
      await pi.start();
      const s = new Scheduler({
        service: pi.service,
        runner: new LocalRunner(pi.paths.scratchDir),
        model: keyed({ baseUrl: fake.url, contextWindow: 32_000, maxTokens: 2000 }),
        owner: "planner-usage-test",
        runTrial: async () => ({
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
        }),
      });
      await s.tick();
      await s.idle();
      const piCalls = pi.ledger
        .eventsAfter(0, 10_000)
        .events.filter((e) => e.kind === "model_call")
        .map((e) => e.body as Record<string, unknown>);
      assert.equal(piCalls.length, fake.requests);
      assert.ok(piCalls.length >= 1);
      assert.deepEqual(
        [piCalls[0]?.agent, piCalls[0]?.harness, piCalls[0]?.provider, piCalls[0]?.tokens_in],
        ["planner", "pi", null, 1200],
      );
      assert.equal(piCalls[0]?.cached_in, null, "the fake provider names no cache");
    } finally {
      await fake.close();
    }
  });

  test("the proxy takes a planner's call to the planner's own provider, with its key", async (t: TestContext) => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({ url: String(req.url), headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = makeJudgeEnv();
    const file = join(mkdtempSync(join(tmpdir(), "thermite-planner-proxy-")), "model-route.json");
    env.service.models = new ModelSource(file, {
      baseUrl: `${base}/workers/v1`,
      model: "workers-model",
      apiKey: "workers-key",
      contextWindow: 0,
      maxTokens: 8192,
    });
    const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
    const call = (token: string) =>
      api.request("/v1/model-proxy/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
    const planner = keyed({ baseUrl: `${base}/planner/v1`, apiKey: "planner-key" });
    assert.equal((await call(env.service.mintProxyToken(planner))).status, 200);
    assert.equal((await call(env.service.mintProxyToken())).status, 200);
    assert.deepEqual(
      seen.map((s) => [s.url, s.headers.authorization]),
      [
        ["/planner/v1/chat/completions", "Bearer planner-key"],
        ["/workers/v1/chat/completions", "Bearer workers-key"],
      ],
    );
    // A credential minted for a route OpenCode reaches on its own needs no proxy.
    const own = env.service.mintProxyToken(keyed({ api: "opencode" }));
    assert.equal((await call(own)).status, 404);
    assert.equal(seen.length, 2);
  });
});

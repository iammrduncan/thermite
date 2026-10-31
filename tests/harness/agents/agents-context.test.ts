import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ModelConfig, withAgentsContext } from "../../../src/agents/model/index.ts";
import { claudeCompactionEnv } from "../../../src/agents/programs/claude-code/index.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * A campaign's own context settings in a run (goal 070): the contract's agents_context lowers each
 * agent's window and replaces its compaction point, the planner's too, and the run's record and
 * the supervisor's list of runs carry it.
 */

const route: ModelConfig = {
  api: "chatgpt",
  harness: "codex",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test",
  apiKey: "access-for-tests",
  contextWindow: 200_000,
  compactAt: 90,
  maxTokens: 0,
};

describe("a campaign's own context settings in a run (goal 070)", () => {
  test("an agent's model with them: the lower window, and the campaign's point", () => {
    assert.equal(withAgentsContext(undefined, { context_window: 32_768 }), undefined);
    assert.equal(withAgentsContext(route, undefined), route);
    const lowered = withAgentsContext(route, { context_window: 131_072, compact_at: 70 });
    assert.deepEqual([lowered?.contextWindow, lowered?.compactAt], [131_072, 70]);
    // The route's own window is lower: it stays. No campaign point: the route's.
    const kept = withAgentsContext(
      { ...route, contextWindow: 65_536 },
      { context_window: 131_072 },
    );
    assert.deepEqual([kept?.contextWindow, kept?.compactAt], [65_536, 90]);
    // A route with no window (0): the campaign's, as given.
    const given = withAgentsContext(
      { ...route, contextWindow: 0, compactAt: undefined },
      {
        context_window: 32_768,
      },
    );
    assert.deepEqual([given?.contextWindow, given?.compactAt], [32_768, undefined]);
    // What Claude Code then gets in its own settings.
    assert.deepEqual(claudeCompactionEnv(lowered as ModelConfig), {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "131072",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70",
    });
  });

  test("the planner with its own model works with the campaign's window and point; the run's record and the supervisor's list carry them", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: { agents_context: { context_window: 32_768, compact_at: 60 } },
    });
    await env.start();
    const asked: ModelConfig[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: route,
      // The planner's own model, with a larger window than the campaign's.
      plannerModel: () => ({ ...route, model: "gpt-planner", contextWindow: 400_000 }),
      owner: "context-test",
      ask: async (_via, m) => {
        asked.push(m);
        return JSON.stringify({
          new_families: [{ id: "cx-tidy", description: "Small tidy-ups." }],
          assignments: [
            { lane: "lane-1", family: "cx-tidy", focus: "tidy the kernel", parent: "champion" },
          ],
          notes: "planned",
        });
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
    assert.equal(asked.length, 1);
    assert.deepEqual(
      [asked[0]?.model, asked[0]?.contextWindow, asked[0]?.compactAt],
      ["gpt-planner", 32_768, 60],
    );
    // The run's record: its run_created event says the campaign's settings.
    const created = env.ledger
      .eventsAfter(0, 5000)
      .events.find((e) => e.kind === "run_created" && e.subject === "js-1");
    assert.ok(created);
    assert.deepEqual((created.body as { agents_context?: unknown }).agents_context, {
      context_window: 32_768,
      compact_at: 60,
    });
    // The supervisor reads them with the run, for its advisors' calls.
    const api = createHarnessApi(env.service, { supervisor: "sup-token", proposer: "prop-token" });
    const runs = (await (
      await api.request("/v1/runs", { headers: { authorization: "Bearer sup-token" } })
    ).json()) as { runs: { id: string; agents_context: unknown }[] };
    assert.deepEqual(runs.runs.find((r) => r.id === "js-1")?.agents_context, {
      context_window: 32_768,
      compact_at: 60,
    });
  });

  test("a run of a campaign without them: the routes as they are, and nothing in its record", async () => {
    const env = makeJudgeEnv();
    await env.start();
    const created = env.ledger.eventsAfter(0, 5000).events.find((e) => e.kind === "run_created");
    assert.ok(created);
    assert.equal("agents_context" in (created.body as object), false);
    const api = createHarnessApi(env.service, { supervisor: "sup-token", proposer: "prop-token" });
    const runs = (await (
      await api.request("/v1/runs", { headers: { authorization: "Bearer sup-token" } })
    ).json()) as { runs: { agents_context: unknown }[] };
    assert.equal(runs.runs[0]?.agents_context, null);
  });
});

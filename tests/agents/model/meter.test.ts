import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { summarizer } from "../../../src/agents/compaction/index.ts";
import { buildModel, type ModelConfig } from "../../../src/agents/model/index.ts";
import { PiMeter, UsageSender } from "../../../src/agents/model/meter.ts";
import { CallUsage } from "../../../src/core/usage.ts";
import { runTrial } from "../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { type ScriptedTurn, startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

const config = (url: string): ModelConfig => ({
  baseUrl: url,
  model: "test",
  apiKey: "k",
  contextWindow: 32000,
  maxTokens: 2000,
});

/** One prompt to a Pi agent through a meter; returns its records. */
async function oneReply(turn: ScriptedTurn): Promise<CallUsage[]> {
  const fake = await startFakeModel(() => turn);
  try {
    const records: CallUsage[] = [];
    const meter = new PiMeter((u) => records.push(u));
    const { models, model, thinkingLevel } = buildModel(config(fake.url));
    const agent = new Agent({
      initialState: { systemPrompt: "Answer.", model, tools: [], thinkingLevel },
      streamFn: meter.streamFn(models),
    });
    meter.watch(agent);
    await agent.prompt("hello");
    return records;
  } finally {
    await fake.close();
  }
}

describe("model usage in Pi", () => {
  test("a provider that names no cache or reasoning: those are not reported, never 0", async () => {
    const before = Date.now();
    const [u, ...more] = await oneReply({
      text: "hi",
      usage: { prompt: 300, completion: 7 },
      delayMs: 60,
    });
    assert.equal(more.length, 0);
    assert.ok(u && CallUsage.safeParse(u).success);
    assert.equal(u.calls, 1);
    assert.equal(u.tokens_in, 300);
    assert.equal(u.tokens_out, 7);
    assert.equal(u.cached_in, null);
    assert.equal(u.uncached_in, null);
    assert.equal(u.reasoning, null);
    // The reply's first token came after the provider's wait; its last after its first.
    assert.ok((u.first_token_ms ?? 0) >= 50, JSON.stringify(u));
    assert.ok((u.call_ms ?? 0) >= (u.first_token_ms ?? 0));
    assert.ok(Date.parse(u.at) >= before - 1000);
  });

  test("a provider that names them: cached input and reasoning as it says, even 0", async () => {
    const [u] = await oneReply({
      text: "hi",
      usage: { prompt: 1000, completion: 50, cached: 600, reasoning: 0 },
    });
    assert.equal(u?.tokens_in, 1000);
    assert.equal(u?.cached_in, 600);
    assert.equal(u?.uncached_in, 400);
    assert.equal(u?.tokens_out, 50);
    assert.equal(u?.reasoning, 0);
  });

  test("a compaction's summary call is metered with the agent's", async () => {
    const fake = await startFakeModel(() => ({
      text: "the summary",
      usage: { prompt: 2000, completion: 300, cached: 0 },
    }));
    try {
      const records: CallUsage[] = [];
      const meter = new PiMeter((u) => records.push(u));
      const text = await summarizer(config(fake.url), meter)("the conversation");
      assert.equal(text, "the summary");
      assert.equal(records.length, 1);
      assert.equal(records[0]?.tokens_in, 2000);
      assert.equal(records[0]?.cached_in, 0);
      assert.equal(records[0]?.first_token_ms, null);
    } finally {
      await fake.close();
    }
  });

  test("a worker's trial gives one record for each model call", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.champions.current("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    // A model that never submits: the first reply, and one nudge it answers without any work,
    // which ends the trial (goal 079: no fixed number of nudges).
    const fake = await startFakeModel(() => ({ text: "nothing to change" }));
    const records: CallUsage[] = [];
    const r = await runTrial(
      {
        trialId: "t-usage",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster.",
        wallMs: 60_000,
      },
      {
        runner,
        laneTool: [
          process.execPath,
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          fileURLToPath(new URL("../../../src/harness/agents/lanetool.ts", import.meta.url)),
        ],
        model: config(fake.url),
        submit: async () => {
          throw new Error("no submission expected");
        },
        status: async () => ({}),
        modelUsage: (u) => records.push(u),
      },
    );
    await fake.close();
    assert.equal(r.stopped, "no_submission");
    assert.equal(records.length, fake.requests);
    assert.equal(records.length, 2);
    assert.ok(records.every((u) => u.tokens_in === 100 && u.tokens_out === 20));
  });
});

describe("a worker's usage on its way to the harness", () => {
  test("a hand-over the harness refuses is tried again; what it never takes is counted", async () => {
    const taken: number[] = [];
    let fails = 1;
    const sender = new UsageSender(async (calls) => {
      if (fails-- > 0) throw new Error("harness away");
      taken.push(...calls.map((c) => c.tokens_in));
    });
    for (const n of [1, 2, 3]) sender.add(CallUsage.parse({ ...base, tokens_in: n }));
    assert.equal(await sender.finish(), 0);
    assert.deepEqual(taken, [1, 2, 3]);
    const never = new UsageSender(async () => {
      throw new Error("harness away");
    });
    never.add(CallUsage.parse(base));
    never.add(CallUsage.parse(base));
    assert.equal(await never.finish(), 2);
  });
});

const base = {
  calls: 1,
  at: "2026-10-21T10:00:00.000Z",
  tokens_in: 1,
  cached_in: null,
  uncached_in: null,
  tokens_out: 1,
  reasoning: null,
  first_token_ms: null,
  call_ms: 10,
};

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  ANTHROPIC_UNKNOWN_MAX_TOKENS,
  buildModel,
  modelConfigFromEnv,
  modelEnv,
} from "../../../../src/agents/model/index.ts";
import { type ControlRoute, ModelSource } from "../../../../src/harness/agents/model/source.ts";

const route: ControlRoute = {
  name: "opencode",
  version: 3,
  base_url: "https://models.example/v1/",
  model: "m-1",
  context_window: 262144,
  max_tokens: 0,
  reasoning: "none",
  key_hint: "…0001",
  revision: "0123456789abcdef",
  api_key: "sk-secret-0001",
};
const env = {
  baseUrl: "http://local/v1",
  model: "local-model",
  apiKey: "k",
  contextWindow: 0,
  maxTokens: 8192,
};

describe("the agents' model source", () => {
  test("control's route comes before the rig's settings, and its report never names the key", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-ms-")), "model-route.json");
    const m = new ModelSource(file, env);
    assert.equal(m.current()?.model, "local-model");
    assert.equal(m.info().source, "environment");
    m.set(route);
    const cur = m.current();
    assert.deepEqual(cur, {
      api: undefined,
      harness: undefined,
      // The provider's name, for the agents' model usage.
      provider: "opencode",
      effort: undefined,
      baseUrl: "https://models.example/v1",
      model: "m-1",
      apiKey: "sk-secret-0001",
      contextWindow: 262144,
      // The route's max_tokens is 0: no reply limit is known, and none is sent (goal 079).
      maxTokens: 0,
      reasoning: "off",
    });
    assert.ok(!JSON.stringify(m.info()).includes("sk-secret"));
    // It survives a restart, and a worker gets it as THERMITE_MODEL_*.
    assert.equal(new ModelSource(file, env).current()?.apiKey, "sk-secret-0001");
    assert.equal(modelEnv(cur as NonNullable<typeof cur>).THERMITE_MODEL_REASONING_EFFORT, "none");
    m.clear();
    assert.equal(m.current()?.model, "local-model");
    assert.equal(new ModelSource(file, undefined).info().source, "none");
  });

  test("the compaction point a route carries reaches the agents, and a worker's environment (goal 070)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-ms-")), "model-route.json");
    const m = new ModelSource(file, env);
    m.set({ ...route, compact_at: 70 });
    const cur = m.current() as NonNullable<ReturnType<ModelSource["current"]>>;
    assert.equal(cur.compactAt, 70);
    const vars = modelEnv(cur);
    assert.equal(vars.THERMITE_MODEL_COMPACT_AT, "70");
    assert.equal(modelConfigFromEnv(vars)?.compactAt, 70);
    // None set: the harness's default, and no variable.
    m.set(route);
    assert.equal(m.current()?.compactAt, undefined);
    assert.equal(modelEnv(m.current() as typeof cur).THERMITE_MODEL_COMPACT_AT, undefined);
    // Out of range: refused, from control and from the rig's own settings alike.
    assert.throws(() => m.set({ ...route, compact_at: 99 }));
    assert.throws(
      () => modelConfigFromEnv({ ...vars, THERMITE_MODEL_COMPACT_AT: "40" }),
      /THERMITE_MODEL_COMPACT_AT takes a whole number of percent from 50 to 95, not "40"/,
    );
  });

  test("a broken route file is dropped, not trusted", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-ms-")), "model-route.json");
    writeFileSync(file, JSON.stringify({ ...route, base_url: "file:///etc/passwd" }));
    assert.equal(new ModelSource(file, undefined).current(), undefined);
    assert.ok(!existsSync(file));
  });

  test("the planner's own route is kept beside the workers', and cleared to follow them again", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-planner-route-"));
    const file = join(dir, "model-route.json");
    const src = new ModelSource(file, env);
    assert.equal(src.planner(), undefined);
    assert.equal(src.plannerRevision(), null);
    src.setPlanner({
      ...route,
      name: "claude-max",
      type: "claude",
      harness: "claude-code",
      model: "claude-opus-5-5",
      effort: "xhigh",
      revision: "fedcba9876543210",
    });
    const p = src.planner();
    assert.equal(p?.api, "claude");
    assert.equal(p?.harness, "claude-code");
    assert.equal(p?.effort, "xhigh");
    assert.equal(src.plannerRevision(), "fedcba9876543210");
    // Kept across a restart, in its own file.
    assert.ok(existsSync(join(dir, "model-route-planner.json")));
    assert.equal(new ModelSource(file, env).planner()?.model, "claude-opus-5-5");
    src.setPlanner(null);
    assert.equal(src.planner(), undefined);
    assert.ok(!existsSync(join(dir, "model-route-planner.json")));
  });

  test("no reply limit is sent unless the provider's list gives the model's maximum output (goal 079)", async () => {
    // The request each route sends, as the provider would get it.
    const sent = async (cfg: Parameters<typeof buildModel>[0]) => {
      const { models, model } = buildModel(cfg);
      let body: Record<string, unknown> = {};
      const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response("no", { status: 400 });
      }) as typeof globalThis.fetch;
      const r = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { fetch, maxRetries: 0 },
      );
      assert.equal(r.stopReason, "error");
      return body;
    };
    const base = { baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: "k", contextWindow: 0 };
    // Unset in the rig's settings: 0, none sent; the provider's own limit applies.
    assert.equal(
      modelConfigFromEnv({
        THERMITE_MODEL_BASE_URL: "http://x/v1",
        THERMITE_MODEL: "m",
        THERMITE_MODEL_API_KEY: "k",
      })?.maxTokens,
      0,
    );
    const none = await sent({ ...base, maxTokens: 0 });
    assert.equal(none.max_tokens, undefined);
    assert.equal(none.max_completion_tokens, undefined);
    // With a window, still none: the room left is not a limit Thermite sends.
    assert.equal(
      (await sent({ ...base, contextWindow: 131_072, maxTokens: 0 })).max_tokens,
      undefined,
    );
    // The model's maximum output from the provider's list goes as it is.
    assert.equal((await sent({ ...base, maxTokens: 64_000 })).max_tokens, 64_000);
    // Anthropic's API needs one: the list's, else ANTHROPIC_UNKNOWN_MAX_TOKENS.
    const anthropic = { ...base, api: "anthropic" as const, baseUrl: "http://127.0.0.1:9" };
    assert.equal(
      (await sent({ ...anthropic, maxTokens: 0 })).max_tokens,
      ANTHROPIC_UNKNOWN_MAX_TOKENS,
    );
    assert.equal((await sent({ ...anthropic, maxTokens: 128_000 })).max_tokens, 128_000);
  });
});

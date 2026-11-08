import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listedPrice, listModels, providerBase } from "../../../src/control/providers/models.ts";

const answer =
  (status: number, body: unknown, seen?: { url: string; headers: Headers }[]) =>
  async (input: string | URL | Request, init?: RequestInit) => {
    seen?.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json(body, { status });
  };

describe("a provider's model list", () => {
  test("an OpenAI-compatible provider's /models, with the key as a bearer and its context sizes", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const models = await listModels(
      "openai",
      "https://p.example/v1/",
      "sk-1",
      answer(
        200,
        { data: [{ id: "b-model", context_length: 131072 }, { id: "a-model" }, { id: "" }] },
        seen,
      ) as typeof fetch,
    );
    assert.deepEqual(models, [
      { id: "a-model", context_window: undefined },
      { id: "b-model", context_window: 131072 },
    ]);
    assert.equal(seen[0]?.url, "https://p.example/v1/models");
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer sk-1");
  });

  test("a list's prices, as OpenRouter and Nous Portal give them: US dollars per token, kept per million tokens", async () => {
    const models = await listModels(
      "openai",
      "https://p.example/v1",
      "sk-1",
      answer(200, {
        data: [
          {
            id: "priced",
            pricing: {
              prompt: "0.000003",
              completion: "0.000015",
              input_cache_read: "0.0000003",
              input_cache_write: "0.00000375",
            },
          },
          { id: "no-cache-price", pricing: { prompt: "0.0000000700", completion: "0.0000005" } },
          // A router's price, -1: no price.
          { id: "router", pricing: { prompt: "-1", completion: "-1" } },
          { id: "half", pricing: { prompt: "0.000001" } },
          { id: "plain" },
        ],
      }) as typeof fetch,
    );
    assert.deepEqual(
      (models as { id: string; price?: unknown }[]).map((m) => [m.id, m.price]),
      [
        ["half", undefined],
        ["no-cache-price", { input: 0.07, cached_input: null, cache_write: null, output: 0.5 }],
        ["plain", undefined],
        ["priced", { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }],
        ["router", undefined],
      ],
    );
    assert.equal(listedPrice({ pricing: { prompt: "free", completion: "0" } }), undefined);
    // A write price that is not a number is none, and the rest of the price stands.
    assert.deepEqual(
      listedPrice({
        pricing: { prompt: "0.000001", completion: "0.000002", input_cache_write: "-1" },
      }),
      { input: 1, cached_input: null, cache_write: null, output: 2 },
    );
  });

  test("a model's maximum output, as each provider's list names it: the route's reply limit (goal 079)", async () => {
    const openRouter = await listModels(
      "openai",
      "https://p.example/v1",
      "sk-1",
      answer(200, {
        data: [
          { id: "routed", top_provider: { context_length: 200000, max_completion_tokens: 64000 } },
          { id: "gateway", max_output_tokens: 32768 },
          { id: "other", max_completion_tokens: 16384 },
          // An OpenAI-compatible list's max_tokens is not taken: it names no one meaning.
          { id: "unknown", max_tokens: 4096 },
          { id: "odd", max_output_tokens: -1 },
        ],
      }) as typeof fetch,
    );
    assert.deepEqual(
      (openRouter as { id: string; max_output?: number }[]).map((m) => [m.id, m.max_output]),
      [
        ["gateway", 32768],
        ["odd", undefined],
        ["other", 16384],
        ["routed", 64000],
        ["unknown", undefined],
      ],
    );
    // Anthropic's list: max_input_tokens is the window, max_tokens the output cap.
    const anthropic = await listModels("anthropic", "", "sk-ant", (async () =>
      Response.json({
        data: [{ id: "claude-x", max_input_tokens: 1_000_000, max_tokens: 128_000 }],
        has_more: false,
      })) as typeof fetch);
    assert.deepEqual(anthropic, [
      { id: "claude-x", context_window: 1_000_000, max_output: 128_000 },
    ]);
  });

  test("Anthropic's /v1/models, paged, with its own key header", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    let n = 0;
    const pages = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json(
        n++ === 0
          ? { data: [{ id: "claude-b" }], has_more: true, last_id: "claude-b" }
          : { data: [{ id: "claude-a" }], has_more: false },
      );
    };
    const models = await listModels("anthropic", "", "sk-ant", pages as typeof fetch);
    assert.deepEqual(
      (models as { id: string }[]).map((m) => m.id),
      ["claude-a", "claude-b"],
    );
    assert.equal(seen[0]?.url, "https://api.anthropic.com/v1/models?limit=1000");
    assert.match(seen[1]?.url ?? "", /after_id=claude-b/);
    assert.equal(seen[0]?.headers.get("x-api-key"), "sk-ant");
    assert.equal(
      providerBase("anthropic", "https://api.anthropic.com/v1/"),
      "https://api.anthropic.com",
    );
    // A pasted endpoint URL comes back to its base.
    assert.equal(
      providerBase("openai", "https://p.example/zen/v1/models"),
      "https://p.example/zen/v1",
    );
    assert.equal(
      providerBase("openai", "https://p.example/v1/chat/completions/"),
      "https://p.example/v1",
    );
    assert.equal(
      providerBase("anthropic", "https://api.anthropic.com/v1/messages"),
      "https://api.anthropic.com",
    );
  });

  test("failures say what went wrong, never with the key", async () => {
    const denied = await listModels(
      "openai",
      "https://p.example/v1",
      "sk-secret",
      answer(401, {}) as typeof fetch,
    );
    assert.deepEqual(denied, { error: "could not list its models: HTTP 401 (is the key right?)" });
    const down = await listModels("openai", "https://p.example/v1", "sk-secret", (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
    }) as typeof fetch);
    assert.deepEqual(down, { error: "could not reach it to list its models (EAI_AGAIN)" });
    const odd = await listModels(
      "openai",
      "https://p.example/v1",
      "sk-secret",
      answer(200, { models: [] }) as typeof fetch,
    );
    assert.ok("error" in odd && !odd.error.includes("sk-secret"));
  });
});

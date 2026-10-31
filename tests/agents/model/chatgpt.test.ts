import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatgptRequest, chatgptRouteAllowed } from "../../../src/agents/model/chatgpt.ts";
import {
  buildModel,
  CHATGPT_LIMIT_WAIT_MS,
  usageLimitRetry,
} from "../../../src/agents/model/index.ts";
import { CHATGPT_API } from "../../../src/core/agents.ts";
import { piRoute } from "../../../src/harness/agents/spawn.ts";

/** One Responses API stream that says "hello" and completes. */
function helloStream(): Response {
  const id = "resp_1";
  const item = "msg_1";
  const base = {
    id,
    object: "response",
    created_at: 1,
    status: "in_progress",
    model: "gpt-test",
    output: [],
  };
  const msg = {
    id: item,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "hello", annotations: [] }],
  };
  const events: [string, Record<string, unknown>][] = [
    ["response.created", { response: base }],
    [
      "response.output_item.added",
      { output_index: 0, item: { ...msg, status: "in_progress", content: [] } },
    ],
    [
      "response.content_part.added",
      {
        item_id: item,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    ],
    [
      "response.output_text.delta",
      { item_id: item, output_index: 0, content_index: 0, delta: "hello" },
    ],
    [
      "response.output_text.done",
      { item_id: item, output_index: 0, content_index: 0, text: "hello" },
    ],
    ["response.output_item.done", { output_index: 0, item: msg }],
    [
      "response.completed",
      {
        response: {
          ...base,
          status: "completed",
          output: [msg],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    ],
  ];
  const body = events
    .map(
      ([type, data], i) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: i, ...data })}\n\n`,
    )
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("a ChatGPT sign-in", () => {
  test("the proxy lets only the Responses API and the model list through, made to fit", () => {
    assert.ok(chatgptRouteAllowed("POST", "responses"));
    assert.ok(chatgptRouteAllowed("GET", "/models/"));
    assert.ok(!chatgptRouteAllowed("GET", "responses"));
    assert.ok(!chatgptRouteAllowed("POST", "chat/completions"));
    assert.ok(!chatgptRouteAllowed("POST", "responses/resp_1/cancel"));
    const fit = JSON.parse(
      chatgptRequest(
        Buffer.from(JSON.stringify({ model: "m", input: "hi", top_p: 1, user: "u", metadata: {} })),
      ).toString(),
    );
    assert.deepEqual(fit, {
      model: "m",
      input: [{ role: "user", content: "hi" }],
      store: false,
      stream: true,
    });
    assert.throws(() => chatgptRequest(Buffer.from("[1]")), /JSON object/);
  });

  test("direct to OpenAI, Pi's request fits the route: no refused fields, a developer message, the newest token", async () => {
    let token = "access-token-one";
    const seen: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({
        url: req.url,
        auth: req.headers.get("authorization") ?? "",
        body: JSON.parse(await req.text()) as Record<string, unknown>,
      });
      return helloStream();
    }) as typeof fetch;
    try {
      const { models, model, thinkingLevel } = buildModel({
        api: "chatgpt",
        baseUrl: CHATGPT_API,
        model: "gpt-test",
        apiKey: token,
        keyNow: () => token,
        contextWindow: 0,
        maxTokens: 8192,
      });
      const ask = async () => {
        const stream = models.streamSimple(
          model,
          {
            systemPrompt: "You plan.",
            messages: [{ role: "user", content: "Plan.", timestamp: Date.now() }],
          },
          { reasoning: thinkingLevel === "off" ? undefined : thinkingLevel },
        );
        for await (const _ of stream);
        return stream.result();
      };
      const first = await ask();
      assert.equal(first.stopReason, "stop", first.errorMessage);
      token = "access-token-two";
      await ask();
      assert.equal(seen[0]?.url, `${CHATGPT_API}/responses`);
      assert.equal(seen[0]?.auth, "Bearer access-token-one");
      assert.equal(seen[1]?.auth, "Bearer access-token-two", "renewed: the call takes the newest");
      const body = seen[0]?.body ?? {};
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      for (const refused of [
        "max_output_tokens",
        "temperature",
        "prompt_cache_retention",
        "previous_response_id",
      ])
        assert.equal(body[refused], undefined, refused);
      assert.equal(body.reasoning, undefined, "no effort unless one is set");
      const roles = (body.input as { role?: string }[]).map((i) => i.role);
      assert.ok(!roles.includes("system"), JSON.stringify(roles));
      assert.equal(roles[0], "developer");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a worker reaches it through the proxy with its trial's token; a full plan makes the agents wait", () => {
    const m = {
      api: "chatgpt" as const,
      baseUrl: CHATGPT_API,
      model: "gpt-test",
      apiKey: "access-token-one",
      keyNow: () => "access-token-one",
      contextWindow: 0,
      maxTokens: 8192,
    };
    const w = piRoute(m, 8700, "trial.tok");
    assert.equal(w.baseUrl, "http://127.0.0.1:8700/v1/model-proxy");
    assert.equal(w.apiKey, "trial.tok");
    assert.equal(w.keyNow, undefined);
    const other = { ...m, api: undefined, keyNow: undefined };
    assert.equal(piRoute(other, 8700, "trial.tok"), other);
    const now = Date.parse("2026-10-18T12:00:00Z");
    assert.equal(
      usageLimitRetry('429 {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}', now),
      new Date(now + CHATGPT_LIMIT_WAIT_MS).toISOString(),
    );
    assert.equal(usageLimitRetry("429 rate limited", now), undefined);
    assert.equal(usageLimitRetry(undefined, now), undefined);
  });
});

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { chatgptRequest, chatgptRouteAllowed } from "../../../src/agents/model/chatgpt.ts";
import {
  FORWARDED_HEADERS,
  forwardToProvider,
  usageLogFields,
} from "../../../src/agents/model/forward.ts";
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
    // The Codex CLI's own web search, a teacher's alone (goal 232).
    assert.ok(!chatgptRouteAllowed("POST", "alpha/search"));
    assert.ok(chatgptRouteAllowed("POST", "/alpha/search", true));
    assert.ok(!chatgptRouteAllowed("GET", "alpha/search", true));
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

  test("a conversation's session reaches OpenAI, for its prompt cache (goal 222)", async () => {
    // Pi's call with a session, as Thermite's agents in Pi now give one: its cache key and header.
    const seen: { headers: Headers; body: Record<string, unknown> }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({ headers: req.headers, body: JSON.parse(await req.text()) });
      return helloStream();
    }) as typeof fetch;
    try {
      const { models, model } = buildModel({
        api: "chatgpt",
        baseUrl: CHATGPT_API,
        model: "gpt-test",
        apiKey: "access-token-one",
        contextWindow: 0,
        maxTokens: 8192,
      });
      const stream = models.streamSimple(
        model,
        { systemPrompt: "You plan.", messages: [{ role: "user", content: "Plan.", timestamp: 1 }] },
        { sessionId: "conversation-1" },
      );
      for await (const _ of stream);
      assert.equal(seen[0]?.body.prompt_cache_key, "conversation-1");
      assert.equal(seen[0]?.headers.get("session_id"), "conversation-1");
    } finally {
      globalThis.fetch = real;
    }
    // The proxy passes the session headers on, and never the caller's credentials.
    let got: IncomingHttpHeaders = {};
    // An opaque token, as the provider's turn state for sticky routing comes.
    const turnState = `gA${"x".repeat(778)}`;
    const server = createServer((req, res) => {
      got = req.headers;
      req.resume();
      req.on("end", () =>
        res
          .writeHead(200, {
            "content-type": "text/event-stream",
            "x-codex-primary-used-percent": "42",
            "x-codex-turn-state": turnState,
            "set-cookie": "a=b",
          })
          .end(""),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const sent: Record<string, string> = {
        "content-type": "application/json",
        session_id: "conversation-1",
        conversation_id: "conversation-1",
        "x-client-request-id": "conversation-1",
        originator: "codex_cli_rs",
        "x-codex-turn-state": "state-of-the-turn",
        authorization: "Bearer the-trial-token",
        cookie: "a=b",
      };
      const answer = await forwardToProvider(
        {
          method: "POST",
          rest: "responses",
          search: "",
          header: (k) => sent[k],
          body: Buffer.from(JSON.stringify({ model: "gpt-test", input: "hi" })),
        },
        {
          api: "chatgpt",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          key: "access-token-one",
        },
        undefined,
        { ms: undefined },
      );
      await answer.text();
      // The plan's usage headers come back to the program (goal 220); nothing else of the answer's.
      assert.equal(answer.headers.get("x-codex-primary-used-percent"), "42");
      assert.equal(answer.headers.get("x-codex-turn-state"), turnState);
      assert.equal(answer.headers.get("set-cookie"), null);
      // The turn state the program sends back goes on, for the turn's sticky routing.
      for (const k of [
        "session_id",
        "conversation_id",
        "x-client-request-id",
        "originator",
        "x-codex-turn-state",
      ])
        assert.equal(got[k], sent[k], k);
      // The log gives a short value as it came, and a long one, such as the turn state, by its length.
      assert.deepEqual(
        usageLogFields({ "x-codex-primary-used-percent": "42", "x-codex-turn-state": turnState }),
        { "x-codex-primary-used-percent": "42", "x-codex-turn-state": "780 characters" },
      );
      assert.equal(got.authorization, "Bearer access-token-one", "the route's own key");
      assert.equal(got.cookie, undefined);
      assert.ok(!(FORWARDED_HEADERS as readonly string[]).includes("authorization"));
    } finally {
      server.close();
    }
  });

  test("a teacher's Codex CLI reaches the search endpoint, its request as it came; no one else does (goal 232)", async () => {
    let seen: { url: string; body: string; auth: string } | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen = { url: req.url ?? "", body, auth: req.headers.authorization ?? "" };
        res.writeHead(200, { "content-type": "application/json" }).end('{"output":[]}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const target = {
        api: "chatgpt" as const,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        key: "access-token-one",
      };
      // A search request, which carries a field a Responses request may not (max_output_tokens).
      const request = JSON.stringify({ id: "s1", model: "gpt-test", max_output_tokens: 9 });
      const call = (webSearch: boolean) =>
        forwardToProvider(
          {
            method: "POST",
            rest: "alpha/search",
            search: "",
            header: (k) => (k === "content-type" ? "application/json" : undefined),
            body: Buffer.from(request),
            webSearch,
          },
          target,
          undefined,
          { ms: undefined },
        );
      const refused = await call(false);
      assert.equal(refused.status, 403);
      assert.equal(seen, undefined, "never sent");
      const answer = await call(true);
      assert.equal(answer.status, 200);
      await answer.text();
      assert.deepEqual(seen, {
        url: "/v1/alpha/search",
        body: request,
        auth: "Bearer access-token-one",
      });
    } finally {
      server.close();
    }
  });
});

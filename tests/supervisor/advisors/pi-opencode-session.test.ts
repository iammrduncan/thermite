import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { buildModel, modelConfigFromEnv, modelEnv } from "../../../src/agents/model/index.ts";
import { AdvisorsConfig } from "../../../src/supervisor/advisors/config.ts";
import { piModel } from "../../../src/supervisor/advisors/pi/headless.ts";
import { serveAdvisorModel } from "../../../src/supervisor/advisors/proxy.ts";

test("a Pi advisor's OpenCode session survives its local proxy, and other routes do not get it", async () => {
  const seen: {
    session?: string;
    authorization?: string;
    apiKey?: string;
    userAgent?: string;
    path?: string;
  }[] = [];
  const provider = createServer((req, res) => {
    seen.push({
      session: req.headers["x-opencode-session"] as string | undefined,
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
      userAgent: req.headers["user-agent"],
      path: req.url,
    });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (req.url?.startsWith("/v1/messages")) {
        const event = (type: string, data: object) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("message_start", {
          message: {
            id: "reply",
            type: "message",
            role: "assistant",
            model: "test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        });
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
        event("message_stop", {});
        res.end();
        return;
      }
      res.write(
        'data: {"id":"reply","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"id":"reply","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const proxy = await serveAdvisorModel({ api: undefined, baseUrl: upstream, key: "provider-key" });
  const anthropicProxy = await serveAdvisorModel({
    api: "anthropic",
    baseUrl: upstream,
    key: "provider-key",
  });
  try {
    const ask = async (baseUrl: string, sessionId: string, api?: "anthropic") => {
      const { auditor } = AdvisorsConfig.parse({
        teachers: [],
        auditor: { name: "auditor", runtime: "openai", base_url: baseUrl, model: "test", api },
      });
      assert.ok(auditor && auditor.runtime === "openai");
      const callProxy = api === "anthropic" ? anthropicProxy : proxy;
      const config = piModel(auditor, { baseUrl: callProxy.root, apiKey: callProxy.token });
      const roundTrip = modelConfigFromEnv(modelEnv(config));
      assert.ok(roundTrip);
      const { models, model, thinkingLevel } = buildModel(roundTrip);
      const agent = new Agent({
        initialState: { systemPrompt: "Answer.", model, tools: [], thinkingLevel },
        sessionId,
        streamFn: models.streamSimple.bind(models),
      });
      await agent.prompt("Hello");
      const last = agent.state.messages.at(-1);
      assert.equal(last?.role, "assistant");
      assert.equal(last.stopReason, "stop", `${last.errorMessage}; path: ${seen.at(-1)?.path}`);
      return agent;
    };
    const first = await ask("https://opencode.ai/inference/go/openai/v1", "conversation-one");
    await first.prompt("Continue");
    await ask("https://opencode.ai/inference/go/openai/v1", "conversation-two");
    await ask("https://other.example/v1", "conversation-three");
    await ask("https://opencode.ai/inference/go/anthropic", "conversation-four", "anthropic");
    assert.deepEqual(
      seen.map((x) => x.session),
      ["conversation-one", "conversation-one", "conversation-two", undefined, "conversation-four"],
    );
    for (const request of seen.slice(0, 4)) {
      assert.equal(request.path, "/chat/completions");
      assert.equal(request.authorization, "Bearer provider-key");
      assert.match(request.userAgent ?? "", /^pi\//);
    }
    assert.match(seen[4]?.path ?? "", /^\/v1\/messages(?:\?|$)/);
    assert.equal(seen[4]?.apiKey, "provider-key");
    assert.match(seen[4]?.userAgent ?? "", /^pi\//);
  } finally {
    await proxy.close();
    await anthropicProxy.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

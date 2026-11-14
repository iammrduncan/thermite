import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildModel,
  modelConfigFromEnv,
  modelEnv,
  needsOpenAIResponses,
} from "../../../src/agents/model/index.ts";
import { opencodeConfig } from "../../../src/agents/programs/opencode/index.ts";
import { checkModel } from "../../../src/harness/agents/model/check.ts";
import { piModel } from "../../../src/supervisor/advisors/pi/headless.ts";

const route = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-6.1-terra",
  apiKey: "test-key",
  contextWindow: 32000,
  maxTokens: 0,
  reasoning: "high" as const,
};

test("the model check sends tools over Responses with its selected effort and executes the answer", async () => {
  const real = globalThis.fetch;
  let seen: { url: string; auth: string | null; body: Record<string, unknown> } | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    seen = { url: request.url, auth: request.headers.get("authorization"), body };
    const word = /the word (thermite-[a-z0-9]+)\./.exec(JSON.stringify(body.input))?.[1];
    assert.ok(word, JSON.stringify(body.input));
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "echo",
      arguments: JSON.stringify({ word }),
      status: "completed",
    };
    const response = {
      id: "resp_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model: route.model,
      output: [call],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, status: "in_progress", arguments: "" },
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map(
          (e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await checkModel(route);
    assert.equal(result.ok, true, result.summary);
    assert.equal(seen?.url, "https://api.openai.com/v1/responses");
    assert.equal(seen?.auth, "Bearer test-key");
    assert.deepEqual(seen?.body.reasoning, { effort: "high", summary: "auto" });
    assert.ok(Array.isArray(seen?.body.tools));
    assert.equal(seen?.body.max_output_tokens, undefined);
    assert.equal(seen?.body.temperature, undefined);
    assert.equal(seen?.body.top_p, undefined);
    const unset = await checkModel({ ...route, reasoning: undefined, maxTokens: 1234 });
    assert.equal(unset.ok, true, unset.summary);
    assert.equal(seen?.body.reasoning, undefined);
    assert.equal(seen?.body.max_output_tokens, 1234);
    const off = await checkModel({ ...route, reasoning: "off" });
    assert.equal(off.ok, true, off.summary);
    assert.deepEqual(seen?.body.reasoning, { effort: "none" });
  } finally {
    globalThis.fetch = real;
  }
});

test("Responses is limited to OpenAI's affected models, and survives an advisor's proxy", () => {
  for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"])
    assert.equal(needsOpenAIResponses({ ...route, model }), true);
  for (const baseUrl of [
    "https://other.example/v1",
    "http://api.openai.com/v1",
    "https://api.openai.com.other.example/v1",
    "https://api.openai.com/v1/other",
  ])
    assert.equal(needsOpenAIResponses({ ...route, baseUrl }), false);
  assert.equal(needsOpenAIResponses({ ...route, model: "gpt-6-luna" }), false);
  assert.equal(
    buildModel({ ...route, baseUrl: "https://other.example/v1" }).model.api,
    "openai-completions",
  );
  const advisor = piModel(
    {
      runtime: "openai",
      api: "openai",
      base_url: route.baseUrl,
      model: route.model,
      context_window: 32000,
    } as Parameters<typeof piModel>[0],
    { baseUrl: "http://localhost/v1/proxy", apiKey: "proxy-token" },
  );
  assert.equal(advisor.responses, true);
  assert.equal(modelConfigFromEnv(modelEnv(advisor))?.responses, true);
  const opencode = opencodeConfig(route, "http://localhost/v1/proxy") as {
    providers: { thermite: { package: string } };
  };
  assert.equal(opencode.providers.thermite.package, "@opencode/ai/providers/openai");
  const other = opencodeConfig(
    { ...route, baseUrl: "https://other.example/v1" },
    "http://localhost/v1/proxy",
  ) as typeof opencode;
  assert.equal(other.providers.thermite.package, "@opencode/ai/providers/openai-compatible");
  assert.ok(!JSON.stringify(opencode).includes(route.apiKey));
});

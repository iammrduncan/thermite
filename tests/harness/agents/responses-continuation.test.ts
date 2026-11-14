import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { buildModel } from "../../../src/agents/model/index.ts";
import { conversationForModel } from "../../../src/harness/agents/worker/index.ts";

for (const effort of ["high", undefined] as const) {
  test(`a Pi worker returns Responses reasoning with a tool result on the next call (${effort ?? "provider default"})`, async () => {
    const { models, model, thinkingLevel } = buildModel({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6.1-terra",
      apiKey: "test-key",
      contextWindow: 32000,
      maxTokens: 0,
      reasoning: effort,
    });
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    };
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "echo",
      arguments: JSON.stringify({ word: "hello" }),
      status: "completed",
    };
    const answer = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "done", annotations: [] }],
    };
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, "https://api.openai.com/v1/responses");
      bodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
      if (bodies.length > 2) throw new Error("unexpected extra model call");
      const output = bodies.length === 1 ? [reasoning, call] : [answer];
      const response = {
        id: `resp_${bodies.length}`,
        object: "response",
        created_at: 1,
        status: "completed",
        model: model.id,
        output,
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        ...output.flatMap((item, output_index) => [
          { type: "response.output_item.added", output_index, item },
          { type: "response.output_item.done", output_index, item },
        ]),
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
      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel,
          tools: [
            {
              name: "echo",
              label: "echo",
              description: "Echo a word.",
              parameters: Type.Object({ word: Type.String() }),
              execute: async (_id, params) => ({
                content: [{ type: "text", text: params.word }],
                details: {},
              }),
            },
          ],
        },
        convertToLlm: conversationForModel(model.api),
        streamFn: models.streamSimple.bind(models),
      });
      await agent.prompt("Echo hello.");
      assert.equal(bodies.length, 2, "the agent continues after executing the tool");
      assert.deepEqual(bodies[0]?.reasoning, effort ? { effort, summary: "auto" } : undefined);
      const second = bodies[1]?.input;
      assert.ok(Array.isArray(second));
      assert.deepEqual(
        second.find((item) => item.type === "reasoning"),
        reasoning,
      );
      assert.equal(second.find((item) => item.type === "function_call")?.call_id, call.call_id);
      const result = second.find((item) => item.type === "function_call_output");
      assert.equal(result?.call_id, call.call_id);
      assert.equal(result?.output, "hello");

      const completionMessages = conversationForModel("openai-completions")(agent.state.messages);
      const completionReply = completionMessages.find((message) => message.role === "assistant");
      assert.ok(completionReply && completionReply.role === "assistant");
      assert.equal(
        completionReply.content.some((block) => block.type === "thinking"),
        false,
      );
      assert.equal(
        completionReply.content.some((block) => block.type === "toolCall"),
        true,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

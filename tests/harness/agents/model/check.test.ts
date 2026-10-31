import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkModel } from "../../../../src/harness/agents/model/check.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";

const route = (url: string) => ({
  baseUrl: url,
  model: "m",
  apiKey: "k",
  contextWindow: 32_000,
  maxTokens: 2_000,
});

describe("the model route check", () => {
  test("a correct tool call passes, and the report says how the reply looked", async () => {
    const fake = await startFakeModel(({ messages, tools }) => {
      if (messages.some((m) => m.role === "tool")) return { text: "done" };
      const word = /the word (\S+)\./.exec(JSON.stringify(messages))?.[1] ?? "";
      assert.ok(tools.some((t) => t.function.name === "echo"));
      return { thinking: "the user wants an echo", toolCalls: [{ name: "echo", args: { word } }] };
    });
    try {
      const r = await checkModel(route(fake.url));
      assert.equal(r.ok, true, r.summary);
      assert.match(r.summary, /m answered with a correct tool call/);
      assert.equal(r.detail?.tool_called, true);
      assert.equal(r.detail?.thinking, true);
      assert.equal(r.detail?.tokens_in, 100);
    } finally {
      await fake.close();
    }
  });

  test("a reply without a tool call fails, with what came back instead", async () => {
    const fake = await startFakeModel(() => ({ text: "I cannot call tools." }));
    try {
      const r = await checkModel(route(fake.url));
      assert.equal(r.ok, false);
      assert.match(r.summary, /no tool call \(stop: stop\); it wrote: I cannot call tools\./);
    } finally {
      await fake.close();
    }
    const down = await startFakeModel(() => ({ fail: 503, failMessage: "no slot free" }));
    try {
      const r = await checkModel(route(down.url));
      assert.equal(r.ok, false);
      assert.match(r.summary, /no tool call: .*503/);
    } finally {
      await down.close();
    }
  });
});

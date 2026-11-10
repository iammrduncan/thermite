import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkModel, noAnswerWords } from "../../../../src/harness/agents/model/check.ts";
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

  test("a route with no key, such as a local server's that takes none, is checked with no Authorization header", async () => {
    const auth: (string | undefined)[] = [];
    const fake = await startFakeModel(({ messages, authorization }) => {
      auth.push(authorization);
      if (authorization !== undefined) return { fail: 401, failMessage: "no key, please" };
      if (messages.some((m) => m.role === "tool")) return { text: "done" };
      const word = /the word (\S+)\./.exec(JSON.stringify(messages))?.[1] ?? "";
      return { toolCalls: [{ name: "echo", args: { word } }] };
    });
    try {
      const r = await checkModel({ ...route(fake.url), apiKey: "" });
      assert.equal(r.ok, true, r.summary);
      assert.ok(auth.length >= 1);
      assert.ok(
        auth.every((a) => a === undefined),
        JSON.stringify(auth),
      );
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

  test("a model busy for 3 s fails a check of 2 s and passes one of 5 s, its first token timed (goal 150)", async () => {
    const fake = await startFakeModel(({ messages }) => {
      if (messages.some((m) => m.role === "tool")) return { text: "done" };
      const word = /the word (\S+)\./.exec(JSON.stringify(messages))?.[1] ?? "";
      return { toolCalls: [{ name: "echo", args: { word } }], delayMs: 3_000 };
    });
    try {
      const short = await checkModel(route(fake.url), 2_000);
      assert.equal(short.ok, false);
      assert.equal(short.summary, `m failed the tool-call check: ${noAnswerWords(2_000)}`);
      assert.match(
        short.summary,
        /no answer in 2 s: the model is down, or busy with other requests/,
      );
      const long = await checkModel(route(fake.url), 5_000);
      assert.equal(long.ok, true, long.summary);
      assert.match(long.summary, /, its first token after \d+(\.\d)? s$/);
      assert.ok(
        Number(long.detail?.first_token_seconds) >= 2.9,
        String(long.detail?.first_token_seconds),
      );
    } finally {
      await fake.close();
    }
  });
});

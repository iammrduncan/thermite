import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createFxEngine,
  FxFencedError,
  type FxFetch,
  type FxHookEvent,
  getBackendInfo,
} from "libfx";
import {
  createInMemoryPersistence,
  createLoopbackRouteFetch,
  LIBFX_GAP_PROFILE,
  LIBFX_PIN,
} from "../src/index.ts";

function sseResponse(
  chunks: readonly unknown[],
  opts?: { firstChunkDelayMs?: number; endChunkDelayMs?: number },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && opts?.firstChunkDelayMs) await delay(opts.firstChunkDelayMs);
        if (i === chunks.length - 1 && opts?.endChunkDelayMs) await delay(opts.endChunkDelayMs);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i])}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textChunks(
  text: string,
  opts?: { reasoning?: string; usage?: Record<string, unknown> },
): unknown[] {
  const chunks: unknown[] = [];
  if (opts?.reasoning) {
    chunks.push({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: opts.reasoning },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push(
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  );
  if (opts?.usage) {
    chunks.push({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [],
      usage: opts.usage,
    });
  }
  return chunks;
}

function toolCallChunks(
  calls: readonly { id: string; name: string; args: Record<string, unknown> }[],
): unknown[] {
  const chunks: unknown[] = calls.map((call, index) => ({
    id: "chatcmpl-tools",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: index === 0 ? "assistant" : undefined,
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }));
  chunks.push(
    {
      id: "chatcmpl-tools",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    {
      id: "chatcmpl-tools",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 25 },
    },
  );
  return chunks;
}

describe(`@thermite/harness-libfx (pinned libfx@${LIBFX_PIN})`, () => {
  it("loads native addon and executes a streamed turn with native effort and OpenAI nested usage", async () => {
    const info = await getBackendInfo({ surface: "agent" });
    assert.equal(info.backend, "native");
    assert.equal(LIBFX_GAP_PROFILE.pin, LIBFX_PIN);

    const persistence = createInMemoryPersistence();
    let capturedBody: Record<string, unknown> | undefined;
    const engine = await createFxEngine({
      provider: {
        name: "mock",
        baseUrl: "http://127.0.0.1/mock",
        models: {
          "mock-model": {
            reasoningEfforts: { high: { reasoning_effort: "high" } },
          },
        },
      },
      model: { id: "mock-model", effort: "high" },
      persistence,
      async fetch(_url, init) {
        capturedBody = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<
          string,
          unknown
        >;
        return sseResponse(
          textChunks("hello from libfx", {
            reasoning: "step 1",
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 150,
              prompt_tokens_details: { cached_tokens: 600 },
              completion_tokens_details: { reasoning_tokens: 40 },
            },
          }),
        );
      },
    });

    try {
      const turn = engine.prompt("say hi");
      let text = "";
      let reasoning = "";
      for await (const event of turn) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "reasoning_delta") reasoning += event.delta;
      }
      const result = await turn.result;

      assert.equal(result.stopReason, "end_turn");
      assert.equal(text, "hello from libfx");
      assert.equal(reasoning, "step 1");
      assert.equal(capturedBody?.reasoning_effort, "high");
      assert.equal(result.usage.inputTokens, 1000);
      assert.equal(result.usage.outputTokens, 150);
      assert.equal(result.usage.cacheReadTokens, 600);
      assert.equal(result.usage.reasoningTokens, 40);
      assert.ok(persistence.records.length > 0);
    } finally {
      await engine.close();
    }
  });

  it("serializes writes:true/idempotent:false host tools and returns tool results to the model", async () => {
    let modelCalls = 0;
    let activeTools = 0;
    let maxConcurrentTools = 0;
    const executionOrder: string[] = [];
    let secondRequestText = "";

    const engine = await createFxEngine({
      provider: { name: "mock", baseUrl: "http://127.0.0.1/mock" },
      model: "mock-model",
      tools: [
        {
          name: "mutate_file",
          description: "Mutates workspace state sequentially",
          inputSchema: {
            type: "object",
            properties: { step: { type: "integer" } },
            required: ["step"],
          },
          idempotent: false,
          writes: true,
          async execute(input: { step: number }) {
            activeTools++;
            maxConcurrentTools = Math.max(maxConcurrentTools, activeTools);
            executionOrder.push(`start:${input.step}:${typeof input.step}`);
            await delay(20);
            executionOrder.push(`end:${input.step}`);
            activeTools--;
            return `applied-${input.step}`;
          },
        },
      ],
      async fetch(_url, init) {
        modelCalls++;
        if (modelCalls === 1) {
          return sseResponse(
            toolCallChunks([
              { id: "call_1", name: "mutate_file", args: { step: "1" } },
              { id: "call_2", name: "mutate_file", args: { step: 2 } },
            ]),
          );
        }
        secondRequestText = new TextDecoder().decode(init.body as Uint8Array);
        return sseResponse(textChunks("all mutations applied"));
      },
    });

    try {
      const turn = engine.prompt("run both steps");
      const toolEnds: { id: string; isError: boolean }[] = [];
      for await (const event of turn) {
        if (event.type === "tool_end") {
          toolEnds.push({ id: event.id, isError: event.isError });
        }
      }
      const result = await turn.result;

      assert.equal(result.stopReason, "end_turn");
      assert.equal(modelCalls, 2);
      assert.equal(maxConcurrentTools, 1);
      assert.deepEqual(executionOrder, ["start:1:number", "end:1", "start:2:number", "end:2"]);
      assert.deepEqual(toolEnds, [
        { id: "call_1", isError: false },
        { id: "call_2", isError: false },
      ]);
      assert.ok(secondRequestText.includes("applied-1"));
      assert.ok(secondRequestText.includes("applied-2"));
    } finally {
      await engine.close();
    }
  });

  it("meters TTFT and call_ms through hooks.onEvent", async () => {
    const hookEvents: FxHookEvent[] = [];
    const engine = await createFxEngine({
      provider: { name: "mock", baseUrl: "http://127.0.0.1/mock" },
      model: "mock-model",
      hooks: {
        onEvent(event) {
          hookEvents.push(event);
        },
      },
      async fetch() {
        return sseResponse(
          textChunks("metered reply", {
            usage: {
              prompt_tokens: 500,
              completion_tokens: 40,
              prompt_tokens_details: { cached_tokens: 250, cache_write_tokens: 90 },
              completion_tokens_details: { reasoning_tokens: 12 },
            },
          }),
          { firstChunkDelayMs: 30, endChunkDelayMs: 25 },
        );
      },
    });

    try {
      const turn = engine.prompt("measure latency");
      for await (const _ of turn) {
        // drain turn stream
      }
      await turn.result;
    } finally {
      await engine.close();
    }

    const start = hookEvents.find((e) => e.type === "model.start");
    const outputStart = hookEvents.find((e) => e.type === "model.output_start");
    const end = hookEvents.find((e) => e.type === "model.end");

    assert.ok(start, "expected model.start hook event");
    assert.ok(outputStart, "expected model.output_start hook event");
    assert.ok(end, "expected model.end hook event");

    const ttftMs = outputStart.timestamp - start.timestamp;
    const callMs = end.timestamp - start.timestamp;
    assert.ok(ttftMs >= 20, `expected ttftMs >= 20, got ${ttftMs}`);
    assert.ok(callMs >= ttftMs + 15, `expected callMs (${callMs}) >= ttftMs (${ttftMs}) + 15`);
    assert.equal(end.data.usage?.cacheReadTokens, 250);
    assert.equal(end.data.usage?.reasoningTokens, 12);
    assert.equal(end.data.usage?.cacheWriteTokens, null);
    assert.equal(LIBFX_GAP_PROFILE.requiresSseUsageScanner, true);
  });

  it("rewrites synthetic loopback URLs to LAN HTTP targets for both authed and keyless servers", async () => {
    const lanTarget = "http://192.0.2.10:8080/v1";
    const routePrefix = "http://127.0.0.1/thermite-route/local-lm";

    await assert.rejects(
      () =>
        createFxEngine({
          provider: { name: "lan-direct", baseUrl: lanTarget },
          model: "local-model",
          async fetch() {
            return sseResponse(textChunks("unreachable"));
          },
        }),
      TypeError,
    );

    const observed: { url: string; auth: string | null }[] = [];
    const mockTransport: FxFetch = async (url, init) => {
      observed.push({ url, auth: new Headers(init.headers).get("authorization") });
      return sseResponse(textChunks("ok-from-lan"));
    };

    const authedEngine = await createFxEngine({
      provider: { name: "local-lm", baseUrl: routePrefix },
      model: "local-model",
      credentials: async () => ({ apiKey: "mock-local-credential" }),
      fetch: createLoopbackRouteFetch(lanTarget, routePrefix, mockTransport),
    });
    try {
      const turn = authedEngine.prompt("ping authed");
      for await (const _ of turn) {
        // drain
      }
      const res = await turn.result;
      assert.equal(res.stopReason, "end_turn");
    } finally {
      await authedEngine.close();
    }

    const keylessEngine = await createFxEngine({
      provider: { name: "local-lm", baseUrl: routePrefix },
      model: "local-model",
      fetch: createLoopbackRouteFetch(lanTarget, routePrefix, mockTransport),
    });
    try {
      const turn = keylessEngine.prompt("ping keyless");
      for await (const _ of turn) {
        // drain
      }
      const res = await turn.result;
      assert.equal(res.stopReason, "end_turn");
    } finally {
      await keylessEngine.close();
    }

    assert.deepEqual(observed, [
      {
        url: "http://192.0.2.10:8080/v1/chat/completions",
        auth: "Bearer mock-local-credential",
      },
      {
        url: "http://192.0.2.10:8080/v1/chat/completions",
        auth: null,
      },
    ]);
  });

  it("round-trips journal/checkpoint persistence with handoff resume and cursor fencing", async () => {
    const persistence = createInMemoryPersistence();
    let engineACalls = 0;
    let toolRuns = 0;

    const tool = {
      name: "record_step",
      description: "Records one step",
      inputSchema: { type: "object", properties: {} },
      idempotent: true,
      async execute() {
        toolRuns++;
        return "step-output-payload";
      },
    };

    const engineA = await createFxEngine({
      provider: { name: "mock", baseUrl: "http://127.0.0.1/mock" },
      model: "mock-model",
      persistence,
      checkpointAfterBytes: 1,
      tools: [tool],
      async fetch(_url, init) {
        engineACalls++;
        if (engineACalls === 1) {
          return sseResponse(toolCallChunks([{ id: "tc_1", name: "record_step", args: {} }]));
        }
        await delay(300, undefined, { signal: init.signal ?? undefined }).catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      },
    });

    const sessionId = engineA.sessionId;
    try {
      const turnA = engineA.prompt("start durable work", { turnId: "durable-turn-1" });
      for await (const event of turnA) {
        if (event.type === "tool_end") {
          turnA.cancel({ reason: "handoff" });
        }
      }
      const resA = await turnA.result;
      assert.equal(resA.stopReason, "cancelled");
    } finally {
      await engineA.close();
    }

    assert.equal(toolRuns, 1);
    assert.ok(persistence.records.length > 0);

    let resumedBody = "";
    const engineB = await createFxEngine({
      provider: { name: "mock", baseUrl: "http://127.0.0.1/mock" },
      model: "mock-model",
      sessionId,
      persistence,
      checkpointAfterBytes: 1,
      tools: [tool],
      async fetch(_url, init) {
        resumedBody = new TextDecoder().decode(init.body as Uint8Array);
        return sseResponse(textChunks("resumed cleanly"));
      },
    });

    try {
      const resumedTurn = engineB.resume();
      assert.ok(resumedTurn, "expected an open turn to resume");
      let resumedText = "";
      for await (const event of resumedTurn) {
        if (event.type === "text_delta") resumedText += event.delta;
      }
      const resB = await resumedTurn.result;
      assert.equal(resB.stopReason, "end_turn");
      assert.equal(resumedText, "resumed cleanly");
      assert.equal(toolRuns, 1, "tool must not re-execute after durable tool_end");
      assert.ok(resumedBody.includes("step-output-payload"));
    } finally {
      await engineB.close();
    }

    assert.ok(persistence.checkpoint !== null, "expected saveCheckpoint to persist snapshot");

    // Verify optimistic cursor fencing rejects stale writers with FxFencedError
    const staleHooks: FxHookEvent[] = [];
    const staleEngine = await createFxEngine({
      provider: { name: "mock", baseUrl: "http://127.0.0.1/mock" },
      model: "mock-model",
      sessionId,
      persistence,
      hooks: {
        onEvent(event) {
          staleHooks.push(event);
        },
      },
      async fetch() {
        return sseResponse(textChunks("should be fenced"));
      },
    });

    // Advance the shared persistence head from a newer writer after staleEngine loaded
    await persistence.append({
      expected: persistence.head,
      idempotencyKey: "newer-writer-takeover",
      data: new Uint8Array([1, 2, 3]),
      barrier: true,
    });

    try {
      const staleTurn = staleEngine.prompt("stale write");
      await assert.rejects(
        async () => {
          for await (const _ of staleTurn) {
            // drain
          }
          await staleTurn.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: unknown }).code, "FX_JOURNAL_APPEND_FAILED");
          assert.ok(error.cause instanceof FxFencedError);
          assert.equal(error.cause.code, "FX_FENCED");
          return true;
        },
      );
      const journalError = staleHooks.find((e) => e.type === "journal.error");
      assert.ok(journalError && journalError.type === "journal.error");
      assert.equal(journalError.data.fenced, true);
    } finally {
      await staleEngine.close();
    }
  });

  it("enforces synchronous turn limits inside options.fetch with zero wasted extra calls", async () => {
    const maxCalls = 2;
    let transportCalls = 0;
    const controller = new AbortController();

    const engine = await createFxEngine({
      provider: { name: "mock", baseUrl: "http://127.0.0.1/mock" },
      model: "mock-model",
      tools: [
        {
          name: "next_step",
          description: "Keeps looping",
          inputSchema: { type: "object", properties: {} },
          idempotent: true,
          execute() {
            return "continue";
          },
        },
      ],
      async fetch() {
        if (transportCalls >= maxCalls) {
          controller.abort(new Error("turns_limit"));
          throw new DOMException("turns_limit", "AbortError");
        }
        transportCalls++;
        return sseResponse(
          toolCallChunks([{ id: `tc_${transportCalls}`, name: "next_step", args: {} }]),
        );
      },
    });

    try {
      const turn = engine.prompt("loop until capped", { signal: controller.signal });
      for await (const _ of turn) {
        // drain
      }
      const result = await turn.result;
      assert.equal(result.stopReason, "cancelled");
      assert.equal(transportCalls, maxCalls);
    } finally {
      await engine.close();
    }
  });
});

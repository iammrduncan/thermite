import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { buildModel } from "../../../src/agents/model/index.ts";
import { GOOGLE_BRIDGE_FAILURES } from "../../../src/core/google-gemini.ts";
import {
  classifyProviderError,
  nextStep,
  ProviderWatch,
} from "../../../src/harness/agents/provider-errors.ts";
import { runResearchTrial } from "../../../src/harness/agents/research/worker.ts";
import { runTrial, watchedStream } from "../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";

const signatures = { thinking: "dGhvdWdodA==", empty: "ZW1wdHk=", tool: "dG9vbA==" };
async function fixture(quota = false) {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(Buffer.from(b));
    requests.push(Buffer.concat(chunks).toString());
    if (quota) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: GOOGLE_BRIDGE_FAILURES.rate_limit.message,
          },
        }),
      );
      return;
    }
    const parts =
      requests.length === 1
        ? [
            { text: "thinking fixture", thought: true, thoughtSignature: signatures.thinking },
            { text: "", thoughtSignature: signatures.empty },
            {
              functionCall: { name: "note", args: { kind: "observation", text: "fixture" } },
              thoughtSignature: signatures.tool,
            },
          ]
        : [{ text: "finished" }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    model: {
      api: "google-gemini-api" as const,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: "fixture-capability",
      model: "fixture-flash",
      contextWindow: 32000,
      maxTokens: 512,
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const research of [false, true])
  for (const metered of [false, true])
    test(`${research ? "research" : "hillclimb"} entrypoint retains native signed history, meter=${metered}`, async () => {
      const f = await fixture();
      const root = await mkdtemp(join(tmpdir(), "google-worker-"));
      let notes = 0,
        usage = 0;
      const common = {
        model: f.model,
        note: async () => ({ note: ++notes }),
        ...(metered
          ? {
              modelUsage: () => {
                usage++;
              },
            }
          : {}),
      };
      try {
        const spec = {
          trialId: "fixture",
          run: "fixture",
          lane: "lane-1" as const,
          brief: "Write a fixture note.",
          maxTurns: 2,
          wallMs: 15_000,
        };
        const result = research
          ? await runResearchTrial(spec, { ...common, call: async () => ({}) })
          : await runTrial(
              { ...spec, workspace: root, parentCommit: "a".repeat(40), editablePaths: [] },
              {
                ...common,
                runner: new LocalRunner(root),
                laneTool: [],
                submit: async () => {
                  throw new Error("fixture must not submit");
                },
                status: async () => ({}),
              },
            );
        assert.equal(notes, 1, JSON.stringify(result));
        assert.equal(result.toolCalls, 1);
        assert.equal(result.turns, 2);
        assert.ok(f.requests.length >= 2);
        const replay = JSON.parse(f.requests[1] ?? "{}") as {
          contents?: Array<{ parts?: unknown[] }>;
        };
        const parts = replay.contents?.flatMap((c) => c.parts ?? []) ?? [];
        assert.deepEqual(
          parts.find(
            (p) => (p as { thoughtSignature?: string }).thoughtSignature === signatures.thinking,
          ),
          { text: "thinking fixture", thought: true, thoughtSignature: signatures.thinking },
        );
        assert.deepEqual(
          parts.find(
            (p) => (p as { thoughtSignature?: string }).thoughtSignature === signatures.empty,
          ),
          { text: "", thoughtSignature: signatures.empty },
        );
        assert.match(f.requests[1] ?? "", new RegExp(signatures.tool));
        assert.match(f.requests[1] ?? "", /functionResponse/u);
        assert.equal(usage > 0, metered);
      } finally {
        await f.close();
        await rm(root, { recursive: true, force: true });
      }
    });

test("native worker quota event retains retry policy without a fetch wrapper", async () => {
  const f = await fixture(true);
  try {
    const { models, model } = buildModel(f.model);
    const watch = new ProviderWatch();
    const call = watchedStream(models, watch);
    assert.ok(call);
    const stream = await call(
      model,
      normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }),
      { maxRetries: 0 },
    );
    for await (const _event of stream) {
      /* Consume the actual production observation wrapper. */
    }
    const result = await stream.result();
    const failure = classifyProviderError(result.errorMessage ?? "", watch.take());
    assert.equal(failure.kind, "rate_limit");
    assert.equal(nextStep(failure, { failures: 0, rateWaits: 0 }).end, false);
  } finally {
    await f.close();
  }
});

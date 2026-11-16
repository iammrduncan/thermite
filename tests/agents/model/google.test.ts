import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Type } from "typebox";
import { buildModel, PiMeter } from "../../../src/agents/model/index.ts";

for (const signature of ["b3BhcXVlLWZpeHR1cmU=", "invalid-signature"])
  test(`native adapter tool signature replay: ${signature === "invalid-signature" ? "invalid is filtered" : "valid is retained"}`, async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      try {
        assert.equal(req.headers["x-goog-api-key"], "fixture-capability");
        assert.equal(req.url, "/bridge/models/fixture-flash:streamGenerateContent?alt=sse");
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
        assert.equal(
          (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens,
          undefined,
        );
        requests.push(body);
        const output =
          requests.length === 1
            ? { functionCall: { name: "answer", args: { n: 7 } }, thoughtSignature: signature }
            : { text: "accepted" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [output] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, cachedContentTokenCount: 0, thoughtsTokenCount: 0 } })}\n\n`,
        );
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bridge`;
      const { models, model } = buildModel({
        api: "google-gemini-api",
        baseUrl,
        model: "fixture-flash",
        apiKey: "fixture-capability",
        contextWindow: 8192,
        maxTokens: 0,
      });
      const meter = new PiMeter(() => {});
      const context = {
        messages: [
          { role: "user" as const, content: "Call answer with seven", timestamp: Date.now() },
        ],
        tools: [
          {
            name: "answer",
            description: "Fixture",
            parameters: Type.Object({ n: Type.Integer() }),
          },
        ],
      };
      const reply = await models.completeSimple(model, context, meter.callOptions(model));
      assert.notEqual(reply.stopReason, "error", reply.errorMessage);
      const tool = reply.content.find((p) => p.type === "toolCall");
      assert.ok(tool && tool.type === "toolCall");
      assert.equal(tool.thoughtSignature, signature);
      const next = await models.completeSimple(
        model,
        {
          ...context,
          messages: [
            ...context.messages,
            reply,
            {
              role: "toolResult" as const,
              toolCallId: tool.id,
              toolName: "answer",
              content: [{ type: "text" as const, text: "7" }],
              isError: false,
              timestamp: Date.now(),
            },
          ],
        },
        meter.callOptions(model),
      );
      assert.notEqual(next.stopReason, "error", next.errorMessage);
      assert.equal(requests.length, 2);
      const sent = JSON.stringify(requests[1]);
      if (signature === "invalid-signature") assert.doesNotMatch(sent, /invalid-signature/u);
      else assert.match(sent, /"thoughtSignature":"b3BhcXVlLWZpeHR1cmU="/u);
      assert.match(sent, /"functionResponse"/u);
      assert.equal(next.usage.input, 7);
      assert.equal(next.usage.output, 3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

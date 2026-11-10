import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai";

// Goal 140: pi-ai 1.4 parsed a streaming tool call's whole arguments again on each piece, so a
// call of a megabyte stopped a rig's supervisor for 75 minutes, and Thermite patched it at install.
// pi-ai 1.5 streams the arguments through ToolCallArgumentsStream, which reads each piece once, in
// every provider Thermite uses (goal 216). This checks that cost on the installed pi-ai.
test("a megabyte of tool-call arguments, streamed in small pieces, costs time linear in its length (goals 140, 216)", () => {
  const content = "for (int i = 0; i < n; ++i) { acc += w[i] * x[i]; }\n".repeat(20_000);
  const whole = JSON.stringify({ path: "src/kernel.cu", content });
  assert.ok(whole.length > 1_000_000);
  const stream = new ToolCallArgumentsStream();
  const t0 = performance.now();
  let partial: Record<string, unknown> = {};
  // A provider's pieces are tens of bytes: here 32, about 33,000 of them.
  for (let i = 0; i < whole.length; i += 32) partial = stream.append(whole.slice(i, i + 32));
  const ms = performance.now() - t0;
  // Parsed again on each piece, as in pi-ai 1.4, this takes many minutes.
  assert.ok(ms < 5_000, `${Math.round(ms)} ms`);
  // The partial arguments follow the text as it streams.
  assert.equal(partial.path, "src/kernel.cu");
  assert.equal(typeof partial.content, "string");
  // And the call's end parses its whole arguments once.
  const done = stream.finish();
  assert.equal(done.argumentsError, undefined);
  assert.deepEqual(done.arguments, { path: "src/kernel.cu", content });
});

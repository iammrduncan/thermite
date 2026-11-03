import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";

// Pi's parser as installed, after scripts/patch-pi-ai.mjs (goal 140).
test("a streaming tool call's long arguments are not parsed again on each piece; a short one's and a finished one's are (goal 140)", () => {
  const content = "for (int i = 0; i < n; ++i) { acc += w[i] * x[i]; }\n".repeat(20_000);
  const whole = JSON.stringify({ path: "src/kernel.cu", content });
  assert.ok(whole.length > 1_000_000);
  // The newest hundred of a megabyte's pieces: without the patch, each parse takes tens of
  // milliseconds, and a call streamed in thousands of pieces takes minutes.
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) parseStreamingJson(whole.slice(0, whole.length - 10 - i));
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${Math.round(ms)} ms`);
  assert.deepEqual(parseStreamingJson(whole.slice(0, -10)), {});
  // A short partial call still gives its fields as they stream.
  assert.deepEqual(parseStreamingJson('{"path": "src/kernel.cu", "con'), { path: "src/kernel.cu" });
  // And the call's end parses its whole arguments, as before.
  assert.deepEqual(parseToolCallArguments(whole).arguments, { path: "src/kernel.cu", content });
});

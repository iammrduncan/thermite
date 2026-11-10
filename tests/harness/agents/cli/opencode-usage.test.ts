import assert from "node:assert/strict";
import { test } from "node:test";
import { newTally, readOpencodeEvents } from "../../../../src/agents/programs/opencode/index.ts";
import type { CallUsage } from "../../../../src/core/usage.ts";

const step = (tokens: Record<string, unknown>) =>
  JSON.stringify({ type: "step_finish", sessionID: "ses_1", timestamp: 2000, part: { tokens } });

const usage = (tokens: Record<string, unknown>): CallUsage => {
  const t = newTally();
  readOpencodeEvents([step(tokens)], t);
  assert.equal(t.calls.length, 1);
  return t.calls[0] as CallUsage;
};

test("a step's cache write is an input token, reported apart, and a step reporting none says so (goal 195)", () => {
  // OpenCode's own input leaves the cache out: the write is added back.
  const wrote = usage({ input: 100, output: 10, cache: { write: 40 } });
  assert.equal(wrote.tokens_in, 140);
  assert.equal(wrote.cached_in, null);
  assert.equal(wrote.uncached_in, null, "no cache figure, so no split either");
  assert.equal(wrote.cache_write_in, 40);
  // A read and a write together: the read as cached, the write as written, both in the input.
  const both = usage({ input: 100, output: 10, cache: { read: 600, write: 40 } });
  assert.equal(both.tokens_in, 740);
  assert.equal(both.cached_in, 600);
  assert.equal(both.cache_write_in, 40);
  // Neither: nothing to report, never 0.
  const none = usage({ input: 100, output: 10 });
  assert.equal(none.tokens_in, 100);
  assert.equal(none.cached_in, null);
  assert.equal(none.cache_write_in, null);
});

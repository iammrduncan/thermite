import assert from "node:assert/strict";
import { test } from "node:test";
import { keyHint } from "../../../src/harness/controller/checks.ts";

/**
 * A failed model check of one of OpenCode's own paid models, run through OpenCode's own client
 * (control sends it that way only with no key), says it needs the provider's key (issue 26).
 */

test("a paid OpenCode model's failed check says it needs its provider's key; nothing else changes", () => {
  const failed = { ok: false, summary: "Model unavailable: opencode/claude-haiku-5-5" };
  assert.match(
    keyHint({ api: "opencode", model: "claude-haiku-5-5" }, failed).summary,
    /^Model unavailable: opencode\/claude-haiku-5-5 \(OpenCode serves claude-haiku-5-5 only with its provider's key: add the key to the provider on control's Providers page, or choose a model whose name ends in -free\)$/,
  );
  // A free model, another provider's model, and a check that passed keep their words.
  assert.equal(keyHint({ api: "opencode", model: "beam-free" }, failed), failed);
  assert.equal(keyHint({ api: "openai", model: "claude-haiku-5-5" }, failed), failed);
  const passed = { ok: true, summary: "answered" };
  assert.equal(keyHint({ api: "opencode", model: "claude-haiku-5-5" }, passed), passed);
});

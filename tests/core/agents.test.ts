/**
 * Which agent program reaches which kind of provider, and which go through the harness's model
 * proxy (goal 125, T7): one table, read by the harness and by control.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HARNESSES,
  type Harness,
  PROVIDER_TYPES,
  programForApi,
  reaches,
  routeRefusal,
  throughProxy,
} from "../../src/core/agents.ts";

/** What each program reaches, as the table says it. */
const reachOf = (h: Harness) => PROVIDER_TYPES.filter((t) => reaches(h, t));

describe("the agents' routes", () => {
  test("each program reaches the providers it can run: a Claude subscription only Claude Code, OpenCode's own models only OpenCode", () => {
    assert.deepEqual(reachOf("pi"), ["openai", "anthropic", "chatgpt"]);
    assert.deepEqual(reachOf("opencode"), ["openai", "anthropic", "opencode", "chatgpt"]);
    assert.deepEqual(reachOf("claude-code"), ["claude"]);
    assert.deepEqual(reachOf("codex"), ["openai", "chatgpt"]);
    // A route that names no kind is an OpenAI-compatible one.
    for (const h of HARNESSES) assert.equal(reaches(h, undefined), reaches(h, "openai"), h);
  });

  test("a provider that one program alone reaches names it", () => {
    assert.equal(programForApi("claude"), "claude-code");
    assert.equal(programForApi("opencode"), "opencode");
    for (const t of ["openai", "anthropic", "chatgpt", undefined] as const)
      assert.equal(programForApi(t), undefined, String(t));
  });

  test("the model proxy carries every provider but those it adds no key for", () => {
    assert.deepEqual(
      PROVIDER_TYPES.filter((t) => throughProxy(t)),
      ["openai", "anthropic", "chatgpt"],
    );
    assert.equal(throughProxy(undefined), true);
  });

  test("a refused route names the program whose limit refuses it", () => {
    const refused: Record<string, Harness | undefined> = {};
    for (const t of PROVIDER_TYPES)
      for (const h of HARNESSES) {
        const r = routeRefusal(t, h);
        assert.equal(r === undefined, reaches(h, t), `${t} in ${h}`);
        if (r) refused[`${t} in ${h}`] = r;
      }
    assert.deepEqual(refused, {
      // A Claude subscription and Claude Code go only together, whatever else the route breaks.
      "claude in pi": "claude-code",
      "claude in opencode": "claude-code",
      "claude in codex": "claude-code",
      "openai in claude-code": "claude-code",
      "anthropic in claude-code": "claude-code",
      "opencode in claude-code": "claude-code",
      "chatgpt in claude-code": "claude-code",
      // Codex speaks only OpenAI's Responses API.
      "anthropic in codex": "codex",
      "opencode in codex": "codex",
      // OpenCode's own models in Pi: the harness takes the route (programForApi sends them on).
      "opencode in pi": "pi",
    });
  });
});

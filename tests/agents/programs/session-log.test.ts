import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { codexRollout } from "../../../src/agents/programs/codex/rollout.ts";
import {
  countUnknown,
  newSessionTally,
  remember,
  type SessionEvent,
  tallyDifferences,
  tallyEvents,
  tallyLog,
} from "../../../src/agents/programs/session-log.ts";
import { callUsage } from "../../../src/core/usage.ts";

const usage = (tokensIn: number): SessionEvent => ({
  type: "usage",
  call: callUsage({ at: 0, calls: 1, tokensIn, tokensOut: 1 }),
});

describe("what the session-log adapters share", () => {
  test("a tally counts turns by the program's rule, and a result that says nothing worked", () => {
    const events: SessionEvent[] = [
      { type: "session", id: "s-1" },
      { type: "assistant.text", messageId: "m-1", text: "Reading it." },
      { type: "tool.call", id: "c-1", name: "shell", input: { cmd: "make" } },
      usage(100),
      { type: "tool.result", id: "c-1", output: "ok" },
      { type: "tool.result", id: "c-2", ok: false, output: "no" },
      { type: "assistant.text", messageId: "m-2", text: "" },
      { type: "turn.ended", reason: "limit", error: "the window is full" },
      { type: "turn.ended", reason: "interrupted" },
    ];
    const calls = newSessionTally();
    tallyEvents(calls, events, "calls");
    const items = newSessionTally();
    tallyEvents(items, events, "items");
    assert.equal(calls.turns, 1, "each model call");
    assert.equal(items.turns, 3, "each message and each tool call");
    assert.equal(calls.lastText, "Reading it.", "an empty text leaves the last one");
    assert.deepEqual(
      calls.tools.map((t) => [t.tool, t.ok]),
      [
        ["shell", true],
        ["tool", false],
      ],
    );
    assert.deepEqual(calls.errors, ["the window is full"]);
    assert.equal(calls.session, "s-1");
  });

  test("two tallies' differences name each count, and the last text only by its length", () => {
    const a = {
      ...newSessionTally(),
      turns: 3,
      tokensIn: 10,
      lastText: "secret words",
      session: "s",
    };
    const b = { ...newSessionTally(), turns: 3, tokensIn: 12, lastText: "other", session: "s" };
    assert.deepEqual(tallyDifferences(a, b), {
      tokensIn: { output: 10, log: 12 },
      lastTextLength: { output: 12, log: 5 },
    });
    assert.deepEqual(tallyDifferences(a, a), {});
  });

  test("a log read whole leaves out a last line the program may be writing still", () => {
    const line =
      '{"timestamp":"2026-10-29T05:52:16.107Z","type":"token_usage_record","payload":{"response_id":"r-1","usage":{"input_tokens":10,"output_tokens":2}}}';
    const whole = tallyLog(codexRollout, `${line}\n${line.slice(0, 40)}`);
    assert.equal(whole.tally.tokensIn, 10);
    assert.deepEqual([...whole.unknown], [], "the cut line is not counted as unknown");
  });

  test("the adapters' memories have limits: kinds by name, and ids seen", () => {
    const unknown = new Map<string, number>();
    for (let i = 0; i < 105; i++) countUnknown(unknown, `kind-${i}`);
    countUnknown(unknown, "kind-0");
    assert.equal(unknown.size, 101);
    assert.equal(unknown.get("(more kinds)"), 5);
    assert.equal(unknown.get("kind-0"), 2, "a kind kept by name goes on being counted");
    const seen = new Set<string>();
    for (let i = 0; i <= 100_000; i++) remember(seen, `id-${i}`);
    assert.equal(seen.size, 100_000);
    assert.ok(!seen.has("id-0") && seen.has("id-100000"), "the oldest is forgotten");
  });
});

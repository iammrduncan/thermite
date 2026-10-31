import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { codexRollout } from "../../../../src/agents/programs/codex/rollout.ts";
import {
  newSessionTally,
  type SessionEvent,
  tallyEvents,
} from "../../../../src/agents/programs/session-log.ts";

/** The spike's recorded rollouts of Codex 0.162.1 (the folder's README says how). */
const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "session-logs",
  "codex-0.162.1",
);
const lines = (run: string) =>
  readFileSync(join(FIXTURES, run, "rollout.jsonl"), "utf8").split("\n");

function read(input: string[]) {
  const s = codexRollout.newState();
  const events = codexRollout.read(input, s);
  const tally = newSessionTally();
  tallyEvents(tally, events, codexRollout.turns);
  return { events, tally, unknown: codexRollout.unknown(s) };
}
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const ends = (events: SessionEvent[]) => of(events, "turn.ended").map((e) => e.reason);
const users = (events: SessionEvent[]) => of(events, "user").map((e) => `${e.origin}: ${e.text}`);

describe("the Codex CLI's rollout as session events", () => {
  test("turns, tools, text typed mid-turn, an interrupt and a usage limit", () => {
    const { events, tally, unknown } = read(lines("codex-tui"));
    assert.deepEqual([...unknown], [], "every kind of record is read or left out on purpose");
    assert.deepEqual(
      of(events, "turn.started").map((e) => e.turnId?.slice(-6)),
      ["3ada41", "fbb193", "53a7ca", "d270b3"],
    );
    assert.deepEqual(ends(events), ["done", "done", "interrupted", "limit"]);
    assert.deepEqual(users(events), [
      "prompt: SPIKE-1: please read notes.txt, then run the slow command, then reply.",
      "steer: STEER-1: when you reply, also mention bananas.",
      "prompt: SPIKE-2: run pwd please.",
      "prompt: SPIKE-3: run the very slow command.",
      "prompt: SPIKE-4: this call hits the usage limit.",
    ]);
    // The interrupted command's output came before any word of how it ended; the command itself
    // ran on and ended after the turn, which adds nothing.
    const results = of(events, "tool.result");
    assert.deepEqual(
      results.map((r) => [r.id, r.ok]),
      [
        ["call_1", true],
        ["call_3", true],
        ["call_6", true],
        ["call_9", undefined],
      ],
    );
    assert.deepEqual(of(events, "limit"), [
      { type: "limit", message: "You’ve hit your usage limit. Try again at 5:53 AM." },
    ]);
    // Each response's usage once: six responses, though their totals come again in token counts.
    assert.equal(of(events, "usage").length, 6);
    assert.equal(tally.tokensIn, 6035);
    assert.equal(tally.tokensOut, 120);
    assert.equal(tally.turns, 10, "each message and each tool call is one");
    assert.equal(tally.toolCalls, 4);
    assert.equal(tally.session, "01a18637-54e9-7663-af0e-f5a1a428bc98");
    assert.equal(tally.lastText, "Step 1 of SPIKE-3.");
  });

  test("a message queued for the next turn; a killed thread resumed in the same rollout", () => {
    const input = lines("codex-resume");
    const { events, tally, unknown } = read(input);
    assert.deepEqual([...unknown], []);
    assert.deepEqual(ends(events), ["done", "done", "done"]);
    assert.deepEqual(
      users(events).map((u) => u.split(":")[0]),
      ["prompt", "prompt", "prompt"],
      "a queued message opens the next turn",
    );
    assert.equal(of(events, "session").length, 1);
    assert.equal(tally.tokensIn, 5025, "the thread's totals at its end");
    // Followed a line at a time, it gives the same events as read whole.
    const s = codexRollout.newState();
    assert.deepEqual(
      input.flatMap((l) => codexRollout.read([l], s)),
      events,
    );
  });

  test("a Stop hook that blocks sends the turn on; its words are the user's side", () => {
    const { events, unknown } = read(lines("codex-hooks"));
    assert.deepEqual([...unknown], []);
    assert.deepEqual(ends(events), ["done"]);
    assert.deepEqual(users(events), [
      "prompt: SPIKE-2: run pwd please.",
      "hook: SPIKE-5: before you stop, run date (this came from the Stop hook).",
    ]);
  });

  test("a usage record seen twice counts once, and a kind it does not know is counted", () => {
    const usage =
      '{"timestamp":"2026-10-29T05:52:16.107Z","type":"token_usage_record","payload":{"response_id":"resp_1","usage":{"input_tokens":10,"output_tokens":2}}}';
    const { events, unknown } = read([
      usage,
      usage,
      '{"timestamp":"2026-10-29T05:52:16.107Z","type":"brand_new","payload":{}}',
      '{"timestamp":"2026-10-29T05:52:16.107Z","type":"event_msg","payload":{"type":"agent_reasoning_delta"}}',
      '{"timestamp":"2026-10-29T05:52:16.107Z","type":"response_item","payload":{"type":"message"}}',
      "[1, 2]",
    ]);
    assert.equal(of(events, "usage").length, 1);
    assert.deepEqual(Object.fromEntries(unknown), {
      brand_new: 1,
      "event_msg/agent_reasoning_delta": 1,
      "response_item/message (unreadable)": 1,
      "(not a record)": 1,
    });
  });
});

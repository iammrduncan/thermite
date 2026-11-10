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
    // The provider names the writes it made: its 0 is reported, not taken for not reported.
    assert.ok(tally.calls.every((c) => c.cache_write_in === 0));
    assert.equal(tally.turns, 10, "each message and each tool call is one");
    assert.equal(tally.toolCalls, 4);
    assert.equal(tally.session, "01a18637-54e9-7663-af0e-f5a1a428bc98");
    assert.equal(tally.lastText, "Step 1 of SPIKE-3.");
  });

  test("each response's cache write is read as it gives it (goal 195)", () => {
    const usage = (id: string, input: number, cached: number, wrote: number) =>
      JSON.stringify({
        timestamp: "2026-10-29T05:52:16.107Z",
        type: "token_usage_record",
        payload: {
          response_id: id,
          usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            cache_write_input_tokens: wrote,
            output_tokens: 2,
          },
        },
      });
    const { tally } = read([usage("resp_1", 100, 40, 10), usage("resp_2", 300, 100, 30)]);
    assert.deepEqual(
      tally.calls.map((c) => [c.tokens_in, c.cached_in, c.cache_write_in]),
      [
        [100, 40, 10],
        [300, 100, 30],
      ],
    );
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

  test("a web search, Codex's own and the provider's hosted one, as tool calls with their names (goal 232)", () => {
    const at = '"timestamp":"2026-11-08T08:30:00.000Z","type":"response_item"';
    const { events, tally, unknown } = read([
      `{${at},"payload":{"type":"function_call","name":"run","namespace":"web","arguments":"{\\"search_query\\":[{\\"q\\":\\"gb10 mmap slow\\"}]}","call_id":"call_w"}}`,
      `{${at},"payload":{"type":"function_call_output","call_id":"call_w","output":"1. Very slow mmap on DGX Spark"}}`,
      `{${at},"payload":{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"gb10 mmap slow"}}}`,
    ]);
    assert.deepEqual([...unknown], []);
    assert.deepEqual(
      of(events, "tool.call").map((e) => [e.name, e.input]),
      [
        ["web.run", { search_query: [{ q: "gb10 mmap slow" }] }],
        ["web_search", { type: "search", query: "gb10 mmap slow" }],
      ],
    );
    assert.deepEqual(
      tally.tools.map((t) => [t.tool, t.ok]),
      [
        ["web.run", true],
        ["web_search", true],
      ],
    );
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  newClaudeTally,
  readClaudeEvents,
} from "../../../../src/agents/programs/claude-code/events.ts";
import { claudeTranscript } from "../../../../src/agents/programs/claude-code/transcript.ts";
import {
  newSessionTally,
  type SessionEvent,
  tallyDifferences,
  tallyEvents,
} from "../../../../src/agents/programs/session-log.ts";

/** The spike's recorded transcripts of Claude Code 2.1.308 (the folder's README says how). */
const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "session-logs",
  "claude-code-2.1.308",
);
const lines = (run: string, file = "transcript.jsonl") =>
  readFileSync(join(FIXTURES, run, file), "utf8").split("\n");

/** A transcript read whole: its events, its tally, and the kinds the adapter did not know. */
function read(input: string[]) {
  const s = claudeTranscript.newState();
  const events = claudeTranscript.read(input, s);
  const tally = newSessionTally();
  tallyEvents(tally, events, claudeTranscript.turns);
  return { events, tally, unknown: claudeTranscript.unknown(s) };
}
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const ends = (events: SessionEvent[]) => of(events, "turn.ended").map((e) => e.reason);
const users = (events: SessionEvent[]) => of(events, "user").map((e) => `${e.origin}: ${e.text}`);

describe("Claude Code's transcript as session events", () => {
  test("the terminal UI: turns, tools, text typed mid-turn, and a usage limit with its reset", () => {
    const { events, tally, unknown } = read(lines("claude-tui"));
    assert.deepEqual([...unknown], [], "every kind of record is read or left out on purpose");
    assert.equal(of(events, "turn.started").length, 3);
    assert.deepEqual(ends(events), ["done", "done", "limit"]);
    assert.deepEqual(users(events), [
      "prompt: SPIKE-1: please read notes.txt, then run the slow command, then reply.",
      "steer: STEER-1: when you reply, also mention bananas.",
      "prompt: SPIKE-2: run pwd please.",
      "prompt: SPIKE-4: this call hits the usage limit.",
    ]);
    // The steer was taken in after the running tool, within the first turn.
    const steer = events.findIndex((e) => e.type === "user" && e.origin === "steer");
    const firstEnd = events.findIndex((e) => e.type === "turn.ended");
    assert.ok(steer > 0 && steer < firstEnd);
    assert.deepEqual(
      of(events, "tool.call").map((e) => e.name),
      ["Read", "Bash", "Bash"],
    );
    assert.ok(of(events, "tool.result").every((e) => e.ok === true));
    assert.deepEqual(of(events, "limit"), [
      {
        type: "limit",
        window: "five_hour",
        resetsAt: "2026-10-29T05:45:33.000Z",
        overage: "rejected",
        message: "You've hit your session limit · resets 5:45am (UTC)",
      },
    ]);
    assert.equal(tally.turns, 5, "each model reply is one turn; the limit's message is none");
    assert.equal(tally.toolCalls, 3);
    assert.equal(tally.tokensIn, 8022);
    assert.equal(tally.tokensOut, 100);
    assert.equal(tally.session, "627c3344-d65e-4da8-b679-a964da1cfb78");
    assert.match(tally.lastText, /^SPIKE-2 done/);
    assert.deepEqual(tally.errors, ["You've hit your session limit · resets 5:45am (UTC)"]);
    // Its totals at exit cover the title calls the transcript keeps out.
    const end = of(events, "session.end");
    assert.equal(end.length, 1, "two cost records in a row are one end");
    assert.ok((end[0]?.totals?.tokensIn ?? 0) > tally.tokensIn);
  });

  test("another session's messages, an interrupt, and the program going on after a usage reset", () => {
    const { events, tally, unknown } = read(lines("claude-inbox"));
    assert.deepEqual([...unknown], []);
    assert.deepEqual(
      users(events).map((u) => u.split(":")[0]),
      ["prompt", "peer", "peer", "prompt", "prompt", "auto"],
      "a socket message mid-turn steers; one while idle opens a turn; the reset's own prompt opens one",
    );
    assert.deepEqual(ends(events), ["done", "done", "interrupted", "limit", "done"]);
    const rejected = of(events, "tool.result").find((e) => e.id === "toolu_7");
    assert.equal(rejected?.ok, false, "the interrupted command's result");
    assert.equal(of(events, "limit")[0]?.resetsAt, "2026-10-29T05:49:38.000Z");
    assert.deepEqual(
      of(events, "queue").map((e) => e.op),
      ["enqueue", "deliver", "enqueue", "deliver", "enqueue", "deliver"],
    );
    assert.equal(tally.turns, 6);
    assert.equal(tally.toolCalls, 3);
  });

  test("a reply's usage counts once however many records repeat it; a resumed session goes on", () => {
    const input = lines("claude-resume");
    const replies = input.filter((l) => l.includes('"type":"assistant"')).length;
    const whole = read(input);
    assert.deepEqual([...whole.unknown], []);
    assert.equal(replies, 6, "six records of four replies");
    assert.equal(of(whole.events, "usage").length, 4);
    assert.equal(whole.tally.tokensIn, 4 * 1600 + 2 + 3 + 4 + 5);
    // Killed after the first turn, and resumed: the same file and session, two whole turns.
    assert.equal(of(whole.events, "session").length, 1);
    assert.deepEqual(ends(whole.events), ["done", "done"]);
    assert.equal(of(whole.events, "user").length, 2, "/exit and its output are the program's own");
    // Followed a line at a time, it gives the same events as read whole.
    const s = claudeTranscript.newState();
    const followed = input.flatMap((l) => claudeTranscript.read([l], s));
    assert.deepEqual(followed, whole.events);
  });

  test("a Stop hook that blocks sends the turn on; its words are the user's side", () => {
    const { events, unknown } = read(lines("claude-hooks"));
    assert.deepEqual([...unknown], []);
    assert.equal(of(events, "turn.started").length, 1);
    assert.deepEqual(ends(events), ["done"]);
    assert.deepEqual(users(events), [
      "prompt: SPIKE-2: run pwd please.",
      "hook: SPIKE-5: before you stop, run date (this came from the Stop hook).",
    ]);
    assert.equal(of(events, "tool.call").length, 2);
  });

  test("in -p, its tally equals the stream-json reader's for the same run", () => {
    const fromLog = read(lines("claude-print"));
    assert.deepEqual([...fromLog.unknown], []);
    const stream = newClaudeTally();
    readClaudeEvents(lines("claude-print", "stream.jsonl"), stream);
    assert.deepEqual(tallyDifferences(stream, fromLog.tally), {});
    assert.equal(fromLog.tally.turns, 2);
    // The stream gives the run's usage once; the transcript each call's: the same sums.
    const sum = (calls: { tokens_in: number; cached_in: number | null; tokens_out: number }[]) => [
      calls.reduce((n, c) => n + c.tokens_in, 0),
      calls.reduce((n, c) => n + (c.cached_in ?? 0), 0),
      calls.reduce((n, c) => n + c.tokens_out, 0),
    ];
    assert.deepEqual(sum(fromLog.tally.calls), sum(stream.calls));
    assert.equal(stream.calls[0]?.calls, fromLog.tally.calls.length);
    // With no Stop hook, -p writes no turn's end: its clean exit ends the turn.
    const noHooks = read(lines("claude-print").filter((l) => !l.includes("stop_hook_summary")));
    assert.deepEqual(ends(noHooks.events), ["done"]);
    assert.equal(noHooks.events.at(-1)?.type, "session.end");
  });

  test("a kind it does not know is counted, as is a record it cannot read", () => {
    const { events, unknown } = read([
      '{"type":"brand-new-kind","sessionId":"s-1"}',
      '{"type":"system","subtype":"api_retry"}',
      '{"type":"assistant","timestamp":"2026-10-29T05:42:06.427Z"}',
      '{"type":"user","origin":{"kind":"scheduled"},"message":{"content":"run it"}}',
      "not JSON",
      "",
    ]);
    assert.deepEqual(Object.fromEntries(unknown), {
      "brand-new-kind": 1,
      "system/api_retry": 1,
      "assistant (unreadable)": 1,
      "user/origin:scheduled": 1,
      "(not a record)": 1,
    });
    assert.deepEqual(users(events), ["prompt: run it"]);
  });

  test("a compaction's boundary is an event, with its tokens", () => {
    const { events, unknown } = read([
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":151000}}',
      '{"type":"user","isCompactSummary":true,"message":{"content":"The summary."}}',
    ]);
    assert.deepEqual([...unknown], []);
    assert.deepEqual(events, [{ type: "compaction", tokensBefore: 151000 }]);
  });
});

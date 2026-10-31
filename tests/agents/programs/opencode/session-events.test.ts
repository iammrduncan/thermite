import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { opencodeSession } from "../../../../src/agents/programs/opencode/session-events.ts";
import {
  newSessionTally,
  type SessionEvent,
  tallyDifferences,
  tallyEvents,
} from "../../../../src/agents/programs/session-log.ts";

/** The spike's recorded events and messages of OpenCode 2.1.4 (the folder's README says how). */
const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "session-logs",
  "opencode-2.1.4",
);
const lines = (file: string) => readFileSync(join(FIXTURES, file), "utf8").split("\n");
/** The messages route's records, oldest first, one a line. */
const messages = () =>
  (
    JSON.parse(readFileSync(join(FIXTURES, "opencode-tui", "messages.json"), "utf8"))
      .data as unknown[]
  )
    .reverse()
    .map((m) => JSON.stringify(m));

function read(...batches: string[][]) {
  const s = opencodeSession.newState();
  const events = batches.flatMap((b) => opencodeSession.read(b, s));
  const tally = newSessionTally();
  tallyEvents(tally, events, opencodeSession.turns);
  return { events, tally, unknown: opencodeSession.unknown(s) };
}
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const ends = (events: SessionEvent[]) => of(events, "turn.ended").map((e) => e.reason);
const users = (events: SessionEvent[]) => of(events, "user").map((e) => `${e.origin}: ${e.text}`);

describe("OpenCode's events and messages as session events", () => {
  test("its events: turns, tools, the queue and steers, and a usage limit with when to retry", () => {
    const { events, tally, unknown } = read(lines("opencode-tui/events.jsonl"));
    assert.deepEqual([...unknown], [], "every kind of event is read or left out on purpose");
    // The fourth execution is OpenCode's own, run empty after the failed one.
    assert.deepEqual(ends(events), ["done", "done", "limit", "done"]);
    assert.deepEqual(users(events), [
      "prompt: SPIKE-1: please read notes.txt, then run the slow command, then reply.",
      "steer: STEER-1: when you reply, also mention bananas.",
      "queued: SPIKE-2: run pwd please (sent through the server, queued while idle).",
      "steer: STEER-2 through the server, mid-turn.",
      "prompt: SPIKE-3: run the very slow command.",
      "steer: SPIKE-4: this call hits the usage limit.",
    ]);
    assert.deepEqual(
      of(events, "tool.call").map((e) => e.name),
      ["read", "shell", "shell", "shell"],
    );
    assert.deepEqual(of(events, "limit"), [
      {
        type: "limit",
        resetsAt: "2026-10-29T06:00:10.610Z",
        message: "Rate limit reached; usage limit reached",
      },
    ]);
    // One usage for each step that made its call: six; the failed one made none.
    assert.equal(of(events, "usage").length, 6);
    assert.equal(tally.turns, 6);
    assert.equal(tally.tokensIn, 6 * 1000 + 2 + 3 + 4 + 5 + 6 + 7, "the cache read counted in");
    assert.equal(tally.tokensOut, 120);
    assert.equal(tally.session, "ses_e79c34251ffe8jn1HPJo00zVK3");
  });

  test("an interrupt fails the running tool and the turn; the step still made its call", () => {
    const { events, tally, unknown } = read(lines("opencode-interrupt/events.jsonl"));
    assert.deepEqual([...unknown], []);
    assert.deepEqual(ends(events), ["interrupted"]);
    assert.deepEqual(
      of(events, "tool.result").map((e) => [e.ok, e.output]),
      [[false, "Tool execution interrupted"]],
    );
    assert.equal(tally.calls.length, 1);
  });

  test("its messages alone give the same tally as its events", () => {
    const fromEvents = read(lines("opencode-tui/events.jsonl"));
    const fromMessages = read(messages());
    assert.deepEqual([...fromMessages.unknown], []);
    // The messages name no session: the caller asked for them by its id.
    assert.deepEqual(tallyDifferences(fromEvents.tally, fromMessages.tally), {
      session: { output: "ses_e79c34251ffe8jn1HPJo00zVK3", log: null },
    });
    assert.deepEqual(ends(fromMessages.events), ["done", "done", "limit"]);
  });

  test("a stream joined late: the messages first, then the stream, give each step's usage once", () => {
    const sse = lines("opencode-tui/api-event.sse");
    assert.ok(sse.some((l) => l.startsWith(": heartbeat")));
    const late = read(sse);
    assert.deepEqual([...late.unknown], []);
    assert.equal(of(late.events, "turn.started").length, 3, "the first turn began before it");
    const caught = read(messages(), sse);
    assert.deepEqual([...caught.unknown], []);
    assert.equal(of(caught.events, "usage").length, 6);
    assert.equal(of(caught.events, "turn.started").length, 3);
    assert.equal(of(caught.events, "assistant.text").length, 6);
    // The plugin's events after the messages: nothing is given twice.
    const both = read(messages(), lines("opencode-tui/events.jsonl"));
    assert.equal(of(both.events, "usage").length, 6);
    assert.equal(of(both.events, "tool.result").length, 4);
  });

  test("another session's events are left out, and a kind it does not know is counted", () => {
    const { events, unknown } = read([
      'data: {"type":"session.created","created":1,"data":{"sessionID":"ses_a"}}',
      'data: {"type":"session.execution.started","created":2,"data":{"sessionID":"ses_b"}}',
      '{"type":"permission.asked","created":3,"data":{"sessionID":"ses_a"}}',
      '{"type":"session.step.ended","created":4,"data":{"sessionID":"ses_a"}}',
      '{"id":"m1","type":"patch","time":{"created":5}}',
      "event: message",
      "not JSON",
    ]);
    assert.deepEqual(events, [{ type: "session", id: "ses_a" }]);
    assert.deepEqual(Object.fromEntries(unknown), {
      "permission.asked": 1,
      "session.step.ended (unreadable)": 1,
      "message/patch": 1,
      "(not a record)": 1,
    });
  });
});

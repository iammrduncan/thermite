import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { linkSession } from "../../src/agents/live-session.ts";

type Listener = (event: Record<string, unknown>, signal: AbortSignal) => Promise<void> | void;

/** A stand-in for a Pi agent: the test plays its loop's events; steered turns are kept. */
function standIn() {
  const listeners: Listener[] = [];
  const steered: { role: string; content: string }[] = [];
  const agent = {
    subscribe: (l: Listener) => {
      listeners.push(l);
      return () => undefined;
    },
    steer: (m: { role: string; content: string }) => steered.push(m),
  } as unknown as Agent;
  const emit = async (event: Record<string, unknown>, signal = new AbortController().signal) => {
    for (const l of listeners) await l(event, signal);
  };
  return { agent, steered, emit };
}

const turnEnd = (stopReason = "toolUse") => ({
  type: "turn_end",
  message: { role: "assistant", stopReason, content: [] },
  toolResults: [],
});

describe("a Pi session's link to the owner's messages", () => {
  test("a waiting message is steered at a turn's end and read only when it enters the conversation, once", async () => {
    const s = standIn();
    let waiting = [{ id: 4, text: "try the closed form" }];
    let fetched = 0;
    const reads: number[][] = [];
    linkSession(s.agent, {
      messages: async () => {
        fetched++;
        return waiting;
      },
      read: async (ids) => {
        reads.push(ids);
        waiting = waiting.filter((m) => !ids.includes(m.id));
      },
    });
    await s.emit(turnEnd());
    assert.equal(s.steered.length, 1);
    assert.match(String(s.steered[0]?.content), /campaign's owner.*\n\ntry the closed form/s);
    assert.deepEqual(reads, [], "fetched and steered is not yet read");
    // The next turn ends before the agent took it (one steered turn at a time): not steered again.
    await s.emit(turnEnd());
    assert.equal(s.steered.length, 1);
    // The loop takes it into the conversation for the next model call: now it is read.
    await s.emit({ type: "message_end", message: s.steered[0] });
    assert.deepEqual(reads, [[4]]);
    assert.equal(fetched, 2);
  });

  test("on a turn a time or turn limit stops, nothing is fetched or given, and a steered message the stop overtakes is not read", async () => {
    const s = standIn();
    const reads: number[][] = [];
    let fetched = 0;
    const stop = new AbortController();
    let slow: (() => void) | undefined;
    linkSession(s.agent, {
      messages: async () => {
        fetched++;
        if (fetched === 2) await new Promise<void>((r) => (slow = r));
        return [{ id: 9, text: "in time?" }];
      },
      read: async (ids) => {
        reads.push(ids);
      },
    });
    // A stopped run: its last turn ends aborted, or after the limit fired.
    await s.emit(turnEnd("aborted"));
    await s.emit(turnEnd("error"));
    stop.abort();
    await s.emit(turnEnd(), stop.signal);
    assert.equal(fetched, 0, "nothing fetched for a turn that has no next model call");
    // The limit fires while the messages are being fetched: they are not steered.
    const live = new AbortController();
    await s.emit(turnEnd(), live.signal); // fetch 1: steered
    assert.equal(s.steered.length, 1);
    const pending = s.emit(turnEnd(), live.signal); // fetch 2 hangs
    await new Promise((r) => setTimeout(r, 10));
    live.abort();
    slow?.();
    await pending;
    assert.equal(s.steered.length, 1, "nothing steered after the stop");
    // The steered message enters the conversation only as the stop overtakes it: not read.
    await s.emit({ type: "message_end", message: s.steered[0] }, live.signal);
    assert.deepEqual(reads, [], "a message the agent never answered stays waiting");
  });

  test("a long reply reaches Live cut and marked; a line the harness refuses is logged once (goal 171)", async (t) => {
    const s = standIn();
    const lines: { kind: string; text: string }[] = [];
    let refuse = false;
    linkSession(s.agent, {
      // As the trial API: a line over 8,000 characters is refused.
      live: async (entries) => {
        if (refuse || entries.some((e) => e.text.length > 8000)) throw new Error("400 refused");
        lines.push(...entries);
      },
    });
    const reply = (text: string) => ({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
    });
    await s.emit(reply("x".repeat(20_000)));
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.text.length, 7996);
    assert.match(lines[0]?.text ?? "", /x \[cut\]$/);
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    refuse = true;
    await s.emit(reply("one"));
    await s.emit(reply("two"));
    await new Promise((r) => setImmediate(r));
    t.mock.restoreAll();
    assert.equal(said.filter((l) => l.includes("a live line was not taken")).length, 1);
    assert.match(said[0] ?? "", /"error":"Error: 400 refused"/);
  });
});

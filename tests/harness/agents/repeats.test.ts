import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { linkSession, REPLY_REPORT_MS, type ReplyNow } from "../../../src/agents/live-session.ts";
import {
  GUARD_MAX,
  guardRepeats,
  RepeatGuard,
  SAME_ANSWER,
  sameAnswer,
} from "../../../src/harness/agents/repeats.ts";

/**
 * Goal 143, item 2: a Pi worker that repeats the same tool call gets a short answer for each
 * copy, so its conversation doesn't fill up. On the lab one model reply held the same 13 calls
 * (11 different) at least 74 times.
 */

const text = (t: string) => ({ content: [{ type: "text", text: t }], details: {} });
const said = (a: { content?: unknown }) => (a.content as { text: string }[])[0]?.text ?? "";

/** The lab's 13 calls: search_files on three sources, two of them twice in each round. */
const LAB = [
  ["s-461c", "blockage"],
  ["s-91d2", "gen_blockage"],
  ["s-91d2", "Do not schedule instructions accessing memory across this point"],
  ["s-91d2", "memory_blockage"],
  ["s-91d2", "blockage"],
  ["s-745a", "sfence"],
  ["s-745a", "memory"],
  ["s-461c", "memory"],
  ["s-461c", "barrier"],
  ["s-461c", "asm"],
  ["s-461c", "blockage"],
  ["s-91d2", "gen_blockage"],
  ["s-461c", "gen_memory_blockage"],
].map(([source, words]) => ({ path: `sources/${source}.txt`, text: words }));

describe("a Pi worker's repeated calls get a short answer (goal 143)", () => {
  test("the lab's reply: 74 copies of 13 calls give each of the 11 different calls in full, once", () => {
    const g = new RepeatGuard({ clock: () => new Date("2026-10-25T19:04:13.000Z") });
    let full = 0;
    let short = 0;
    for (let round = 0; round < 74; round++)
      for (const p of LAB) {
        const a = g.answer("search_files", p, text(`lines of ${p.path} with ${p.text}`));
        if (said(a).startsWith(SAME_ANSWER)) short++;
        else full++;
      }
    assert.equal(full, 11);
    assert.equal(short, 74 * 13 - 11);
    // A copy names when and which call gave the answer in full.
    const a = g.answer("search_files", LAB[1], text(`lines of ${LAB[1]?.path} with gen_blockage`));
    assert.equal(
      said(a),
      "Same call and same answer as at 19:04:13 UTC (call 2). Its answer is above. Change what you ask, or go on.",
    );
  });

  test("the same arguments in another order are the same call; a changed answer is given in full", () => {
    const g = new RepeatGuard();
    g.answer("read_file", { path: "a.md", offset: 0 }, text("v1"));
    assert.match(
      said(g.answer("read_file", { offset: 0, path: "a.md" }, text("v1"))),
      /^Same call/,
    );
    assert.equal(said(g.answer("read_file", { path: "a.md", offset: 0 }, text("v2"))), "v2");
    // The answer it now holds is v2: v2 again is a repeat, v1 is new again.
    assert.match(
      said(g.answer("read_file", { path: "a.md", offset: 0 }, text("v2"))),
      /^Same call/,
    );
    assert.equal(said(g.answer("read_file", { path: "a.md", offset: 0 }, text("v1"))), "v1");
    // Another tool with the same arguments is another call.
    assert.equal(said(g.answer("list_files", { path: "a.md", offset: 0 }, text("v1"))), "v1");
  });

  test("after a compaction the full answer comes back", () => {
    let compactions = 0;
    const g = new RepeatGuard({ compactions: () => compactions });
    g.answer("progress", {}, text("12 claims"));
    assert.match(said(g.answer("progress", {}, text("12 claims"))), /^Same call/);
    compactions = 1;
    assert.equal(said(g.answer("progress", {}, text("12 claims"))), "12 claims");
    assert.match(said(g.answer("progress", {}, text("12 claims"))), /^Same call/);
  });

  test(`it remembers at most ${GUARD_MAX} answers, the oldest out first`, () => {
    const g = new RepeatGuard();
    for (let i = 0; i <= GUARD_MAX; i++) g.answer("read_source", { source: `s-${i}` }, text("x"));
    assert.equal(said(g.answer("read_source", { source: "s-0" }, text("x"))), "x");
    assert.match(said(g.answer("read_source", { source: `s-${GUARD_MAX}` }, text("x"))), /^Same/);
  });

  test("guardRepeats wraps every tool; a tool that fails throws as before", async () => {
    let n = 0;
    const tools = guardRepeats(
      [
        {
          name: "progress",
          label: "progress",
          description: "",
          parameters: Type.Object({}),
          execute: async () => {
            n++;
            return text("same");
          },
        } as AgentTool,
        {
          name: "fetch",
          label: "fetch",
          description: "",
          parameters: Type.Object({ url: Type.String() }),
          execute: async () => {
            throw new Error("refused");
          },
        } as AgentTool,
      ],
      () => 0,
    );
    const [progress, fetch] = tools as [AgentTool, AgentTool];
    assert.equal(said(await progress.execute("c1", {} as never)), "same");
    assert.match(said(await progress.execute("c2", {} as never)), /^Same call/);
    assert.equal(n, 2, "the call still runs, to see whether its answer changed");
    await assert.rejects(fetch.execute("c3", { url: "u" } as never), /refused/);
    await assert.rejects(fetch.execute("c4", { url: "u" } as never), /refused/);
    assert.match(sameAnswer("2026-10-25T19:04:13.512Z", 3), /at 19:04:13 UTC \(call 3\)/);
    // A short answer keeps what else the answer carries: a call that ends the trial still does.
    const g = new RepeatGuard();
    const end = { ...text("submitted"), terminate: true };
    g.answer("submit", { hypothesis: "h" }, end);
    const again = g.answer("submit", { hypothesis: "h" }, end);
    assert.match(said(again), /^Same call/);
    assert.equal(again.terminate, true);
  });
});

type Listener = (event: Record<string, unknown>, signal: AbortSignal) => Promise<void> | void;

describe("a Pi worker reports its open model call (goal 143)", () => {
  test(`every ${REPLY_REPORT_MS / 1000} s while a reply is open, with what it sent so far, and null at its end`, async (t) => {
    t.mock.timers.enable({
      apis: ["setInterval", "Date"],
      now: Date.parse("2026-10-25T15:09:00Z"),
    });
    const listeners: Listener[] = [];
    const agent = {
      subscribe: (l: Listener) => {
        listeners.push(l);
        return () => undefined;
      },
      steer: () => undefined,
    } as never;
    const emit = async (event: Record<string, unknown>) => {
      for (const l of listeners) await l(event, new AbortController().signal);
    };
    const reports: (ReplyNow | null)[] = [];
    linkSession(agent, { reply: async (r) => reports.push(r) });
    const delta = (type: string, d: string) =>
      emit({ type: "message_update", assistantMessageEvent: { type, delta: d } });

    // A short reply is never reported.
    await emit({ type: "turn_start" });
    await delta("text_delta", "ok");
    await emit({ type: "message_end", message: { role: "assistant", content: [] } });
    t.mock.timers.tick(REPLY_REPORT_MS * 3);
    assert.deepEqual(reports, []);

    // A long one: a report every 30 s, with the characters so far, then null at its end.
    await emit({ type: "turn_start" });
    await delta("thinking_delta", "abc");
    t.mock.timers.tick(REPLY_REPORT_MS);
    await delta("toolcall_delta", "x".repeat(1000));
    await delta("text_delta", "hi");
    t.mock.timers.tick(REPLY_REPORT_MS);
    await emit({ type: "message_end", message: { role: "assistant", content: [] } });
    t.mock.timers.tick(REPLY_REPORT_MS * 2);
    assert.deepEqual(reports, [
      { since: "2026-10-25T15:10:30.000Z", text: 0, thinking: 3, tool_args: 0 },
      { since: "2026-10-25T15:10:30.000Z", text: 2, thinking: 3, tool_args: 1000 },
      null,
    ]);
  });
});

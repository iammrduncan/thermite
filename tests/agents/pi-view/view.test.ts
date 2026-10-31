import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import xterm from "@xterm/headless";
import { mcpWords, PiView, type ViewCounts, viewText } from "../../../src/agents/pi-view/index.ts";

/**
 * The Pi view's screen (goal 169): a scripted agent's events drawn with pi-tui into a headless
 * terminal, read back as plain lines. What the model and the tools wrote is drawn as text only:
 * their escape sequences never reach the terminal, and the view sends no link, image or clipboard
 * write of its own.
 */

/** A stand-in agent: the view only subscribes to its events. */
function agent() {
  const listeners: ((e: AgentEvent) => void)[] = [];
  return {
    emit: (e: unknown) => {
      for (const l of listeners) l(e as AgentEvent);
    },
    agent: {
      subscribe: (l: (e: AgentEvent) => void) => {
        listeners.push(l);
        return () => undefined;
      },
    } as unknown as Agent,
  };
}

/** A view drawn into a headless terminal: what was written to it, and its lines. */
function drawn(counts?: () => ViewCounts) {
  const term = new xterm.Terminal({
    cols: 100,
    rows: 40,
    scrollback: 2000,
    allowProposedApi: true,
  });
  const out: string[] = [];
  const view = new PiView({
    out: (d) => {
      out.push(d);
      term.write(d);
    },
    cols: 100,
    rows: 40,
    heading: "Thermite's view of a worker in Pi · trial t-1 · lane-1 · scripted",
  });
  view.start();
  const a = agent();
  view.attach(a.agent, counts ?? (() => status()));
  const lines = async () => {
    view.flush();
    await new Promise<void>((r) => term.write("", r));
    const b = term.buffer.active;
    const all: string[] = [];
    for (let i = 0; i < b.length; i++) all.push(b.getLine(i)?.translateToString(true) ?? "");
    return all.join("\n");
  };
  return { view, emit: a.emit, out, lines };
}

const status = (more: Partial<ViewCounts> = {}): ViewCounts => ({
  turns: 3,
  toolCalls: 5,
  tokensIn: 12_345,
  tokensOut: 678,
  compactions: 0,
  msLeft: 14 * 60_000 + 1,
  model: "scripted",
  ...more,
});

describe("the Pi view's screen", () => {
  test("it draws the trial's replies, thinking, tools, later turns and a status line from its counts", async () => {
    const v = drawn();
    v.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "You are a worker.\nYour brief." }],
      },
    });
    v.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "one\ntwo\nthree\nfour\nfive" },
          { type: "text", text: "# Plan\n\n- read the **kernel**\n- change the loop" },
        ],
      },
    });
    v.emit({ type: "tool_execution_start", toolName: "read_file", args: { path: "src/k.c" } });
    v.emit({
      type: "tool_execution_end",
      toolName: "read_file",
      isError: false,
      result: {
        content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6" }],
      },
    });
    v.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "You have not called submit yet." }],
      },
    });
    v.view.waiting({ until: "2026-10-30T15:45:00.000Z", kind: "rate_limit", words: "429" });
    const screen = await v.lines();
    assert.match(screen, /Thermite's view of a worker in Pi · trial t-1/);
    assert.match(screen, /it is not Pi's program/);
    assert.match(screen, /the first message:\s+You are a worker\.\s+Your brief\./);
    assert.match(screen, /one\s+two\s+three\s+… \(2 more lines\)/, "thinking, folded");
    assert.match(screen, /Plan/);
    assert.match(screen, /• read the kernel|- read the kernel/);
    assert.match(screen, /▸ read_file \{"path":"src\/k\.c"\}/);
    assert.match(screen, /↳ line 1\s+line 2\s+line 3\s+line 4\s+… \(2 more lines\)/);
    assert.match(screen, /→ You have not called submit yet\./);
    assert.match(screen, /◷ waiting for the provider until 15:45 UTC \(rate_limit\): 429/);
    assert.match(
      screen,
      /turn 3 · 5 tool calls · 12,345 tokens in, 678 out ·\s+15 min left/,
      "the status line",
    );
    v.view.finish("wall");
    assert.match(await v.lines(), /■ ended: wall/);
    v.view.stop();
  });

  test("what the model and its tools wrote reaches the terminal as text: no escape sequence of theirs", async () => {
    const v = drawn();
    const hostile =
      "plain\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b]52;c;cHduZWQ=\x07 \x1b_Gf=100;AAAA\x1b\\ \x1b[2J\u009b31m end";
    v.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: hostile }],
      },
    });
    v.emit({
      type: "tool_execution_start",
      toolName: "run\x1b[31m",
      args: { command: "x\x1b[2J" },
    });
    v.emit({
      type: "tool_execution_end",
      toolName: "run",
      isError: true,
      result: { content: [{ type: "text", text: "boom\x1b]0;title\x07" }] },
    });
    v.view.note("a note\x1b[5m with a blink");
    const screen = await v.lines();
    assert.match(screen, /plain\]8;;https:\/\/example\.comlink\]8;;/);
    assert.match(screen, /↳ failed: boom\]0;title/);
    const written = v.out.join("");
    for (const seq of [
      "\x1b]52;",
      "\x1b_G",
      "\x1b]0;",
      "\x1b[5m",
      "\u009b",
      "https://example.com\x07",
    ])
      assert.ok(!written.includes(seq), JSON.stringify(seq));
    // The view's own sequences: SGR, cursor moves and synchronized output, and pi-tui's style
    // reset, which closes a link (OSC 8 with no address) and never opens one.
    const own = new Set(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it finds.
      written.match(/\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|_|P)/g) ?? [],
    );
    for (const seq of own)
      assert.ok(seq.startsWith("\x1b[") || seq === "\x1b]8;;\x07", JSON.stringify(seq));
    v.view.stop();
  });

  test("a line too wide or a failing drawing stops nothing but the drawing", async () => {
    const v = drawn(() => {
      throw new Error("counts unavailable");
    });
    v.emit({ type: "turn_end", message: { role: "assistant" } });
    v.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: `${"w".repeat(5000)}` }],
      },
    });
    await v.lines();
    v.view.stop();
  });

  test("text helpers: control characters out, tabs as spaces, long texts cut and said", () => {
    assert.equal(viewText("a\tb\x1b[1mc\u0085d\r\ne"), "a  b[1mcd\ne");
    assert.equal(viewText("abcdef", 3), "abc\n… (3 more characters)");
    assert.equal(mcpWords(undefined, []), "this run's kit gives its workers no MCP servers");
    assert.equal(
      mcpWords(
        {
          tools: [
            { server: "docs", name: "search", description: "", input_schema: {}, reads: true },
          ],
          unavailable: [{ server: "db", why: "it did not answer" }],
          call: async () => ({ content: [] }),
        },
        ["docs", "db"],
      ),
      "the MCP tools of this trial:\ndocs: 1 tools: search\ndb: no tools (it did not answer)",
    );
  });
});

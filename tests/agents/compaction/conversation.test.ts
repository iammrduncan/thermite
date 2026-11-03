import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keptLine } from "../../../src/agents/compaction/cli.ts";
import {
  claudeBefore,
  claudeCompactions,
  claudeOwn,
  claudeSummary,
  claudeTokensBefore,
  claudeTranscriptMarkdown,
  codexBefore,
  codexOwn,
  codexRolloutMarkdown,
  findCodexRollout,
  opencodeEnded,
  opencodeOwn,
  opencodeSessionMarkdown,
  readUnder,
} from "../../../src/agents/compaction/conversation.ts";
import {
  claudePostCompact,
  claudePreCompact,
  type Settle,
} from "../../../src/agents/programs/claude-code/compaction-hook.ts";
import {
  CLAUDE_HOOK,
  claudeArgs,
  claudeHookSettings,
} from "../../../src/agents/programs/claude-code/index.ts";
import {
  type OpencodeCompaction,
  thermitePlugin,
} from "../../../src/agents/programs/opencode/plugin.ts";

/**
 * The conversations Claude Code, the Codex CLI and OpenCode keep of their own (goal 070), as
 * Thermite reads them, and the programs that keep them before each compaction: Claude Code's
 * PreCompact hook and Thermite's OpenCode plugin. The stand-in files are shaped as the pinned
 * versions write them (Claude Code 2.1.305's transcript, Codex 0.162.1's rollout, OpenCode
 * 2.0.32's session messages), trimmed; no real data.
 */

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `thermite-${name}-`));
const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

/** A Claude Code transcript with one compaction. */
const CLAUDE = [
  {
    type: "user",
    sessionId: "s-1",
    uuid: "u1",
    message: { role: "user", content: "Make the kernel faster." },
  },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "thinking", thinking: "Profile first." }],
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make bench" } }],
    },
  },
  {
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "12.5 ms", is_error: false }],
    },
  },
  { type: "file-history-snapshot", snapshot: {} },
  {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    compactMetadata: { trigger: "auto", preTokens: 160_512 },
  },
  {
    type: "user",
    isCompactSummary: true,
    message: {
      role: "user",
      content: "The kernel takes 12.5 ms. The whole conversation is in /r/compactions/t-1-1.md.",
    },
  },
  { type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "Going on." }] } },
];

/** A Codex rollout with two compactions. */
const CODEX = [
  {
    timestamp: "2026-10-21T00:00:00Z",
    type: "session_meta",
    payload: { id: "0199a213", cwd: "/w" },
  },
  {
    timestamp: "2026-10-21T00:00:01Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Sandbox notes." }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Make it faster." }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Profile first." }],
      encrypted_content: "gAAAA",
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      arguments: '{"command":["make"]}',
      call_id: "call_1",
    },
  },
  {
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_1", output: "built" },
  },
  { type: "event_msg", payload: { type: "token_count" } },
  { type: "compacted", payload: { message: "Summary one.", replacement_history: [] } },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "After the first." }],
    },
  },
  { type: "compacted", payload: { message: "Summary two." } },
];

/** OpenCode's session as Thermite's plugin kept it before two compactions. */
const OPENCODE = [
  {
    session: "ses_1",
    messages: [
      { type: "user", id: "msg_1", text: "Make it faster." },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "Profile." },
          { type: "text", text: "Running the benchmark." },
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "make" },
              content: [{ type: "text", text: "built" }],
            },
          },
        ],
      },
      { type: "agent-selected", agent: "build" },
    ],
  },
  {
    session: "ses_1",
    messages: [
      {
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "## Objective\n- faster",
        recent: "user: make it faster",
      },
      { type: "assistant", content: [{ type: "text", text: "Going on." }] },
    ],
  },
];

describe("a CLI's own conversation, as Markdown (goal 070)", () => {
  test("Claude Code's transcript: every message, tool call and result, the earlier compaction and its summary", () => {
    const md = claudeTranscriptMarkdown("Trial t-1 (lane-1)", 2, jsonl(CLAUDE));
    assert.match(md, /^# Trial t-1 \(lane-1\): the conversation before compaction 2\n/);
    assert.match(md, /from Claude Code's own transcript of the session/);
    // One reply in two lines is one section; the tool's result names its tool.
    assert.match(
      md,
      /## 2\. Assistant\n\nThinking:\n\n```text\nProfile first\.\n```\n\nTool call `Bash` \(tu_1\):/,
    );
    assert.match(md, /"command": "make bench"/);
    assert.match(md, /## 3\. Tool result: Bash \(tu_1\)\n\n```text\n12\.5 ms\n```/);
    assert.match(md, /## 4\. Claude Code compacted the conversation here, at about 160,512 tokens/);
    assert.match(
      md,
      /## 5\. The summary Claude Code went on from\n\n```text\nThe kernel takes 12\.5 ms/,
    );
    assert.match(md, /## 6\. Assistant\n\n```text\nGoing on\.\n```/);
    assert.doesNotMatch(md, /file-history-snapshot/);
    assert.equal(claudeCompactions(jsonl(CLAUDE)), 1);
    assert.match(claudeSummary(jsonl(CLAUDE), 1) ?? "", /t-1-1\.md/);
    assert.equal(claudeSummary(jsonl(CLAUDE), 2), undefined);
    assert.equal(claudeTokensBefore(jsonl(CLAUDE), 1), 160_512);
    // Up to its first compaction: the four messages before the boundary.
    const before = claudeBefore(jsonl(CLAUDE), 1);
    assert.equal(before.trim().split("\n").length, 5);
    assert.doesNotMatch(before, /compact_boundary/);
  });

  test("Codex's rollout: up to the compaction asked for, with that compaction's summary", () => {
    const first = codexBefore(jsonl(CODEX), 1);
    assert.equal(first.summary, "Summary one.");
    const md = codexRolloutMarkdown("Trial t-2 (lane-2)", 1, first.lines);
    assert.match(md, /from the Codex CLI's own rollout of the thread/);
    assert.match(md, /## 1\. Instructions \(developer\)\n\n```text\nSandbox notes\./);
    assert.match(md, /## 2\. User\n\n```text\nMake it faster\./);
    assert.match(md, /## 3\. Thinking \(its summary\)\n\n```text\nProfile first\./);
    assert.match(
      md,
      /## 4\. Tool call `shell` \(call_1\)\n\n```json\n\{\n {2}"command": \[\n {4}"make"/,
    );
    assert.match(md, /## 5\. Tool result \(call_1\)\n\n```text\nbuilt\n```/);
    assert.doesNotMatch(md, /token_count|gAAAA|After the first/);
    const second = codexBefore(jsonl(CODEX), 2);
    assert.equal(second.summary, "Summary two.");
    const md2 = codexRolloutMarkdown("Trial t-2 (lane-2)", 2, second.lines);
    assert.match(
      md2,
      /Codex compacted the conversation here; the summary it went on from\n\n```text\nSummary one\./,
    );
    assert.match(md2, /After the first\./);
    // A compaction the rollout does not show yet: all of it, and no summary.
    assert.equal(codexBefore(jsonl(CODEX), 3).summary, undefined);
  });

  test("OpenCode's session, from what the plugin kept before each compaction", () => {
    const md = opencodeSessionMarkdown("Trial t-3 (lane-1)", 2, OPENCODE);
    assert.match(md, /## 1\. User\n\n```text\nMake it faster\./);
    assert.match(
      md,
      /## 2\. Assistant\n\nThinking:\n\n```text\nProfile\.\n```\n\n```text\nRunning the benchmark\.\n```\n\nTool call `bash` \(call_1\), completed:/,
    );
    assert.match(md, /Its result:\n\n```text\nbuilt\n```/);
    assert.match(md, /## 3\. OpenCode compacted the conversation here \(compaction 1\)/);
    assert.match(
      md,
      /## 4\. The summary OpenCode went on from\n\n```text\n## Objective\n- faster\n```\n\nThe recent conversation it kept beside it:/,
    );
    assert.match(md, /## 5\. Assistant\n\n```text\nGoing on\./);
    assert.doesNotMatch(md, /agent-selected/);
  });
});

describe("reading what the agent's own user wrote (goal 070)", () => {
  test("only regular files, and never through a link in any part of the path", () => {
    const root = tmp("own");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "b.txt"), "mine\n");
    assert.equal(readUnder(root, ["a", "b.txt"]), "mine\n");
    // A folder that is a link to another place, and a file that is a link: neither is followed.
    const outside = tmp("outside");
    writeFileSync(join(outside, "b.txt"), "the controller's own\n");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "b.txt"), join(root, "a", "l.txt"));
    assert.equal(readUnder(root, ["link", "b.txt"]), undefined);
    assert.equal(readUnder(root, ["a", "l.txt"]), undefined);
    assert.equal(readUnder(root, ["a", "..", "a", "b.txt"]), undefined);
    assert.equal(readUnder(root, ["a/b.txt"]), undefined);
    // A pipe is not waited on.
    const fifo = spawnSync("mkfifo", [join(root, "a", "pipe")]);
    if (fifo.status === 0) assert.equal(readUnder(root, ["a", "pipe"]), undefined);
    // A cut keeps whole lines only.
    writeFileSync(join(root, "a", "long.jsonl"), "one\ntwo\nthree\n");
    assert.equal(readUnder(root, ["a", "long.jsonl"], 9), "one\ntwo\n");
  });

  test("Codex's rollout of a thread, found under its home's sessions by date, never through a link", () => {
    const root = tmp("rollout");
    const day = join(root, "home", ".codex", "sessions", "2026", "10", "21");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-21T00-00-00-0199a213.jsonl"), jsonl(CODEX));
    writeFileSync(join(day, "rollout-2026-10-21T00-01-00-0199ffff.jsonl"), "{}\n");
    assert.deepEqual(findCodexRollout(root, ["home", ".codex"], "0199a213"), [
      "home",
      ".codex",
      "sessions",
      "2026",
      "10",
      "21",
      "rollout-2026-10-21T00-00-00-0199a213.jsonl",
    ]);
    assert.equal(findCodexRollout(root, ["home", ".codex"], "../x"), undefined);
    const own = codexOwn({ root, home: ["home", ".codex"], title: "T", thread: () => "0199a213" })(
      1,
    );
    assert.equal(own?.summary, "Summary one.");
    assert.match(own?.markdown ?? "", /Make it faster/);
    // A date folder that is a link: not followed.
    const other = tmp("rollout-link");
    mkdirSync(join(other, "home", ".codex", "sessions"), { recursive: true });
    symlinkSync(
      join(root, "home", ".codex", "sessions", "2026"),
      join(other, "home", ".codex", "sessions", "2026"),
    );
    assert.equal(findCodexRollout(other, ["home", ".codex"], "0199a213"), undefined);
  });
});

describe("Claude Code's PreCompact hook (goal 070)", () => {
  const line = keptLine({ dir: "/scratch/research/r-1/compactions", stem: "t-1", readable: true });

  test("its settings: a PreCompact and a PostCompact hook, Thermite's own program run by Node without a shell", () => {
    const s = JSON.parse(
      claudeHookSettings("/area/claude-compactions", {
        dir: "/r/compactions",
        stem: "t-1",
        readable: true,
      }),
    ) as {
      hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
    };
    assert.deepEqual(Object.keys(s), ["hooks"]);
    assert.deepEqual(Object.keys(s.hooks), ["PreCompact", "PostCompact"]);
    assert.deepEqual(s.hooks.PostCompact?.[0]?.hooks, [
      {
        type: "command",
        command: process.execPath,
        args: [CLAUDE_HOOK, "claude-post", "/area/claude-compactions"],
        timeout: 60,
      },
    ]);
    assert.deepEqual(s.hooks.PreCompact?.[0]?.hooks, [
      {
        type: "command",
        command: process.execPath,
        args: [
          CLAUDE_HOOK,
          "claude",
          "/area/claude-compactions",
          "Thermite keeps the whole conversation before this compaction in /r/compactions/t-1-{n}.md. Name that file in your summary, and say that the agent can read it there for any detail the summary leaves out.",
        ],
        timeout: 60,
      },
    ]);
    assert.ok(existsSync(CLAUDE_HOOK), "the hook is beside the harness's own code");
    const a = claudeArgs(
      { api: "claude", baseUrl: "", model: "m", apiKey: "", contextWindow: 0, maxTokens: 0 },
      { settings: "{}" },
    );
    assert.equal(a[a.indexOf("--settings") + 1], "{}");
    // Settings files stay off: the hook comes only from Thermite's own settings.
    assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  });

  test("as a program: it copies the transcript under the next compaction's number, and prints the line naming the kept file", () => {
    const area = tmp("hook");
    const transcript = join(area, "claude-home", ".claude", "projects", "-w", "s-1.jsonl");
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, jsonl(CLAUDE));
    const drops = join(area, "claude-compactions");
    const r = spawnSync(process.execPath, [CLAUDE_HOOK, "claude", drops, line], {
      input: JSON.stringify({
        session_id: "s-1",
        transcript_path: transcript,
        cwd: "/w",
        hook_event_name: "PreCompact",
        trigger: "auto",
        custom_instructions: null,
      }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    // The transcript already shows one compaction: this is the second.
    assert.equal(
      r.stdout.trim(),
      "Thermite keeps the whole conversation before this compaction in /scratch/research/r-1/compactions/t-1-2.md. Name that file in your summary, and say that the agent can read it there for any detail the summary leaves out.",
    );
    assert.doesNotMatch(
      r.stdout,
      /^\{/,
      "plain text: Claude Code takes it as instructions, not as JSON",
    );
    assert.equal(readFileSync(join(drops, "2.jsonl"), "utf8"), jsonl(CLAUDE));
    const meta = JSON.parse(readFileSync(join(drops, "2.meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(meta.session_id, "s-1");
    assert.equal(meta.trigger, "auto");
    assert.equal(meta.copied, true);
  });

  test("it copies the transcript once Claude Code has written the lines it held back", async () => {
    // Claude Code 2.1.305 writes its transcript every 100 ms and runs the hook without writing
    // first: the newest lines come while the hook waits, and early on the file is not there yet.
    const area = tmp("hook-settle");
    const quick: Settle = { quietMs: 150, maxMs: 3_000, stepMs: 10 };
    const transcript = join(area, "s-1.jsonl");
    const [first, ...rest] = CLAUDE;
    writeFileSync(transcript, jsonl([first]));
    const late = setTimeout(() => appendFileSync(transcript, jsonl(rest)), 60);
    const drops = join(area, "drops");
    assert.match(
      await claudePreCompact({ transcript_path: transcript }, drops, line, quick),
      /t-1-2\.md/,
    );
    clearTimeout(late);
    assert.equal(
      readFileSync(join(drops, "2.jsonl"), "utf8"),
      jsonl(CLAUDE),
      "every line, the late ones too",
    );
    const fresh = join(area, "s-2.jsonl");
    const born = setTimeout(() => writeFileSync(fresh, jsonl([first])), 80);
    const drops2 = join(area, "drops-2");
    assert.match(
      await claudePreCompact({ transcript_path: fresh }, drops2, line, quick),
      /t-1-1\.md/,
    );
    clearTimeout(born);
    assert.equal(
      readFileSync(join(drops2, "1.jsonl"), "utf8"),
      jsonl([first]),
      "a file that came late",
    );
    const meta = JSON.parse(readFileSync(join(drops2, "1.meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(meta.copied, true);
    assert.ok(Number(meta.waited_ms) >= 80, `it waited for the file: ${String(meta.waited_ms)} ms`);
  });

  test("it never stands in the compaction's way: no transcript, bad input or no folder still exit 0", async () => {
    const area = tmp("hook-bad");
    const drops = join(area, "drops");
    const started = Date.now();
    assert.match(
      await claudePreCompact({ transcript_path: join(area, "missing.jsonl") }, drops, line, {
        quietMs: 20,
        maxMs: 100,
        stepMs: 10,
      }),
      /t-1-1\.md/,
    );
    assert.ok(
      Date.now() - started < 2_000,
      "a transcript that never comes is waited for a while only",
    );
    assert.ok(!existsSync(join(drops, "1.jsonl")), "nothing to copy");
    // With no transcript to count from, the next number follows the hook's own records.
    const bad = spawnSync(process.execPath, [CLAUDE_HOOK, "claude", drops, line], {
      input: "not json",
      encoding: "utf8",
    });
    assert.equal(bad.status, 0);
    assert.match(bad.stdout, /t-1-2\.md/);
    const none = spawnSync(process.execPath, [CLAUDE_HOOK, "other"], {
      input: "{}",
      encoding: "utf8",
    });
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "");
  });

  test("the PostCompact hook keeps the summary under the last copy's number, and prints nothing", async () => {
    const area = tmp("hook-post");
    const transcript = join(area, "s-1.jsonl");
    writeFileSync(transcript, jsonl(CLAUDE));
    const drops = join(area, "claude-compactions");
    // Nothing copied yet: nothing to name the summary after.
    assert.equal(claudePostCompact({ compact_summary: "Early." }, drops), undefined);
    await claudePreCompact({ transcript_path: transcript }, drops, line);
    const post = spawnSync(process.execPath, [CLAUDE_HOOK, "claude-post", drops], {
      input: JSON.stringify({
        session_id: "s-1",
        transcript_path: transcript,
        hook_event_name: "PostCompact",
        trigger: "auto",
        compact_summary: "Kernel at 12.5 ms. Kept in /r/compactions/t-1-2.md.",
      }),
      encoding: "utf8",
    });
    assert.equal(post.status, 0);
    assert.equal(post.stdout, "", "Claude Code would show it to the user only");
    assert.equal(
      readFileSync(join(drops, "2.summary.md"), "utf8"),
      "Kernel at 12.5 ms. Kept in /r/compactions/t-1-2.md.\n",
    );
    // An empty summary (one Claude Code made earlier and applies now) keeps nothing.
    assert.equal(claudePostCompact({ compact_summary: "" }, drops), undefined);
  });

  test("the harness reads the hook's copy, else the transcript itself, and the summary Claude Code went on from", () => {
    const area = tmp("claude-own");
    mkdirSync(join(area, "claude-home", ".claude", "projects", "-w"), { recursive: true });
    writeFileSync(
      join(area, "claude-home", ".claude", "projects", "-w", "s-1.jsonl"),
      jsonl(CLAUDE),
    );
    const own = claudeOwn({
      root: area,
      drops: ["claude-compactions"],
      home: ["claude-home"],
      title: "Trial t-1 (lane-1)",
      session: () => "s-1",
    });
    // No copy: the transcript up to its first compaction.
    const first = own(1);
    assert.match(first?.markdown ?? "", /Make the kernel faster/);
    assert.doesNotMatch(first?.markdown ?? "", /Going on/);
    assert.match(first?.summary ?? "", /t-1-1\.md/);
    assert.equal(first?.tokensBefore, 160_512);
    // The hooks' copies, when there are: the conversation, and the summary the PostCompact hook kept.
    mkdirSync(join(area, "claude-compactions"));
    writeFileSync(join(area, "claude-compactions", "1.jsonl"), jsonl(CLAUDE.slice(0, 1)));
    writeFileSync(join(area, "claude-compactions", "1.summary.md"), "From the hook.\n");
    assert.doesNotMatch(own(1)?.markdown ?? "", /make bench/);
    assert.equal(own(1)?.summary, "From the hook.");
    // A compaction neither shows: none.
    assert.equal(own(2), undefined);
    // A session id is never a path.
    const odd = claudeOwn({
      root: area,
      drops: ["x"],
      home: ["claude-home"],
      title: "T",
      session: () => "../s-1",
    });
    assert.match(
      odd(1)?.markdown ?? "",
      /Make the kernel faster/,
      "an unknown session: the transcript there",
    );
  });
});

/** A stand-in for OpenCode 2.0.32's Promise plugin context: the hook, the session and the events. */
function fakeOpencode(o: { parent?: string; context?: unknown[] } = {}) {
  let hook: ((e: OpencodeCompaction) => Promise<void> | void) | undefined;
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const ctx = {
    session: {
      hook: async (name: string, cb: (e: OpencodeCompaction) => Promise<void> | void) => {
        assert.equal(name, "compaction");
        hook = cb;
        return { dispose: async () => undefined };
      },
      context: async () => o.context ?? OPENCODE[0]?.messages,
      get: async () => (o.parent ? { id: "ses_child", parentID: o.parent } : { id: "ses_1" }),
    },
    event: {
      subscribe: (opts?: { signal?: AbortSignal }): AsyncIterable<unknown> => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            while (!queue.length) {
              if (opts?.signal?.aborted) return { done: true, value: undefined };
              await new Promise<void>((r) => {
                wake = r;
                opts?.signal?.addEventListener("abort", () => r(), { once: true });
              });
            }
            return { done: false, value: queue.shift() };
          },
        }),
      }),
    },
  };
  return {
    ctx,
    compact: async (sessionID = "ses_1") => {
      const e: OpencodeCompaction = {
        sessionID,
        system: [{ type: "text", text: "You summarize." }],
        messages: [],
      };
      await hook?.(e);
      return e;
    },
    emit: async (e: unknown) => {
      queue.push(e);
      wake?.();
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

describe("Thermite's OpenCode plugin (goal 070)", () => {
  test("its module is what OpenCode 2.0.32 loads: a default export with an id and a setup", async () => {
    const m = (await import("../../../src/agents/programs/opencode/plugin.ts")) as {
      default: { id: unknown; setup: unknown };
    };
    assert.equal(m.default.id, "thermite");
    assert.equal(typeof m.default.setup, "function");
  });

  test("before each compaction it keeps the session and adds the line naming the file; it marks each one that ends", async () => {
    const dir = join(tmp("plugin"), "opencode-compactions");
    const f = fakeOpencode();
    const stop = await thermitePlugin({
      THERMITE_COMPACTION_DROPS: dir,
      THERMITE_COMPACTION_LINE: "Kept in /r/compactions/t-3-{n}.md.",
    }).setup(f.ctx);
    const e = await f.compact();
    assert.deepEqual(e.system.at(-1), { type: "text", text: "Kept in /r/compactions/t-3-1.md." });
    const kept = JSON.parse(readFileSync(join(dir, "1.json"), "utf8")) as {
      session: string;
      messages: unknown[];
    };
    assert.equal(kept.session, "ses_1");
    assert.deepEqual(kept.messages, OPENCODE[0]?.messages);
    assert.deepEqual(opencodeEnded(join(dir, ".."), ["opencode-compactions"]), []);
    // Another session's events change nothing; this one's end marks compaction 1, with its summary.
    await f.emit({ type: "session.compaction.ended", data: { sessionID: "ses_other", text: "x" } });
    await f.emit({
      type: "session.compaction.ended",
      data: { sessionID: "ses_1", text: "## Objective\n- faster" },
    });
    assert.deepEqual(opencodeEnded(join(dir, ".."), ["opencode-compactions"]), [1]);
    // A failed compaction leaves no mark: the next one takes the same number.
    await f.compact();
    await f.emit({ type: "session.compaction.failed", data: { sessionID: "ses_1" } });
    const again = await f.compact();
    assert.equal(again.system.at(-1)?.text, "Kept in /r/compactions/t-3-2.md.");
    await f.emit({
      type: "session.compaction.ended",
      data: { sessionID: "ses_1", text: "Second." },
    });
    assert.deepEqual(opencodeEnded(join(dir, ".."), ["opencode-compactions"]), [1, 2]);
    const own = opencodeOwn({
      root: join(dir, ".."),
      drops: ["opencode-compactions"],
      title: "Trial t-3 (lane-1)",
    })(1);
    assert.equal(own?.summary, "## Objective\n- faster");
    assert.match(own?.markdown ?? "", /Running the benchmark/);
    stop?.();
  });

  test("a subagent's session and a plugin with no folder are left alone", async () => {
    const dir = join(tmp("plugin-child"), "drops");
    const child = fakeOpencode({ parent: "ses_1" });
    await thermitePlugin({
      THERMITE_COMPACTION_DROPS: dir,
      THERMITE_COMPACTION_LINE: "x {n}",
    }).setup(child.ctx);
    const e = await child.compact("ses_child");
    assert.equal(e.system.length, 1);
    assert.deepEqual(readdirSync(dir), []);
    const none = fakeOpencode();
    assert.equal(await thermitePlugin({}).setup(none.ctx), undefined);
    assert.equal((await none.compact()).system.length, 1);
  });
});

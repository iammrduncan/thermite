// Test only (check.mjs, in the harness image): one short trial through the trial loop's terminal
// mode (src/harness/agents/cli/loop.ts, src/agents/cli/terminal.ts), under the real broker as lane-1, for each program the
// image has: the fake TUI (tests/helpers/fake-tui.ts) in Claude Code's place, writing a transcript
// as Claude Code does; the real Codex CLI; and the real OpenCode, its server and its terminal.
// Codex and OpenCode reach the stand-in model (model.mjs), which answers each call with text, so
// each trial is its first message, the loop's nudge typed into the terminal, and its end: no
// submission, with each turn's end read from the session log, its usage counted, its screen kept,
// the program ended its own way, and nothing of the lane's left running. Then the owner's input
// (terminal_input's last step) through a trial's console, as lane-1's host types it: text and a
// key into the fake TUI, and text into the real Codex. Then a full usage window waited out (goal
// 169): the fake, as Claude Code, goes on by itself after its reset; the real OpenCode meets the
// stand-in model's 429 and the loop types its continuation after the reset; in each, the wait is
// recorded and the owner's input queued during it goes in after the reset.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startModel, WINDOW_MARKER, WINDOW_S } from "./model.mjs";

const AT = "2026-10-29T05:52:16.107Z";

/** The fake's script: one turn with a tool call, then turns that do nothing. */
function fakeScript() {
  const s = "{session}";
  const said = (text) => ({
    type: "user",
    sessionId: s,
    origin: { kind: "human" },
    message: { content: text },
  });
  const ended = { type: "system", sessionId: s, subtype: "turn_duration" };
  const assistant = (id, content, usage) => ({
    type: "assistant",
    sessionId: s,
    timestamp: AT,
    message: { id, model: "claude-test", content, usage },
  });
  return {
    log: ".claude/projects/check/{session}.jsonl",
    turns: [
      [
        {
          lines: [
            said("go"),
            assistant(
              "msg_1",
              [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make" } }],
              { input_tokens: 10, output_tokens: 2 },
            ),
            {
              type: "user",
              sessionId: s,
              message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
            },
            assistant("msg_2", [{ type: "text", text: "Tried it." }], {
              input_tokens: 20,
              output_tokens: 5,
            }),
            ended,
          ],
        },
      ],
    ],
    rest: [{ lines: [said("x"), ended] }],
  };
}

/**
 * The fake's script for a full usage window, as Claude Code meets one: its own message with the
 * reset (`resetsAt`, seconds) and the turn's end, a wait past the reset, then the prompt it goes on
 * with by itself and a reply.
 */
function fakeWindowScript(resetsAt) {
  const s = "{session}";
  const ended = { type: "system", sessionId: s, subtype: "turn_duration" };
  return {
    log: ".claude/projects/check/{session}.jsonl",
    turns: [
      [
        {
          lines: [
            { type: "user", sessionId: s, origin: { kind: "human" }, message: { content: "go" } },
            {
              type: "assistant",
              sessionId: s,
              timestamp: AT,
              isApiErrorMessage: true,
              error: "rate_limit",
              apiError: "usage_limit_reached",
              apiErrorParams: { rate_limit_info: { resetsAt, rateLimitType: "five_hour" } },
              message: {
                id: "msg_limit",
                model: "<synthetic>",
                content: [{ type: "text", text: "You've hit your session limit" }],
              },
            },
            ended,
          ],
        },
        { waitMs: Math.max(0, resetsAt * 1000 - Date.now()) + 1500 },
        {
          lines: [
            {
              type: "user",
              sessionId: s,
              isMeta: true,
              origin: { kind: "auto-continuation" },
              message: { content: "Your usage limit has reset. Continue the task." },
            },
            {
              type: "assistant",
              sessionId: s,
              timestamp: AT,
              message: {
                id: "msg_on",
                model: "claude-test",
                content: [{ type: "text", text: "Went on." }],
                usage: { input_tokens: 10, output_tokens: 2 },
              },
            },
            ended,
          ],
        },
      ],
    ],
    rest: [
      {
        lines: [
          { type: "user", sessionId: s, origin: { kind: "human" }, message: { content: "x" } },
          ended,
        ],
      },
    ],
  };
}

/** Runs the loop's trials; `c` is check.mjs's: its loader, runner, checks and lane helpers. */
export async function loopTrials(c) {
  const { runCliTrial } = await c.load("harness/agents/cli/index");
  const { claudeProgram, codexProgram, opencodeProgram } = await c.load("agents/cli/index");
  const before = {
    claude: process.env.THERMITE_CLAUDE_BIN,
    codex: process.env.THERMITE_CODEX_BIN,
    opencode: process.env.THERMITE_OPENCODE_BIN,
  };
  const api = await startModel();
  const restore = (k, v) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    /**
     * One code trial of lane-1 in its terminal; what it gave, and what it kept and showed.
     * `during`: run with the trial's console once it has one, the trial stopped after it; `brief`:
     * its first message's marker.
     */
    const trial = async (name, p, model, files, during, brief = "TERMINAL-CHECK-1: reply.") => {
      const a = await c.area(`loop-${name}`, files);
      const sent = [];
      const live = [];
      // Its waits for its usage window, as the run records them.
      const waits = [];
      const started = Date.now();
      const stop = new AbortController();
      let held;
      const typing = during
        ? (async () => {
            const con = await c.until(`${name}'s console`, () => held, 60_000);
            try {
              return await during(con, a);
            } finally {
              stop.abort();
            }
          })().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
        : undefined;
      const r = await runCliTrial(
        p,
        {
          mode: "code",
          spec: {
            trialId: `check-loop-${name}`,
            token: "check",
            run: "check-run",
            lane: c.LANE,
            workspace: a.repo,
            workspaceRoot: a.dir,
            parentCommit: "c".repeat(40),
            editablePaths: ["notes.txt"],
            brief,
          },
        },
        {
          runner: c.runner,
          model,
          // Codex's and OpenCode's model proxy is the stand-in model: its paths end as the APIs'.
          apiUrl: `http://127.0.0.1:${api.port}`,
          live: (entries) => live.push(...entries.map((e) => e.text)),
          progress: () => undefined,
          sent: (q) => sent.push(q),
          env: a.env ?? {},
          pollMs: 200,
          terminal: true,
          console: (x) => {
            if (x !== "headless") held = x;
          },
          waiting: (w) => waits.push(w),
          ...(during ? { signal: stop.signal } : {}),
        },
      );
      const owner = await typing;
      await c.runner.killRole(c.LANE).catch(() => 0);
      await c.sleep(500);
      return {
        a,
        r,
        model,
        sent,
        live,
        waits,
        owner,
        seconds: Math.round((Date.now() - started) / 1000),
        // Its last screen, kept in memory for the live view: no file in its area.
        screen: held?.lastScreen()?.data ?? "",
        file: existsSync(join(a.dir, `${p.prefix}-screen.ansi`)),
        left: c.laneProcesses(),
      };
    };
    const ended = (name, t, more) =>
      c.check(
        `${name}: a trial through the loop's terminal mode: its first message, a nudge typed, its turns' ends from its session log, its screen kept, and nothing of the lane's left`,
        t.r.stopped === "no_submission" &&
          t.sent.length === 2 &&
          t.r.turns >= 1 &&
          t.r.tokensIn > 0 &&
          t.screen.length > 0 &&
          !t.file &&
          t.left.length === 0 &&
          more(t),
        {
          stopped: t.r.stopped,
          error: t.r.error,
          turns: t.r.turns,
          toolCalls: t.r.toolCalls,
          tokens: [t.r.tokensIn, t.r.tokensOut],
          prompts: t.sent.length,
          seconds: t.seconds,
          screen: t.screen.length,
          left: t.left,
          live: t.live.slice(-6),
        },
      );

    // The fake in Claude Code's place: Claude Code's own command line, as lane-1 runs it.
    const fake = await trial(
      "fake",
      claudeProgram,
      {
        api: "claude",
        harness: "claude-code",
        baseUrl: "https://api.anthropic.com",
        model: "claude-test",
        apiKey: c.TOKEN,
        contextWindow: 1_000_000,
        maxTokens: 0,
      },
      (dir) => {
        // Before the area is handed to lane-1: the fake's command and its script, in the area.
        const bin = join(dir, "claude");
        writeFileSync(
          bin,
          `#!/bin/sh\nexec "${process.execPath}" /opt/fake-tui/fake-tui.ts "$@"\n`,
        );
        chmodSync(bin, 0o755);
        process.env.THERMITE_CLAUDE_BIN = bin;
        const script = join(dir, "script.json");
        writeFileSync(script, JSON.stringify(fakeScript()));
        return { FAKE_TUI_SCRIPT: script };
      },
    );
    ended("the fake TUI as Claude Code", fake, (t) => t.r.toolCalls === 1 && t.r.turns === 2);

    // The owner's input through the trial's console, into the fake mid-turn: text, then a key.
    // The fake shows each thing it takes on its screen; its own record is lane-1's alone. The
    // console's screen restores it in an emulator: read back as plain lines.
    const { Screen } = await c.load("agents/terminal/screen");
    const fakeShows = async (con) => {
      const snap = await con.screen();
      if (!snap) return "";
      const screen = new Screen({ ...snap, scrollback: 0, reply: () => undefined });
      try {
        screen.write(snap.data);
        return (await screen.text()).lines.join("\n");
      } finally {
        screen.dispose();
      }
    };
    const fakeInput = await trial(
      "fake-input",
      claudeProgram,
      fake.model,
      (dir) => {
        const bin = join(dir, "claude");
        writeFileSync(
          bin,
          `#!/bin/sh\nexec "${process.execPath}" /opt/fake-tui/fake-tui.ts "$@"\n`,
        );
        chmodSync(bin, 0o755);
        process.env.THERMITE_CLAUDE_BIN = bin;
        const script = join(dir, "script.json");
        const busy = fakeScript();
        busy.turns = [[{ lines: busy.turns[0][0].lines.slice(0, 2) }, { waitMs: 60_000 }]];
        writeFileSync(script, JSON.stringify(busy));
        return { FAKE_TUI_SCRIPT: script };
      },
      async (con) => {
        // Its first message is the whole prompt: its start scrolls off, its brief stays on screen.
        try {
          await c.until(
            "its first message",
            async () => /TERMINAL-CHECK-1/.test(await fakeShows(con)),
            60_000,
          );
        } catch (err) {
          return { error: err.message, seen: await fakeShows(con) };
        }
        const text = await con.input({ text: "OWNER-INPUT-1", wait: "queue" }, () => undefined);
        const key = await con.input({ keys: ["down"], wait: "queue" }, () => undefined);
        await c.until(
          "the input in the program",
          async () => /key: down/.test(await fakeShows(con)),
          60_000,
        );
        return { text: text.outcome, key: key.outcome, seen: await fakeShows(con) };
      },
    );
    const ownerSeen = fakeInput.owner?.seen ?? "";
    c.check(
      "the fake TUI as Claude Code: the owner's input through the trial's console, typed by lane-1's host mid-turn, text then Enter and a key by name",
      fakeInput.owner?.text === "typed" &&
        fakeInput.owner?.key === "typed" &&
        /user: OWNER-INPUT-1/.test(ownerSeen) &&
        /key: down/.test(ownerSeen) &&
        fakeInput.r.stopped === "interrupted" &&
        fakeInput.left.length === 0,
      {
        owner: { ...fakeInput.owner, seen: ownerSeen.split("\n").slice(-8) },
        stopped: fakeInput.r.stopped,
      },
    );

    // A full five-hour window: the fake, as Claude Code, goes on by itself after the reset. The
    // owner's input sent during the wait goes in once it has.
    const reset = Math.floor(Date.now() / 1000) + 8;
    const fakeWindow = await trial(
      "fake-window",
      claudeProgram,
      fake.model,
      (dir) => {
        const bin = join(dir, "claude");
        writeFileSync(
          bin,
          `#!/bin/sh\nexec "${process.execPath}" /opt/fake-tui/fake-tui.ts "$@"\n`,
        );
        chmodSync(bin, 0o755);
        process.env.THERMITE_CLAUDE_BIN = bin;
        const script = join(dir, "script.json");
        writeFileSync(script, JSON.stringify(fakeWindowScript(reset)));
        return { FAKE_TUI_SCRIPT: script };
      },
      async (con) => {
        await c.until("its usage limit shown", () => con.limit(), 60_000);
        const later = [];
        const queued = await con.input({ text: "OWNER-QUEUED-1", wait: "queue" }, (o) =>
          later.push({ outcome: o, at: Date.now() }),
        );
        await c.until(
          "the queued input in the program",
          async () => /user: OWNER-QUEUED-1/.test(await fakeShows(con)),
          60_000,
        );
        return { queued, later, seen: await fakeShows(con) };
      },
    );
    const went = fakeWindow.owner ?? {};
    c.check(
      "the fake TUI as Claude Code: a full usage window waited out in its terminal, the wait recorded, nothing typed by the loop as it went on by itself, and the owner's input queued during the wait typed after the reset",
      fakeWindow.waits.length === 1 &&
        fakeWindow.waits[0].until === new Date(reset * 1000).toISOString() &&
        went.queued?.outcome === "queued" &&
        went.later?.[0]?.outcome === "typed_after_reset" &&
        went.later[0].at >= reset * 1000 &&
        !JSON.stringify(fakeWindow.sent).includes("The model call failed") &&
        fakeWindow.r.stopped === "interrupted" &&
        fakeWindow.left.length === 0,
      {
        waits: fakeWindow.waits,
        owner: {
          ...went,
          seen: String(went.seen ?? "")
            .split("\n")
            .slice(-6),
        },
        prompts: fakeWindow.sent.length,
        stopped: fakeWindow.r.stopped,
        error: fakeWindow.r.error,
      },
    );

    if (existsSync("/opt/codex/bin/codex")) {
      process.env.THERMITE_CODEX_BIN = "/opt/codex/bin/codex";
      const codex = await trial("codex", codexProgram, {
        api: "openai",
        harness: "codex",
        baseUrl: "",
        model: "scripted",
        apiKey: "",
        contextWindow: 0,
        maxTokens: 0,
      });
      ended("Codex", codex, (t) => t.live.some((l) => /done\./.test(l)));
      // The owner's text into the real Codex, through the trial's console: its next model call
      // carries it.
      const first = api.calls["TERMINAL-CHECK-1"] ?? 0;
      const input = await trial(
        "codex-input",
        codexProgram,
        codex.model,
        undefined,
        async (con) => {
          await c.until("Codex's first call", () => api.calls["TERMINAL-CHECK-1"] > first, 60_000);
          const got = await con.input(
            { text: "TERMINAL-CHECK-2: the owner typed this.", wait: "queue" },
            () => undefined,
          );
          await c.until("the owner's text at the model", () => api.calls["TERMINAL-CHECK-2"] >= 1);
          return { outcome: got.outcome };
        },
      );
      c.check(
        "Codex: the owner's text through the trial's console, typed into its terminal by lane-1's host, reached its model",
        input.owner?.outcome === "typed" &&
          api.calls["TERMINAL-CHECK-2"] >= 1 &&
          input.left.length === 0,
        {
          owner: input.owner,
          calls: api.calls,
          stopped: input.r.stopped,
          live: input.live.slice(-4),
        },
      );
    } else c.check("the image has no Codex CLI: its loop trial was not run", true, "");

    if (existsSync("/usr/local/bin/opencode")) {
      process.env.THERMITE_OPENCODE_BIN = "/usr/local/bin/opencode";
      const opencode = await trial("opencode", opencodeProgram, {
        api: "openai",
        harness: "opencode",
        baseUrl: "",
        model: "scripted",
        apiKey: "",
        contextWindow: 0,
        maxTokens: 0,
      });
      ended("OpenCode", opencode, (t) => t.live.some((l) => /done\./.test(l)));
      // A full usage window: the stand-in model answers OpenCode's first call with a 429 whose
      // reset is WINDOW_S away. OpenCode fails its step and does not wait; the loop waits for the
      // reset, types its continuation, and the owner's input queued meanwhile goes in after it.
      const opencodeWindow = await trial(
        "opencode-window",
        opencodeProgram,
        opencode.model,
        undefined,
        async (con) => {
          await c.until("its usage limit shown", () => con.limit(), 90_000);
          const later = [];
          const queued = await con.input(
            { text: "TERMINAL-CHECK-4: queued during the wait.", wait: "queue" },
            (o) => later.push({ outcome: o, at: Date.now() }),
          );
          await c.until(
            "the queued input at the model",
            () => api.calls["TERMINAL-CHECK-4"] >= 1,
            90_000,
          );
          return { queued, later };
        },
        `${WINDOW_MARKER}: reply.`,
      );
      const resetAt = Date.parse(String(api.window() ?? ""));
      const after = (api.times[WINDOW_MARKER] ?? []).slice(1);
      c.check(
        "OpenCode: a full usage window in its terminal, the wait recorded with OpenCode's reset, the loop's continuation typed after the reset, and the owner's input queued during the wait typed after it",
        opencodeWindow.waits.length === 1 &&
          Math.abs(Date.parse(opencodeWindow.waits[0].until) - resetAt) < 3_000 &&
          after.length >= 1 &&
          after[0] >= resetAt - 1_000 &&
          opencodeWindow.owner?.queued?.outcome === "queued" &&
          opencodeWindow.owner?.later?.[0]?.outcome === "typed_after_reset" &&
          api.calls["TERMINAL-CHECK-4"] >= 1 &&
          JSON.stringify(opencodeWindow.sent).includes("The model call failed") &&
          opencodeWindow.left.length === 0,
        {
          waits: opencodeWindow.waits,
          window: api.window(),
          after,
          owner: opencodeWindow.owner,
          prompts: opencodeWindow.sent.length,
          stopped: opencodeWindow.r.stopped,
          error: opencodeWindow.r.error,
          live: opencodeWindow.live.slice(-6),
          seconds: opencodeWindow.seconds,
          windowS: WINDOW_S,
        },
      );
    } else c.check("the image has no OpenCode: its loop trial was not run", true, "");
  } finally {
    api.close();
    restore("THERMITE_CLAUDE_BIN", before.claude);
    restore("THERMITE_CODEX_BIN", before.codex);
    restore("THERMITE_OPENCODE_BIN", before.opencode);
  }
}

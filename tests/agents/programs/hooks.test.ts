import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  newClaudeTally,
  readClaudeEvents,
} from "../../../src/agents/programs/claude-code/events.ts";
import {
  CLAUDE_SIGNAL_HOOKS,
  claudeTrialSettings,
} from "../../../src/agents/programs/claude-code/index.ts";
import {
  CODEX_SIGNAL_HOOKS,
  codexArgs,
  codexConfig,
  codexHooks,
  codexNotify,
} from "../../../src/agents/programs/codex/index.ts";
import { HOOK_PROGRAM, hookSignals } from "../../../src/agents/programs/hooks/index.ts";
import {
  OFFER_PATH,
  runHook,
  signalLine,
  TAKEN_PATH,
} from "../../../src/agents/programs/hooks/main.ts";
import * as plugin from "../../../src/agents/programs/opencode/plugin.ts";
import type { SessionEvent } from "../../../src/agents/programs/session-log.ts";
import { TURN_OFFER, TURN_TAKEN } from "../../../src/core/api/harness/turn.ts";

/** The spike's recorded hook signals (the fixtures' READMEs say how). */
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "session-logs");
const signals = (program: string, run: string, file = "signals.jsonl") =>
  readFileSync(join(FIXTURES, program, run, file), "utf8").split("\n");

function read(id: "claude-code" | "codex", lines: string[]) {
  const a = hookSignals(id);
  const s = a.newState();
  const events = a.read(lines, s);
  return { events, unknown: a.unknown(s) };
}
const types = (events: SessionEvent[]) => events.map((e) => e.type);
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

/** A stand-in for the harness's trial routes: what each call asked, and its answers. */
function fakeHarness() {
  const asked: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  let offer: { offer: string | null; text: string } = { offer: "o-1", text: "the message" };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      asked.push({
        path: req.url ?? "",
        auth: req.headers.authorization ?? "",
        body: JSON.parse(body || "{}"),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === OFFER_PATH ? offer : { messages: [1] }));
    });
  });
  return {
    asked,
    server,
    answer(o: { offer: string | null; text: string }) {
      offer = o;
    },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe("the hooks' signals as events (goal 169)", () => {
  test("Claude Code in its terminal: each turn and tool, a message taken in mid-turn, a usage limit; Notification left out", () => {
    const { events, unknown } = read("claude-code", signals("claude-code-2.1.308", "claude-tui"));
    assert.deepEqual(unknown, new Map());
    assert.equal(of(events, "session")[0]?.id, "627c3344-d65e-4da8-b679-a964da1cfb78");
    assert.deepEqual(
      of(events, "user").map((e) => [e.origin, e.text.slice(0, 8)]),
      [
        ["prompt", "SPIKE-1:"],
        ["steer", "STEER-1:"],
        ["prompt", "SPIKE-2:"],
        ["prompt", "SPIKE-4:"],
      ],
    );
    assert.deepEqual(
      of(events, "turn.ended").map((e) => [e.reason, e.error]),
      [
        ["done", undefined],
        ["done", undefined],
        ["limit", "rate_limit"],
      ],
    );
    assert.match(of(events, "limit")[0]?.message ?? "", /session limit/);
    assert.equal(of(events, "tool.call").length, of(events, "tool.result").length);
    assert.equal(types(events).at(-1), "session.end");
  });

  test("Claude Code's hooks that gave a message: after a tool it is taken in, at the turn's end a new turn begins with it", () => {
    const { events, unknown } = read("claude-code", signals("claude-code-2.1.308", "claude-hooks"));
    assert.deepEqual(unknown, new Map());
    assert.deepEqual(types(events), [
      "session",
      "turn.started",
      "user",
      "tool.call",
      "tool.result",
      "queue",
      "turn.ended",
      "turn.started",
      "tool.call",
      "tool.result",
      "turn.ended",
      "session.end",
    ]);
  });

  test("in `-p`, the hooks' tool calls and turn are those its stream-json output gives", () => {
    const { events, unknown } = read("claude-code", signals("claude-code-2.1.308", "claude-print"));
    assert.deepEqual(unknown, new Map());
    const stream = newClaudeTally();
    readClaudeEvents(signals("claude-code-2.1.308", "claude-print", "stream.jsonl"), stream);
    assert.equal(of(events, "tool.call").length, stream.toolCalls);
    assert.equal(of(events, "session")[0]?.id, stream.session);
    assert.deepEqual(
      of(events, "turn.ended").map((e) => e.reason),
      ["done"],
    );
  });

  test("Codex: a message taken in within the same turn id, an interrupt, and notify for its own thread only", () => {
    const { events, unknown } = read("codex", signals("codex-0.162.1", "codex-tui"));
    assert.deepEqual(unknown, new Map());
    assert.deepEqual(
      of(events, "user").map((e) => [e.origin, e.text.slice(0, 8)]),
      [
        ["prompt", "SPIKE-1:"],
        ["steer", "STEER-1:"],
        ["prompt", "SPIKE-2:"],
        ["prompt", "SPIKE-3:"],
        ["prompt", "SPIKE-4:"],
      ],
    );
    assert.deepEqual(
      of(events, "turn.ended").map((e) => e.reason),
      ["done", "done", "interrupted"],
      "the title thread's notify ends no turn; no hook ends the turn a usage limit stopped",
    );
    const hooks = read("codex", signals("codex-0.162.1", "codex-hooks"));
    assert.deepEqual(hooks.unknown, new Map());
    assert.deepEqual(
      of(hooks.events, "turn.started").length,
      2,
      "the Stop hook's message begins a turn",
    );
  });

  test("a notify for the session's own thread ends its turn; a signal it does not know is counted", () => {
    const line = (src: string, event: string, payload: unknown) =>
      JSON.stringify({ t: 1, src, event, payload });
    const { events, unknown } = read("codex", [
      line("codex", "SessionStart", { session_id: "th-1" }),
      line("codex", "UserPromptSubmit", { turn_id: "u-1", prompt: "go" }),
      line("codex-notify", "agent-turn-complete", { "thread-id": "th-2" }),
      line("codex-notify", "agent-turn-complete", { "thread-id": "th-1" }),
      line("codex", "NewHook", {}),
      "not json",
      "",
    ]);
    assert.deepEqual(
      of(events, "turn.ended").map((e) => e.reason),
      ["done"],
    );
    assert.deepEqual(
      unknown,
      new Map([
        ["NewHook", 1],
        ["(not a signal)", 1],
      ]),
    );
  });
});

describe("Thermite's hook program (goal 169)", () => {
  const h = fakeHarness();
  before(() => new Promise<void>((r) => h.server.listen(0, "127.0.0.1", r)));
  after(() => new Promise<void>((r) => h.server.close(() => r())));
  const env = (file: string, auth = "trial.tok") => ({
    THERMITE_SIGNALS: file,
    THERMITE_HARNESS_URL: h.url(),
    THERMITE_TRIAL_AUTH: auth,
  });
  const file = () => join(mkdtempSync(join(tmpdir(), "thermite-hook-")), "signals.jsonl");
  const fixture = (event: string) => {
    const line = signals("claude-code-2.1.308", "claude-hooks").find((l) =>
      l.includes(`"event":"${event}"`),
    );
    return JSON.stringify((JSON.parse(line ?? "{}") as { payload: unknown }).payload);
  };
  const run = async (argv: string[], stdin: string, e: NodeJS.ProcessEnv) => {
    h.asked.length = 0;
    const printed: string[] = [];
    await runHook(argv, stdin, e, (s) => printed.push(s));
    return printed;
  };
  const written = (f: string) =>
    readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) => JSON.parse(l) as { src: string; event: string; payload: Record<string, unknown> },
      );

  test("after a tool it gives the owner's message as PostToolUse's added context, then sends the receipt", async () => {
    h.answer({ offer: "o-1", text: "the message" });
    const f = file();
    const printed = await run(["claude-code"], fixture("PostToolUse"), env(f));
    assert.deepEqual(
      printed.map((p) => JSON.parse(p)),
      [{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "the message" } }],
    );
    assert.deepEqual(
      h.asked.map((a) => [a.path, a.auth, a.body]),
      [
        [OFFER_PATH, "Bearer trial.tok", { at: "after-tool" }],
        [TAKEN_PATH, "Bearer trial.tok", { offer: "o-1" }],
      ],
    );
    assert.deepEqual(
      written(f).map((l) => [l.src, l.event]),
      [
        ["claude-code", "PostToolUse"],
        ["claude-code", "thermite.given"],
      ],
    );
    assert.equal(written(f)[0]?.payload.tool_use_id, "toolu_2");
  });

  test("at the turn's end it blocks the Stop with the message as its reason, so the program goes on", async () => {
    h.answer({ offer: "o-2", text: "the second" });
    const f = file();
    const printed = await run(["codex"], fixture("Stop"), env(f));
    assert.deepEqual(
      printed.map((p) => JSON.parse(p)),
      [{ decision: "block", reason: "the second" }],
    );
    assert.deepEqual(h.asked[0]?.body, { at: "turn-end" });
  });

  test("a planner's call in its own terminal asks with its call's credential", async () => {
    h.answer({ offer: "o-4", text: "to the planner" });
    const f = file();
    const printed = await run(["claude-code"], fixture("Stop"), env(f, "call.c0ffee"));
    assert.deepEqual(
      printed.map((p) => JSON.parse(p)),
      [{ decision: "block", reason: "to the planner" }],
    );
    assert.deepEqual(
      h.asked.map((a) => [a.path, a.auth]),
      [
        [OFFER_PATH, "Bearer call.c0ffee"],
        [TAKEN_PATH, "Bearer call.c0ffee"],
      ],
    );
  });

  test("it asks nothing before a tool, without an offer, without the trial's credential or in a subagent, and prints nothing", async () => {
    h.answer({ offer: null, text: "" });
    const f = file();
    assert.deepEqual(await run(["claude-code"], fixture("PreToolUse"), env(f)), []);
    assert.equal(h.asked.length, 0);
    assert.deepEqual(await run(["claude-code"], fixture("PostToolUse"), env(f)), []);
    assert.deepEqual(
      h.asked.map((a) => a.path),
      [OFFER_PATH],
      "no offer: no receipt",
    );
    h.answer({ offer: "o-3", text: "x" });
    assert.deepEqual(await run(["claude-code"], fixture("Stop"), env(f, "")), []);
    assert.deepEqual(await run(["claude-code"], fixture("Stop"), env(f, "proxy.tok")), []);
    const sub = JSON.stringify({ ...JSON.parse(fixture("PostToolUse")), agent_id: "a-1" });
    assert.deepEqual(await run(["claude-code"], sub, env(f)), []);
    assert.equal(h.asked.length, 0);
    assert.equal(written(f).length, 5, "every signal is written still");
  });

  test("Codex's notify comes as its last argument; a harness it can't reach leaves the program as it was", async () => {
    const f = file();
    await run(
      ["codex-notify", JSON.stringify({ type: "agent-turn-complete", "thread-id": "th-1" })],
      "",
      env(f),
    );
    assert.deepEqual(
      written(f).map((l) => [l.src, l.event, l.payload["thread-id"]]),
      [["codex-notify", "agent-turn-complete", "th-1"]],
    );
    const away = { ...env(f), THERMITE_HARNESS_URL: "http://127.0.0.1:9" };
    assert.deepEqual(await run(["codex"], fixture("Stop"), away), []);
  });

  test("a signal's strings are cut, and a line too long keeps only its plain fields", () => {
    const long = JSON.parse(
      signalLine("codex", "PostToolUse", { tool_response: "x".repeat(5000) }),
    );
    assert.equal(long.payload.tool_response.length, 1001);
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, { a: "y".repeat(900) }]),
    );
    const line = signalLine("codex", "PostToolUse", { session_id: "s-1", ...many });
    assert.ok(Buffer.byteLength(line) <= 16 * 1024);
    assert.deepEqual(JSON.parse(line).payload, { session_id: "s-1", cut: true });
  });

  test("run as the program, with its input on stdin, it prints the program's answer and exits 0; broken input changes nothing", async () => {
    h.answer({ offer: "o-4", text: "from the owner" });
    const f = file();
    const call = (stdin: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn(process.execPath, [HOOK_PROGRAM, "claude-code"], {
          env: { ...process.env, ...env(f) },
        });
        let out = "";
        p.stdout.on("data", (d) => {
          out += d;
        });
        p.on("close", (code) => resolve({ code, out }));
        p.stdin.end(stdin);
      });
    const ok = await call(fixture("Stop"));
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(ok.out), { decision: "block", reason: "from the owner" });
    const broken = await call("{ not json");
    assert.deepEqual(broken, { code: 0, out: "" });
  });

  test("its copies of the routes' paths, and the plugin's, are the routes'", () => {
    assert.equal(OFFER_PATH, TURN_OFFER.path);
    assert.equal(TAKEN_PATH, TURN_TAKEN.path);
    assert.equal(plugin.OFFER_PATH, TURN_OFFER.path);
    assert.equal(plugin.TAKEN_PATH, TURN_TAKEN.path);
  });
});

describe("the hooks in each program's settings for a trial (goal 169)", () => {
  test("Claude Code runs the hook program without a shell for each hook, and its compaction hooks where the conversation is kept", () => {
    const hooks = JSON.parse(claudeTrialSettings()).hooks as Record<
      string,
      { hooks: { command: string; args: string[] }[] }[]
    >;
    assert.deepEqual(Object.keys(hooks), [...CLAUDE_SIGNAL_HOOKS]);
    for (const e of CLAUDE_SIGNAL_HOOKS)
      assert.deepEqual(hooks[e]?.[0]?.hooks[0]?.args, [HOOK_PROGRAM, "claude-code"], e);
    const kept = JSON.parse(
      claudeTrialSettings({
        drops: "/a/claude-compactions",
        at: { dir: "/r/compactions", stem: "t-1", readable: true },
      }),
    ).hooks as Record<string, unknown>;
    assert.ok(kept.PreCompact && kept.PostCompact && kept.Stop);
  });

  test("Codex: its hooks.json, its notify before its first table, and the flag that runs untrusted hooks in `exec`", () => {
    const hooks = JSON.parse(codexHooks()).hooks as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    assert.deepEqual(Object.keys(hooks), [...CODEX_SIGNAL_HOOKS]);
    assert.equal(
      hooks.Stop?.[0]?.hooks[0]?.command,
      `'${process.execPath}' '${HOOK_PROGRAM}' 'codex'`,
    );
    const model = {
      baseUrl: "http://x",
      model: "m",
      apiKey: "k",
      contextWindow: 0,
      maxTokens: 0,
    };
    const toml = codexConfig(model, "http://h/v1/model-proxy", undefined, undefined, codexNotify());
    const notify = toml.indexOf("notify = [");
    assert.ok(notify > 0 && notify < toml.indexOf("\n["), toml);
    const args = codexArgs(model, { session: "th-1", hooks: true });
    assert.ok(args.indexOf("--dangerously-bypass-hook-trust") < args.indexOf("resume"));
    assert.ok(!codexArgs(model).includes("--dangerously-bypass-hook-trust"));
  });
});

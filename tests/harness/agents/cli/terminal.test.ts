/**
 * The trial loop's terminal mode (goal 169), on the fake TUI (tests/helpers/fake-tui.ts) in Claude
 * Code's place, through the terminal host and the local runner: the program and the host run as
 * the test's own user. The fake writes a transcript as Claude Code does and runs Thermite's hook
 * program as Claude Code's settings name it. Linux only, as the host's own tests: it needs
 * util-linux's setsid and node-pty; a refusal that comes before any terminal runs anywhere. The harness image's check (scripts/acceptance/terminal.mjs)
 * runs a trial through the same loop under the broker, with the fake and with the real programs.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { claudeProgram } from "../../../../src/agents/cli/claude-code.ts";
import type { ConsoleLater, TrialConsole } from "../../../../src/agents/cli/console.ts";
import { RoleTerminal } from "../../../../src/agents/cli/terminal.ts";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { messageText, type Prompt } from "../../../../src/agents/prompt.ts";
import { SETSID } from "../../../../src/agents/terminal/pty.ts";
import { signEnvelope } from "../../../../src/core/commands.ts";
import { laneLimits } from "../../../../src/core/contract.ts";
import { runCliTrial } from "../../../../src/harness/agents/cli/loop.ts";
import type { CliTrialDeps } from "../../../../src/harness/agents/cli/program.ts";
import { Registry } from "../../../../src/harness/agents/registry.ts";
import type { TrialResult, TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { fakeProgramRunner } from "../../../helpers/fake-program.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

const FAKE = join(import.meta.dirname, "..", "..", "..", "helpers", "fake-tui.ts");
const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "session-logs",
  "claude-code-2.1.308",
  "claude-print",
);
// util-linux's setsid starts the program on its terminal: Linux only, as the harness image is.
const skip = SETSID ? false : "needs util-linux's setsid (Linux), as the harness image has";
// Short: a socket's path is at most 104 bytes on some systems.
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tt-"));
const runner = new LocalRunner(scratch);
const AT = "2026-10-29T05:52:16.107Z";

// The fake in Claude Code's place: Claude Code's command line, with its version for its seeds.
const bin = join(scratch, "claude");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(bin, 0o755);
process.env.THERMITE_CLAUDE_BIN = bin;

const MODEL: ModelConfig = {
  api: "claude",
  harness: "claude-code",
  baseUrl: "https://api.anthropic.com",
  model: "claude-test",
  apiKey: "made-up-sign-in",
  contextWindow: 1_000_000,
  maxTokens: 0,
};

// Claude Code's transcript records, as the fake writes them for its session.
const S = "{session}";
const said = (text: string) => ({
  type: "user",
  sessionId: S,
  origin: { kind: "human" },
  message: { content: text },
});
const call = (i: number) => ({
  type: "assistant",
  sessionId: S,
  timestamp: AT,
  message: {
    id: `msg_${i}`,
    model: "claude-test",
    content: [{ type: "tool_use", id: `tu_${i}`, name: "Bash", input: { command: "make" } }],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
});
const result = (i: number) => ({
  type: "user",
  sessionId: S,
  message: { content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "ok" }] },
});
const answer = (i: number, text: string) => ({
  type: "assistant",
  sessionId: S,
  timestamp: AT,
  message: {
    id: `msg_${i}`,
    model: "claude-test",
    content: [{ type: "text", text }],
    usage: { input_tokens: 20, output_tokens: 5 },
  },
});
const ended = { type: "system", sessionId: S, subtype: "turn_duration" };
/** A turn that does nothing: the agent answers a nudge without any work. */
const idle = [{ lines: [said("x"), ended] }];
/** Claude Code's own message at a full usage window, with when it resets (seconds) if it says. */
const limitAt = (resetsAt?: number) => ({
  type: "assistant",
  sessionId: S,
  timestamp: AT,
  isApiErrorMessage: true,
  error: "rate_limit",
  apiError: "usage_limit_reached",
  ...(resetsAt
    ? { apiErrorParams: { rate_limit_info: { resetsAt, rateLimitType: "five_hour" } } }
    : {}),
  message: {
    id: "msg_limit",
    model: "<synthetic>",
    content: [{ type: "text", text: "You've hit your limit" }],
  },
});
/** Claude Code going on by itself after its usage window reset, as its transcript says. */
const goesOn = {
  type: "user",
  sessionId: S,
  isMeta: true,
  origin: { kind: "auto-continuation" },
  promptSource: "system",
  message: { content: "Your usage limit has reset. Continue the task." },
};

type Step =
  | { lines: unknown[] }
  | { hook: string; fields?: Record<string, unknown> }
  | { waitMs: number }
  | { touch: string }
  | { exit: number };

let n = 0;
/** A trial's area in the runner's scratch, and the fake's script for it. */
function area(turns: Step[][], rest: Step[] = idle) {
  const dir = join(scratch, `a${++n}`);
  mkdirSync(join(dir, "repo"), { recursive: true });
  const script = join(dir, "script.json");
  writeFileSync(
    script,
    JSON.stringify({ log: ".claude/projects/fake/{session}.jsonl", turns, rest }),
  );
  return { dir, script, home: join(dir, "claude-home") };
}

/** What the fake saw, from its own records, in the order it saw it. */
function seen(home: string): Record<string, unknown>[] {
  const folder = join(home, ".fake-tui");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".jsonl") && f !== "server.jsonl")
    .flatMap((f) => readFileSync(join(folder, f), "utf8").split("\n"))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .sort((a, b) => Number(a.t) - Number(b.t));
}

const pids = new Set<number>();
after(() => {
  // A program has a session of its own, which the local runner does not end.
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
});

/** One code trial of lane-1 in its terminal, in `a`, with what the test gives besides. */
async function trial(
  a: ReturnType<typeof area>,
  more: Partial<CliTrialDeps> & { trialId?: string; token?: string } = {},
): Promise<{ r: TrialResult; sent: Prompt[]; live: string[] }> {
  const sent: Prompt[] = [];
  const live: string[] = [];
  const spec: TrialSpec = {
    trialId: more.trialId ?? `t-${n}`,
    token: more.token ?? "tok",
    run: "js-1",
    lane: "lane-1",
    workspace: join(a.dir, "repo"),
    workspaceRoot: a.dir,
    parentCommit: "c".repeat(40),
    editablePaths: ["src/**"],
    brief: "Make it faster.",
  };
  const r = await runCliTrial(
    claudeProgram,
    { mode: "code", spec },
    {
      runner,
      model: MODEL,
      apiUrl: "http://127.0.0.1:9",
      live: (entries) => live.push(...entries.map((e) => e.text)),
      progress: () => undefined,
      sent: (p) => sent.push(p),
      env: { FAKE_TUI_SCRIPT: a.script },
      pollMs: 20,
      afterSubmitMs: 100,
      terminal: true,
      ...more,
    },
  );
  for (const s of seen(a.home)) if (s.type === "start") pids.add(Number(s.pid));
  return { r, sent, live };
}

/** Waits until `ok` gives something, at most `ms`. */
async function until<T>(what: string, ok: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = ok();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const types = (home: string) =>
  seen(home)
    .filter((s) => s.type !== "query")
    .map((s) => String(s.type));

test("follow_up is a worker in Pi's alone: a program in its terminal refuses it, in words (any system)", async () => {
  const run = {
    id: "t-1",
    role: "lane-1",
    title: "Trial t-1 (lane-1)",
    model: { baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "k" },
    apiUrl: "http://127.0.0.1:9",
    area: "/nowhere",
    home: "/nowhere/home",
    tmp: "/nowhere/tmp",
    auth: "trial.x",
    mcp: undefined,
    keptAt: undefined,
    wallMs: undefined,
    env: undefined,
  } as const;
  const t = new RoleTerminal(claudeProgram, run as never, {
    runner: new LocalRunner(mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tm-"))),
    cwd: "/nowhere",
    env: {},
    limits: laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }),
    signalsFile: "/nowhere/signals.jsonl",
    tally: {} as never,
  });
  await assert.rejects(
    t.ownerInput({ text: "then run the tests", follow_up: true }),
    /follow_up is for an agent in its Pi view: Claude Code takes what is typed into it as it comes/,
  );
});

describe("the trial loop's terminal mode on the fake TUI", { skip }, () => {
  test("its first message typed, never on its command line, its tally from its transcript, and a submission ends it its own way, its screen kept in memory", async () => {
    const a = area([
      [
        { lines: [said("go"), call(1)] },
        { hook: "PreToolUse", fields: { tool_name: "Bash", tool_use_id: "tu_1" } },
        { touch: "submitted" },
        { lines: [result(1), answer(2, "Submitted.")] },
        { waitMs: 60_000 },
      ],
    ]);
    let held: TrialConsole | undefined;
    const { r, sent, live } = await trial(a, {
      submitted: () =>
        existsSync(join(a.home, "submitted"))
          ? { attempt: "a-1", lifecycle: "submitted" }
          : undefined,
      console: (c) => {
        if (c !== "headless") held = c;
      },
    });
    assert.equal(r.stopped, "submitted");
    assert.equal(r.submitted?.attempt, "a-1");
    assert.deepEqual(
      { turns: r.turns, toolCalls: r.toolCalls, tokensIn: r.tokensIn, tokensOut: r.tokensOut },
      { turns: 2, toolCalls: 1, tokensIn: 30, tokensOut: 7 },
    );
    const got = seen(a.home);
    const start = got.find((s) => s.type === "start") as Record<string, unknown>;
    assert.equal(start.resumed, false);
    assert.equal((start.token as { length: number }).length, MODEL.apiKey.length);
    // The kept prompt is what it was given, typed once the program was ready: its command line
    // holds nothing after `--`, where any user of the computer could read it.
    assert.equal(sent.length, 1);
    assert.deepEqual(
      got.filter((s) => s.type === "user").map((s) => [s.how, s.text]),
      [["typed", messageText(sent[0] as Prompt)]],
    );
    // Its turn was under way: interrupted, then `/exit`.
    assert.deepEqual(types(a.home).slice(-2), ["interrupt", "exit"]);
    assert.ok(live.some((l) => l.startsWith("Bash ")));
    assert.ok(live.includes("Submitted."));
    // Its signals came from Thermite's hook program, as Claude Code's settings name it.
    assert.match(readFileSync(join(a.dir, "claude-signals.jsonl"), "utf8"), /"PreToolUse"/);
    // Its last screen, kept in memory for the live view, never in the trial's area.
    assert.match(held?.lastScreen()?.data ?? "", /fake-tui/);
    assert.ok(!existsSync(join(a.dir, "claude-screen.ansi")));
  });

  test("a turn's end in the log brings the next turn, typed; a program that exits is resumed in a new host with its session", async () => {
    const a = area([
      [{ lines: [said("go"), call(1), result(1), answer(2, "Tried one."), ended] }],
      [{ lines: [said("on"), call(3)] }, { exit: 1 }],
      [{ lines: [said("on"), call(4), result(4), answer(5, "Tried more."), ended] }],
    ]);
    const { r, sent } = await trial(a);
    assert.equal(r.stopped, "no_submission");
    const got = seen(a.home);
    const starts = got.filter((s) => s.type === "start");
    assert.deepEqual(
      starts.map((s) => s.resumed),
      [false, true],
    );
    assert.equal(starts[0]?.session, starts[1]?.session, "the same session, resumed");
    assert.ok(got.some((s) => s.type === "crash" && s.code === 1));
    // Each turn is typed, as the loop kept it: the first, the nudge, the one after the crash, the last.
    const typed = got.filter((s) => s.type === "user" && s.how === "typed").map((s) => s.text);
    assert.deepEqual(
      typed,
      sent.map((p) => messageText(p)),
    );
    assert.equal(sent.length, 4);
    // Each call's usage once, across the two hosts: the copy goes on where it was.
    assert.deepEqual(
      { turns: r.turns, toolCalls: r.toolCalls, tokensIn: r.tokensIn },
      { turns: 5, toolCalls: 3, tokensIn: 70 },
    );
  });

  test("a usage limit with no reset, or one more than a day away (a weekly window), ends the trial: nothing more is typed, and SIGTERM ends the program", async () => {
    // Claude Code's own message at a usage limit that gives no time it resets, then one that
    // resets in a week, which Claude Code meets with a menu that waits for a key.
    const week = Math.floor(Date.now() / 1000) + 7 * 86400;
    for (const resetsAt of [undefined, week]) {
      const a = area([
        [{ lines: [said("go"), call(1), result(1), limitAt(resetsAt), ended] }, { waitMs: 60_000 }],
      ]);
      const waits: unknown[] = [];
      const { r, sent } = await trial(a, { waiting: (w) => waits.push(w) });
      assert.equal(r.stopped, "error");
      assert.equal(r.errorKind, "rate_limit");
      assert.equal(r.retryAfter, resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined);
      assert.equal(sent.length, 1, "no turn after the limit");
      assert.deepEqual(waits, [], "nothing is waited for in the trial");
      const kinds = types(a.home);
      assert.ok(!kinds.includes("interrupt") && !kinds.includes("exit"), kinds.join(", "));
      assert.equal(kinds.at(-1), "sigterm");
    }
  });

  test("a full five-hour window is waited out: Claude Code goes on by itself after the reset, nothing is typed meanwhile, and the owner's input queued for the reset goes in then", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3;
    const a = area([
      [
        { lines: [said("go"), call(1), result(1), limitAt(reset), ended] },
        { waitMs: 3_500 },
        { lines: [goesOn, answer(2, "Went on."), ended] },
      ],
    ]);
    let held: TrialConsole | undefined;
    const waits: { until: string; kind: string }[] = [];
    const later: string[] = [];
    const running = trial(a, {
      console: (c) => {
        if (c !== "headless") held = c;
      },
      waiting: (w) => waits.push(w),
    });
    await until("the wait recorded", () => waits.length > 0);
    const c = await until("its console", () => held);
    const queued = await c.input({ text: "OWNER-QUEUED-1", wait: "queue" }, (o) => later.push(o));
    assert.deepEqual(queued, { outcome: "queued", until: new Date(reset * 1000).toISOString() });
    const { r, sent } = await running;
    assert.equal(r.stopped, "no_submission");
    assert.deepEqual(
      waits.map((w) => [w.until, w.kind]),
      [[new Date(reset * 1000).toISOString(), "rate_limit"]],
    );
    // Typed: its first message, the owner's input after the reset, then the loop's nudge; no
    // continuation of the loop's, since Claude Code went on by itself.
    const typed = seen(a.home).filter((s) => s.type === "user" && s.how === "typed");
    assert.deepEqual(
      typed.map((s) => s.text),
      [messageText(sent[0] as Prompt), "OWNER-QUEUED-1", messageText(sent[1] as Prompt)],
    );
    assert.equal(sent.length, 2);
    assert.ok(Number(typed[1]?.t) >= reset * 1000, "the owner's input went in after the reset");
    assert.deepEqual(later, ["typed_after_reset"]);
    assert.ok(!types(a.home).includes("sigterm"), "it was never ended in the wait");
  });

  test("Claude Code that does not go on after the reset is ended by SIGTERM, nothing typed into it, and its session resumed with the loop's continuation", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1;
    const a = area([
      [{ lines: [said("go"), call(1), result(1), limitAt(reset), ended] }, { waitMs: 60_000 }],
    ]);
    const { r, sent, live } = await trial(a, { pauseMs: (ms) => Math.min(ms, 1_500) });
    assert.equal(r.stopped, "no_submission");
    const got = seen(a.home).filter((s) => s.type !== "query");
    const kinds = got.map((s) => String(s.type));
    const term = kinds.indexOf("sigterm");
    assert.ok(term > 0, kinds.join(", "));
    const before = kinds.slice(0, term);
    assert.ok(!before.includes("interrupt") && !before.includes("exit"), kinds.join(", "));
    assert.deepEqual(
      got.filter((s) => s.type === "start").map((s) => s.resumed),
      [false, true],
    );
    assert.match(messageText(sent[1] as Prompt), /The model call failed \(You've hit your limit\)/);
    assert.equal(got.filter((s) => s.type === "user").at(1)?.text, messageText(sent[1] as Prompt));
    assert.match(live.join("\n"), /did not go on by itself after its usage window reset/);
  });

  test("a stop ends the program its own way, mid-turn, and the trial is interrupted", async () => {
    const a = area([[{ lines: [said("go"), call(1)] }, { waitMs: 60_000 }]]);
    const stop = new AbortController();
    let held: TrialConsole | undefined;
    const running = trial(a, {
      signal: stop.signal,
      console: (c) => {
        if (c !== "headless") held = c;
      },
    });
    await until("its first turn", () => seen(a.home).some((s) => s.type === "user"));
    await until("its tool call in the copy", () =>
      existsSync(join(a.dir, "claude-session.jsonl"))
        ? readFileSync(join(a.dir, "claude-session.jsonl"), "utf8").includes("tu_1")
        : false,
    );
    await new Promise((r) => setTimeout(r, 200));
    stop.abort();
    const { r } = await running;
    assert.equal(r.stopped, "interrupted");
    assert.deepEqual(types(a.home).slice(-2), ["interrupt", "exit"]);
    assert.ok(held?.lastScreen()?.data);
  });

  test("the owner's input goes into its terminal through its console: text then Enter, and keys by name", async () => {
    const a = area([[{ lines: [said("go"), call(1)] }, { waitMs: 60_000 }]]);
    const stop = new AbortController();
    let held: TrialConsole | undefined;
    const running = trial(a, {
      signal: stop.signal,
      console: (c) => {
        if (c !== "headless") held = c;
      },
    });
    await until("its first turn", () => seen(a.home).some((s) => s.type === "user"));
    const c = await until("its console", () => held);
    const later: ConsoleLater = () => assert.fail("nothing waited");
    assert.deepEqual(await c.input({ text: "OWNER-INPUT-1", wait: "queue" }, later), {
      outcome: "typed",
    });
    assert.deepEqual(await c.input({ keys: ["down", "page-up"], wait: "queue" }, later), {
      outcome: "typed",
    });
    await until("the owner's input in the program", () =>
      seen(a.home).some((s) => s.type === "user" && s.text === "OWNER-INPUT-1"),
    );
    await until("the keys in the program", () =>
      seen(a.home).some((s) => s.type === "key" && s.key === "page-up"),
    );
    const typed = seen(a.home).filter((s) => s.type === "user" && s.text === "OWNER-INPUT-1");
    assert.deepEqual(
      typed.map((s) => s.how),
      ["typed"],
    );
    assert.match((await c.screen())?.data ?? "", /fake-tui/);
    stop.abort();
    await running;
    await assert.rejects(c.input({ text: "too late", wait: "now" }, later), /trial has ended/);
  });

  test("while it waits for its usage window: an input waits for the reset, one sent now goes in and its turn is followed, and what waits is dropped when the trial ends first", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const a = area([[{ lines: [said("go"), call(1), result(1), limitAt(reset), ended] }]]);
    let held: TrialConsole | undefined;
    const waits: unknown[] = [];
    const outcomes: string[] = [];
    const running = trial(a, {
      console: (c) => {
        if (c !== "headless") held = c;
      },
      waiting: (w) => waits.push(w),
    });
    await until("the wait recorded", () => waits.length > 0);
    const c = await until("the limit shown", () => held?.limit() && held);
    const queued = await c.input({ text: "AFTER-THE-RESET", wait: "queue" }, (o, why) =>
      outcomes.push(`${o}: ${why ?? ""}`),
    );
    assert.equal(queued.outcome, "queued");
    assert.ok(queued.outcome === "queued" && queued.until);
    assert.deepEqual(await c.input({ text: "AT-ONCE", wait: "now" }, () => undefined), {
      outcome: "typed",
    });
    // The input sent now began a turn before the reset: the trial follows it, and then ends.
    const { r } = await running;
    assert.equal(r.stopped, "no_submission");
    assert.deepEqual(outcomes, [
      "dropped: the trial ended before the program's usage window reset",
    ]);
    const typedIn = seen(a.home)
      .filter((s) => s.type === "user")
      .map((s) => s.text);
    assert.ok(typedIn.includes("AT-ONCE"), typedIn.join(", "));
    assert.ok(!typedIn.includes("AFTER-THE-RESET"), typedIn.join(", "));
  });

  test("an owner's message goes in inside the turn, through the PostToolUse hook, with its receipt", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, { supervisor: "sup" });
    const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
    try {
      const id = `t-${String(++n).padStart(16, "0")}`;
      new Registry(env.ledger).startTrial({
        id,
        run: "js-1",
        lane: "lane-1",
        epoch: 1,
        family: "f",
        parent: "p",
        token: "tok-in-turn",
      });
      const at = { id, run: "js-1", lane: "lane-1" };
      const out = await env.service.applyCommand(
        signEnvelope(
          {
            v: 1,
            id: randomUUID(),
            rig: "rig-a",
            kind: "message_agent",
            issued_by: "owner",
            issued_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload: { run: "js-1", to: `trial:${id}`, text: "Look at the cache misses first." },
          },
          env.keys.privateKeyPem,
        ),
      );
      assert.equal(out.status, "applied");
      const a = area([
        [
          { lines: [said("go"), call(1)] },
          { hook: "PostToolUse", fields: { tool_name: "Bash", tool_use_id: "tu_1" } },
          { lines: [result(1), answer(2, "Looked."), ended] },
        ],
      ]);
      const { sent } = await trial(a, {
        trialId: id,
        token: "tok-in-turn",
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        messages: env.service.trialInbox(at),
        inTurn: (d) => env.service.inTurn(id, d),
      });
      const reads = env.ledger
        .eventsAfter(0, 5000)
        .events.filter((e) => e.kind === "agent_message_read")
        .map((e) => e.body as { trial?: string; how?: string });
      assert.deepEqual(
        reads.filter((x) => x.trial === id).map((x) => x.how),
        ["after-tool"],
      );
      // Kept as the trial's later turn, and not typed again in the nudge.
      assert.equal(sent[1]?.turn, 1);
      assert.match(messageText(sent[1] as Prompt), /Look at the cache misses first\./);
      assert.doesNotMatch(messageText(sent.at(-1) as Prompt), /cache misses/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("while its log shows a usage limit, its hooks are given none of the owner's messages: no Stop hook's block sends it on before the reset", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, { supervisor: "sup" });
    const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
    try {
      const id = `t-${String(++n).padStart(16, "0")}`;
      new Registry(env.ledger).startTrial({
        id,
        run: "js-1",
        lane: "lane-1",
        epoch: 1,
        family: "f",
        parent: "p",
        token: "tok-limit",
      });
      const at = { id, run: "js-1", lane: "lane-1" };
      const out = await env.service.applyCommand(
        signEnvelope(
          {
            v: 1,
            id: randomUUID(),
            rig: "rig-a",
            kind: "message_agent",
            issued_by: "owner",
            issued_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload: { run: "js-1", to: `trial:${id}`, text: "Look at the cache misses first." },
          },
          env.keys.privateKeyPem,
        ),
      );
      assert.equal(out.status, "applied");
      const reset = Math.floor(Date.now() / 1000) + 3600;
      // The limit, then a Stop hook while the limit shows, then the turn's end.
      const a = area([
        [
          { lines: [said("go"), call(1), result(1), limitAt(reset)] },
          { waitMs: 1_500 },
          { hook: "Stop", fields: { stop_hook_active: false, last_assistant_message: "x" } },
          { lines: [ended] },
        ],
      ]);
      const stop = new AbortController();
      const waits: unknown[] = [];
      const running = trial(a, {
        trialId: id,
        token: "tok-limit",
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        messages: env.service.trialInbox(at),
        inTurn: (d) => env.service.inTurn(id, d),
        waiting: (w) => waits.push(w),
        signal: stop.signal,
      });
      const signals = join(a.dir, "claude-signals.jsonl");
      await until("the Stop hook ran", () =>
        existsSync(signals) ? readFileSync(signals, "utf8").includes('"Stop"') : false,
      );
      await until("the wait", () => waits.length > 0);
      stop.abort();
      const { r, sent } = await running;
      assert.equal(r.stopped, "interrupted");
      assert.equal(sent.length, 1, "no turn typed after the limit");
      const reads = env.ledger
        .eventsAfter(0, 5000)
        .events.filter((e) => e.kind === "agent_message_read")
        .map((e) => e.body as { trial?: string });
      assert.deepEqual(
        reads.filter((x) => x.trial === id),
        [],
      );
      assert.equal(env.service.trialInbox(at).waiting().length, 1, "the message still waits");
      assert.doesNotMatch(readFileSync(signals, "utf8"), /thermite\.given/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("the tally is the headless path's for the same conversation (Claude Code 2.1.308's -p session)", async () => {
    const transcript = readFileSync(join(FIXTURE, "transcript.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as unknown);
    const stream = readFileSync(join(FIXTURE, "stream.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const a = area([[{ lines: transcript }]]);
    const { r: inTerminal } = await trial(a);
    const headless = fakeProgramRunner("claude-code", (k) => (k === 1 ? stream : []));
    const b = area([]);
    const { r: inHeadless } = await trial(b, { runner: headless.runner, terminal: false });
    const counts = (x: TrialResult) => ({
      stopped: x.stopped,
      turns: x.turns,
      toolCalls: x.toolCalls,
      tokensIn: x.tokensIn,
      tokensOut: x.tokensOut,
    });
    assert.deepEqual(counts(inTerminal), counts(inHeadless));
    assert.equal(inTerminal.turns, 2);
  });
});

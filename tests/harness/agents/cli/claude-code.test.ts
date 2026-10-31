import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { modelConfigFromEnv } from "../../../../src/agents/model/index.ts";
import {
  claudeArgs,
  claudeExitWords,
  claudeShell,
  closeClaudeRun,
  NO_CLAUDE_CODE,
  newClaudeTally,
  readClaudeEvents,
} from "../../../../src/agents/programs/claude-code/index.ts";
import { WORKER_CLAUDE_CODE_SYSTEM } from "../../../../src/agents/roles/worker.ts";
import { laneLimits } from "../../../../src/core/contract.ts";
import type { CallUsage } from "../../../../src/core/usage.ts";
import {
  claudeModelCheck,
  runClaudeTrial,
} from "../../../../src/harness/agents/cli/claude-code.ts";
import { ControlRoute } from "../../../../src/harness/agents/model/source.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import type { Runner, RunOutcome, RunRequest } from "../../../../src/harness/broker/runner.ts";
import { fakeProgramRunner } from "../../../helpers/fake-program.ts";

const RESET = 1_800_000_000;
const TOKEN = "sk-ant-oat01-test-token"; // public-check: allow (a made-up token shape for tests)
// Claude Code's stream-json output, shaped as version 2.1.302 prints it (trimmed; no real data).
const events = (o: { limited?: boolean } = {}) =>
  [
    { type: "system", subtype: "init", session_id: "s-1", tools: ["Bash"], mcp_servers: [] },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_1",
        content: [{ type: "thinking", thinking: "Read the file first." }],
        usage: { input_tokens: 4, cache_creation_input_tokens: 1000, output_tokens: 20 },
      },
    },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_1",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make" } }],
        usage: { input_tokens: 4, cache_creation_input_tokens: 1000, output_tokens: 30 },
      },
    },
    {
      type: "rate_limit_event",
      session_id: "s-1",
      rate_limit_info: {
        status: o.limited ? "rejected" : "allowed",
        resetsAt: RESET,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: o.limited ? 1 : 0.34, resetsAt: RESET },
          seven_day: { utilization: 0.61, resetsAt: RESET + 86_400 },
        },
      },
    },
    {
      type: "user",
      session_id: "s-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok\n", is_error: false }],
      },
    },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_2",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 5 },
      },
    },
    o.limited
      ? {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "You've hit your session limit",
          num_turns: 2,
        }
      : {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          num_turns: 2,
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 1000,
            output_tokens: 35,
          },
        },
  ].map((e) => JSON.stringify(e));

const model = {
  api: "claude" as const,
  harness: "claude-code" as const,
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-5-5",
  apiKey: TOKEN,
  contextWindow: 1_000_000,
  maxTokens: 0,
};

describe("Claude Code", () => {
  test("its stream-json becomes counters, live lines and the subscription's windows", () => {
    const t = newClaudeTally();
    const live = readClaudeEvents(events(), t);
    assert.equal(t.session, "s-1");
    assert.equal(t.turns, 2, "one message in several events is one turn");
    assert.equal(t.toolCalls, 1);
    assert.equal(t.tokensIn, 2006);
    assert.equal(t.tokensOut, 35);
    assert.deepEqual(t.tools, [{ tool: "Bash", output: "ok\n", ok: true }]);
    assert.equal(t.result, "Done.");
    assert.deepEqual(t.usage, {
      five_hour: { utilization: 0.34, resets_at: new Date(RESET * 1000).toISOString() },
      seven_day: { utilization: 0.61, resets_at: new Date((RESET + 86_400) * 1000).toISOString() },
    });
    assert.equal(t.limitedUntil, undefined);
    assert.deepEqual(
      live.map((l) => l.kind),
      ["thinking", "tool", "result", "text"],
    );
    const full = newClaudeTally();
    readClaudeEvents(events({ limited: true }), full);
    assert.equal(full.limitedUntil, new Date(RESET * 1000).toISOString());
    assert.match(full.errors.at(-1) ?? "", /session limit/);
  });

  test("its model usage: one record for each run, from its result, with the calls its stream showed", () => {
    const t = newClaudeTally();
    // The result's times, as Claude Code 2.1.305 gives them: from the run's start.
    const timed = events().map((line) => {
      const e = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify(
        e.type === "result"
          ? {
              ...e,
              duration_ms: 9000,
              duration_api_ms: 7000,
              ttft_ms: 1500,
              time_to_request_ms: 300,
            }
          : e,
      );
    });
    readClaudeEvents(timed, t);
    assert.equal(t.calls.length, 1);
    const [u] = t.calls;
    assert.equal(u?.calls, 2, "two messages: two model calls");
    assert.equal(u?.tokens_in, 2006);
    assert.equal(u?.cached_in, 1000);
    assert.equal(u?.uncached_in, 1006);
    assert.equal(u?.tokens_out, 35);
    assert.equal(u?.reasoning, null, "Claude Code names no reasoning tokens");
    assert.equal(u?.call_ms, 7000);
    assert.equal(u?.first_token_ms, 1200);
    // Without the result's times, no time is reported.
    const plain = newClaudeTally();
    readClaudeEvents(events(), plain);
    assert.equal(plain.calls[0]?.call_ms, null);
    assert.equal(plain.calls[0]?.first_token_ms, null);
    // A result whose usage names no cache read: not reported, never 0.
    const bare = newClaudeTally();
    readClaudeEvents(
      [
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 9, output_tokens: 3 },
        }),
      ],
      bare,
    );
    assert.equal(bare.calls[0]?.cached_in, null);
    assert.equal(bare.calls[0]?.calls, null, "no messages seen: the calls are not reported");
  });

  test("a run cut off before its result keeps the usage its stream showed, without times", () => {
    const t = newClaudeTally();
    readClaudeEvents(events().slice(0, 6), t);
    assert.equal(t.calls.length, 0);
    closeClaudeRun(t);
    assert.equal(t.calls.length, 1);
    const [u] = t.calls;
    assert.equal(u?.calls, 2);
    assert.equal(u?.tokens_in, 2006);
    // One message named no cache read: the run's cached input is not reported.
    assert.equal(u?.cached_in, null);
    assert.equal(u?.tokens_out, 35);
    assert.equal(u?.call_ms, null);
    closeClaudeRun(t);
    assert.equal(t.calls.length, 1, "a run is counted once");
  });

  test("it runs with no settings, no MCP servers and its permissions bypassed; the trial brief fits it", () => {
    const a = claudeArgs(model, { tools: "" });
    for (const f of ["--strict-mcp-config", "--setting-sources", "--permission-mode", "--verbose"])
      assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf("--setting-sources") + 1], "");
    assert.equal(a[a.indexOf("--tools") + 1], "");
    assert.equal(a[a.indexOf("--model") + 1], "claude-opus-5-5");
    assert.ok(!a.join(" ").includes("sk-ant"), "the token is never an argument");
    assert.match(WORKER_CLAUDE_CODE_SYSTEM, /Bash tool stops a command after two minutes/);
    assert.doesNotMatch(WORKER_CLAUDE_CODE_SYSTEM, /set timeout to 0/);
    // Claude Code keeps field notes with the same command as OpenCode.
    assert.match(
      WORKER_CLAUDE_CODE_SYSTEM,
      /keep field notes with "thermite-trial note --kind KIND/,
    );
  });

  const spec = (area: string, workspace: string, over: Partial<TrialSpec> = {}): TrialSpec => ({
    trialId: "t-1",
    token: "tok",
    run: "r-1",
    lane: "lane-1",
    workspace,
    workspaceRoot: area,
    parentCommit: "c".repeat(40),
    editablePaths: ["src/**"],
    brief: "Make it faster.",
    wallMs: 60_000,
    ...over,
  });
  /** A stand-in runner: setup succeeds; the Claude Code run appends `lines` to its events file. */
  const fakeRunner = (lines: string[], o: { submit?: boolean } = {}) =>
    fakeProgramRunner("claude-code", lines, o);
  const area = () => {
    const a = mkdtempSync(join(tmpdir(), "thermite-cc-"));
    mkdirSync(join(a, "repo"));
    return a;
  };

  test("a trial runs as the lane's user, with the token on a file descriptor and in no environment, and ends with the submission", async () => {
    const a = area();
    const f = fakeRunner(events(), { submit: true });
    const seen: unknown[] = [];
    const calls: CallUsage[] = [];
    const r = await runClaudeTrial(spec(a, join(a, "repo")), {
      runner: f.runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      usage: (u) => seen.push(u),
      modelUsage: (u) => calls.push(u),
      submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
      pollMs: 5,
    });
    assert.equal(r.stopped, "submitted");
    assert.equal(r.turns, 2);
    // The run's usage, from its result, reaches the harness once.
    assert.deepEqual(
      calls.map((u) => [u.calls, u.tokens_in, u.cached_in, u.tokens_out]),
      [[2, 2006, 1000, 35]],
    );
    assert.ok(f.runs.every((x) => x.role === "lane-1"));
    const run = f.runs.find((x) => x.argv.includes("-p")) as RunRequest;
    assert.equal(run.cwd, join(a, "repo"));
    // The token comes on stdin, which the shell moves to file descriptor 3 for Claude Code.
    assert.equal(run.stdin, TOKEN);
    assert.deepEqual(run.argv.slice(0, 3), [
      "sh",
      "-c",
      'exec 3<&0 && exec "$@" < "$THERMITE_CLAUDE_PROMPT" >> "$THERMITE_CLAUDE_EVENTS" 2>&1',
    ]);
    // The prompt, written by the lane into its own area, is Claude Code's stdin: no argument
    // carries it (goal 171).
    const wrote = f.runs.find((x) => x.argv.join(" ").includes("cat > claude-prompt.txt"));
    assert.equal(wrote?.cwd, a);
    assert.match(String(wrote?.stdin), /Make it faster\./);
    assert.equal(run.env?.THERMITE_CLAUDE_PROMPT, join(a, "claude-prompt.txt"));
    assert.ok(!run.argv.some((x) => x.includes("Make it faster")));
    assert.equal(run.env?.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, "3");
    assert.equal(run.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(
      !Object.values(run.env ?? {}).some((v) => v.includes("sk-ant")),
      "the token is in no variable",
    );
    // Claude Code's own sandbox stays off: the scrub would make it mandatory.
    assert.equal(run.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
    assert.equal(run.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    // The project's CLAUDE.md never joins the prompt (goal 166).
    assert.equal(run.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
    assert.equal(run.env?.HOME, join(a, "claude-home"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.THERMITE_PROXY_AUTH, undefined, "no key-adding proxy for a subscription");
    assert.ok(!run.argv.join(" ").includes("sk-ant"), "the token is never on the command line");
    assert.ok(seen.length > 0, "the subscription's windows were reported");
  });

  test("after a submission the run is stopped soon: the agent's closing reply is not waited for", async () => {
    const a = area();
    let submittedAt = 0;
    let killedAt = 0;
    let stop: () => void = () => undefined;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (req.argv.includes("-p")) {
          submittedAt = Date.now();
          // The agent goes on writing its closing reply until its processes are stopped.
          await new Promise<void>((r) => {
            stop = r;
          });
          return { exitCode: null, signal: "SIGKILL", killedFor: null } as unknown as RunOutcome;
        }
        return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
      },
      killRole: async () => {
        killedAt ||= Date.now();
        stop();
        return 1;
      },
    } as unknown as Runner;
    const r = await runClaudeTrial(spec(a, join(a, "repo")), {
      runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => (submittedAt ? { attempt: "a-1", lifecycle: "queued" } : undefined),
      pollMs: 5,
      afterSubmitMs: 50,
    });
    assert.equal(r.stopped, "submitted");
    assert.ok(killedAt - submittedAt >= 50, "the submit command gets its moment to finish");
    assert.ok(killedAt - submittedAt < 2_000, `stopped ${killedAt - submittedAt} ms after it`);
  });

  test("an owner's message waiting when a run ends without a submission resumes the session with it, and is read there; after a submission it waits for the lane's next trial", async () => {
    const inbox = (texts: string[]) => {
      let waiting = texts.map((text, i) => ({ id: i + 1, text }));
      const given: number[] = [];
      return {
        given,
        waiting: () => waiting,
        given_: (ids: number[]) => {
          given.push(...ids);
          waiting = waiting.filter((m) => !ids.includes(m.id));
        },
      };
    };
    const run = async (o: { submit: boolean }) => {
      const a = area();
      const f = fakeRunner(events(), { submit: o.submit });
      const owner = inbox(["look at the inner loop"]);
      // The worker keeps working each run: the campaign's nudges of 2 (goal 079: none by default).
      const r = await runClaudeTrial(
        spec(a, join(a, "repo"), {
          limits: { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), nudges: 2 },
        }),
        {
          runner: f.runner,
          model,
          apiUrl: "http://127.0.0.1:8700",
          live: () => undefined,
          progress: () => undefined,
          submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
          messages: { waiting: owner.waiting, given: owner.given_ },
          pollMs: 5,
        },
      );
      const runs = f.runs.filter((x) => x.argv.includes("-p"));
      const prompts = f.runs
        .filter((x) => x.argv.join(" ").includes("cat > claude-prompt.txt"))
        .map((x) => String(x.stdin));
      return { r, runs, prompts, given: owner.given };
    };
    const open = await run({ submit: false });
    assert.equal(open.prompts.length, 3);
    assert.match(String(open.prompts[1]), /campaign's owner: look at the inner loop/);
    assert.ok(open.runs[1]?.argv.join(" ").includes("--resume s-1"), "the same session");
    assert.doesNotMatch(String(open.prompts[2]), /campaign's owner/);
    assert.deepEqual(open.given, [1], "read once the resumed session started on it");
    const done = await run({ submit: true });
    assert.equal(done.r.stopped, "submitted");
    assert.equal(done.prompts.length, 1, "no continuation after a submission");
    assert.deepEqual(done.given, [], "it stays waiting for the lane's next trial");
  });

  test("a full usage window ends the trial with when it resets; a turn cap stops it", async () => {
    const a = area();
    const limited = fakeRunner(events({ limited: true }));
    const r = await runClaudeTrial(spec(a, join(a, "repo")), {
      runner: limited.runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 5,
    });
    assert.equal(r.stopped, "error");
    assert.equal(r.retryAfter, new Date(RESET * 1000).toISOString());
    assert.match(r.error ?? "", /usage window is full until/);
    const b = area();
    const capped = fakeRunner(events());
    const c = await runClaudeTrial(spec(b, join(b, "repo"), { maxTurns: 1 }), {
      runner: capped.runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 5,
    });
    assert.equal(c.stopped, "turns");
    assert.ok(capped.killed.includes("lane-1"));
  });

  test("the model check: one Bash call through Claude Code, with no tools beyond it", async () => {
    const runs: RunRequest[] = [];
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        const prompt = req.env?.THERMITE_CLAUDE_PROMPT;
        const asked = prompt ? readFileSync(prompt, "utf8") : "";
        const word = /echo (thermite-[a-z0-9]+)/.exec(asked)?.[1] ?? "";
        const out = req.argv.includes("-p")
          ? events()
              .join("\n")
              .replace('"ok\\n"', JSON.stringify(`${word}\n`))
          : "";
        return {
          exitCode: 0,
          signal: null,
          killedFor: null,
          stdout: out,
          stderr: "",
        } as RunOutcome;
      },
      killRole: async () => 0,
      handOver: async () => undefined,
      remove: async () => undefined,
    } as unknown as Runner;
    const r = await claudeModelCheck(model, {
      runner,
      apiUrl: "http://127.0.0.1:8700",
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-cc-check-")),
    });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /Claude Code/);
    const call = runs.find((x) => x.argv.includes("-p")) as RunRequest;
    assert.equal(call.argv[call.argv.indexOf("--tools") + 1], "Bash");
    assert.equal(call.stdin, TOKEN, "the token on stdin, for file descriptor 3");
    assert.deepEqual(call.argv.slice(0, 3), [
      "sh",
      "-c",
      'exec 3<&0 && exec "$@" < "$THERMITE_CLAUDE_PROMPT"',
    ]);
    assert.equal(call.env?.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, "3");
    assert.ok(!Object.values(call.env ?? {}).some((v) => v.includes("sk-ant")));
    assert.equal(call.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
    // The model check's own user: never a lane's, whose cleanup could kill it (or it theirs).
    assert.ok(runs.every((x) => x.role === "model-check"));
  });

  test("an image without Claude Code says so, not the shell's note", () => {
    assert.equal(
      claudeExitWords(126, "thermite-devfence: claude: No such file or directory\n"),
      NO_CLAUDE_CODE,
    );
    assert.equal(claudeExitWords(127, "sh: claude: not found"), NO_CLAUDE_CODE);
    // Claude Code starts behind the shell that gives it the token.
    assert.equal(claudeExitWords(127, "sh: 1: exec: claude: not found"), NO_CLAUDE_CODE);
    assert.equal(claudeExitWords(1, "something else"), "Claude Code exited 1: something else");
    // Its own error line wins over the source Bun prints after it.
    const bun = `error: bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y bubblewrap\n  at hGo (/$bunfs/root/chunk.js:11:7202)\n managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0`;
    assert.equal(
      claudeExitWords(1, " managed settings, or set X=0", bun),
      "Claude Code exited 1: bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y bubblewrap",
    );
    assert.equal(
      claudeExitWords(1, "  at x (y.js:1:2)", "error: Not logged in\n  at x (y.js:1:2)"),
      "Claude Code exited 1: Not logged in",
    );
  });

  test("the shell gives Claude Code the token on file descriptor 3, and its prompt's file for its stdin (goal 171)", () => {
    // A stand-in for Claude Code: what it reads on 0 and on 3, and whether its environment has it.
    const probe = `const fs = require("node:fs");
const fd3 = fs.readFileSync(3, "utf8");
const fd0 = fs.readFileSync(0, "utf8");
const inEnv = Object.values(process.env).some((v) => v.includes("made-up"));
console.log(JSON.stringify({ fd3, fd0, inEnv, args: process.argv.slice(2) }));`;
    const file = join(mkdtempSync(join(tmpdir(), "thermite-cc-fd-")), "claude.cjs");
    writeFileSync(file, probe);
    // A prompt longer than one argument may be on Linux (128 KiB).
    const prompt = `the prompt ${"x".repeat(200_000)}`;
    const promptFile = join(dirname(file), "claude-prompt.txt");
    writeFileSync(promptFile, prompt);
    const argv = claudeShell([process.execPath, file, "-p"]);
    const r = spawnSync(argv[0] as string, argv.slice(1), {
      input: "made-up-token",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
        THERMITE_CLAUDE_PROMPT: promptFile,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      fd3: "made-up-token",
      fd0: prompt,
      inEnv: false,
      args: ["-p"],
    });
  });

  test("a Claude subscription goes only with Claude Code, in a route or in the environment", () => {
    const route = {
      name: "claude-max",
      type: "claude" as const,
      harness: "pi" as const,
      version: 1,
      base_url: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      context_window: 0,
      max_tokens: 0,
      reasoning: null,
      key_hint: "…abcd",
      revision: "0123456789abcdef",
      api_key: "t",
    };
    assert.equal(ControlRoute.safeParse(route).success, false);
    assert.equal(ControlRoute.safeParse({ ...route, harness: "claude-code" }).success, true);
    const env = {
      THERMITE_MODEL_BASE_URL: "https://api.anthropic.com",
      THERMITE_MODEL: "claude-opus-5-5",
      THERMITE_MODEL_API_KEY: "t",
      THERMITE_MODEL_API: "claude",
    };
    assert.throws(
      () => modelConfigFromEnv(env),
      /runs only with THERMITE_AGENT_HARNESS=claude-code/,
    );
    assert.equal(
      modelConfigFromEnv({ ...env, THERMITE_AGENT_HARNESS: "claude-code" })?.harness,
      "claude-code",
    );
  });
});

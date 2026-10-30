/**
 * The one trial loop and the one one-prompt call of the agent programs that run as command-line
 * programs (goal 125, T7): each of their steps, in each program's entry, and the loop's research
 * mode.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { mcpLine } from "../../../../src/agents/mcp/tools.ts";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import type { PlanWindows } from "../../../../src/agents/programs/claude-code/windows.ts";
import { RESEARCH_WORKER_SYSTEM } from "../../../../src/agents/roles/research-worker.ts";
import { throughProxy } from "../../../../src/core/agents.ts";
import { laneLimits } from "../../../../src/core/contract.ts";
import type { CallUsage } from "../../../../src/core/usage.ts";
import { claudeProgram } from "../../../../src/harness/agents/cli/claude-code.ts";
import { codexProgram } from "../../../../src/harness/agents/cli/codex.ts";
import { runCliTrial } from "../../../../src/harness/agents/cli/loop.ts";
import { cliAsk, cliModelCheck, cliOnce } from "../../../../src/harness/agents/cli/once.ts";
import { opencodeProgram } from "../../../../src/harness/agents/cli/opencode.ts";
import type {
  CliProgram,
  CliTally,
  CliTrialDeps,
} from "../../../../src/harness/agents/cli/program.ts";
import type { ResearchTrialSpec } from "../../../../src/harness/agents/research/worker.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import type { RunRequest } from "../../../../src/harness/broker/runner.ts";
import { fakeProgramRunner, type Program } from "../../../helpers/fake-program.ts";

let seq = 0;

/**
 * Each program's entry, a route for it, and its output: tool calls, a provider's error; for a
 * one-prompt call, an answer with its usage, and a shell command that printed a word.
 */
const PROGRAMS: {
  program: Program;
  entry: CliProgram<CliTally>;
  model: ModelConfig;
  /** How a continued run names the session it continues. */
  resumes: string;
  turns(n: number): unknown[];
  failed(words: string): unknown[];
  answer(text: string): unknown[];
  printed(word: string): unknown[];
}[] = [
  {
    program: "opencode",
    entry: opencodeProgram,
    model: {
      baseUrl: "https://p.example/v1",
      model: "m-1",
      apiKey: "k",
      contextWindow: 0,
      maxTokens: 8192,
    },
    resumes: "--session ses_1",
    turns: (n) =>
      Array.from({ length: n }, () => [
        {
          type: "tool_use",
          sessionID: "ses_1",
          part: { tool: "shell", state: { status: "completed", input: {}, output: "ok" } },
        },
        { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 1, output: 1 } } },
      ]).flat(),
    failed: (words) => [{ type: "error", sessionID: "ses_1", error: { message: words } }],
    answer: (text) => [
      { type: "text", sessionID: "ses_1", part: { text } },
      { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 5, output: 2 } } },
    ],
    printed: (word) => [
      {
        type: "tool_use",
        sessionID: "ses_1",
        part: { tool: "shell", state: { status: "completed", input: {}, output: `${word}\n` } },
      },
    ],
  },
  {
    program: "claude-code",
    entry: claudeProgram,
    model: {
      api: "claude",
      harness: "claude-code",
      baseUrl: "https://api.anthropic.com",
      model: "claude-test",
      apiKey: "token",
      contextWindow: 1_000_000,
      maxTokens: 0,
    },
    resumes: "--resume s-1",
    turns: (n) =>
      Array.from({ length: n }, () => {
        const i = ++seq;
        return {
          type: "assistant",
          session_id: "s-1",
          message: {
            id: `msg_${i}`,
            content: [
              { type: "tool_use", id: `tu_${i}`, name: "Bash", input: { command: "make" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      }),
    failed: (words) => [
      { type: "result", subtype: "error", is_error: true, result: words, session_id: "s-1" },
    ],
    // Its subscription's windows come with the answer; the answer is its result's.
    answer: (text) => [
      {
        type: "rate_limit_event",
        session_id: "s-1",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1_900_000_000 } },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
        session_id: "s-1",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ],
    printed: (word) => [
      {
        type: "assistant",
        session_id: "s-1",
        message: {
          id: "msg_w",
          content: [{ type: "tool_use", id: "tu_w", name: "Bash", input: { command: "echo" } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "user",
        session_id: "s-1",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_w", content: `${word}\n`, is_error: false },
          ],
        },
      },
    ],
  },
  {
    program: "codex",
    entry: codexProgram,
    model: {
      api: "chatgpt",
      harness: "codex",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      apiKey: "access",
      contextWindow: 0,
      maxTokens: 0,
      reasoning: "off",
    },
    resumes: "resume th-1",
    turns: (n) => [
      { type: "thread.started", thread_id: "th-1" },
      ...Array.from({ length: n }, () => ({
        type: "item.completed",
        item: {
          id: `item_${++seq}`,
          type: "command_execution",
          command: "make",
          aggregated_output: "ok\n",
          exit_code: 0,
          status: "completed",
        },
      })),
    ],
    failed: (words) => [
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.failed", error: { message: words } },
    ],
    answer: (text) => [
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
    ],
    printed: (word) => [
      { type: "thread.started", thread_id: "th-1" },
      {
        type: "item.completed",
        item: {
          id: "i_w",
          type: "command_execution",
          command: "echo",
          aggregated_output: `${word}\n`,
          exit_code: 0,
          status: "completed",
        },
      },
    ],
  },
];

const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e));

const area = () => {
  const a = mkdtempSync(join(tmpdir(), "thermite-loop-"));
  mkdirSync(join(a, "repo"));
  return a;
};

const spec = (a: string, over: Partial<TrialSpec> = {}): TrialSpec => ({
  trialId: "t-1",
  token: "tok",
  run: "r-1",
  lane: "lane-1",
  workspace: join(a, "repo"),
  workspaceRoot: a,
  parentCommit: "c".repeat(40),
  editablePaths: ["src/**"],
  brief: "Make it faster.",
  wallMs: 60_000,
  ...over,
});

type Fake = ReturnType<typeof fakeProgramRunner>;

/** One trial in `p`'s entry on the stand-in runner `f`; `over` replaces any of its deps. */
function trial(
  p: (typeof PROGRAMS)[number],
  s: TrialSpec,
  f: Fake,
  over: Partial<CliTrialDeps> = {},
) {
  return runCliTrial(
    p.entry,
    { mode: "code", spec: s },
    {
      runner: f.runner,
      model: p.model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
      pollMs: 5,
      ...over,
    },
  );
}

/** The prompts a trial's runs were given, in order (Claude Code's, in its prompt's file). */
function prompts(f: Fake): string[] {
  const written = f.runs.filter((x) => x.argv.join(" ").includes("cat > claude-prompt.txt"));
  return (written.length ? written : f.programRuns()).map((x) => String(x.stdin));
}

const limits = (over: Partial<ReturnType<typeof laneLimits>>) => ({
  ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }),
  ...over,
});

describe("the CLI trial loop, in each program's entry", () => {
  test("a submission ends the trial: the program set up in the lane's area, then run in its workspace", async () => {
    for (const p of PROGRAMS) {
      const a = area();
      const f = fakeProgramRunner(p.program, lines(p.turns(2)), { submit: true });
      const r = await trial(p, spec(a), f);
      const name = p.entry.name;
      assert.equal(r.stopped, "submitted", name);
      assert.deepEqual(r.submitted, { attempt: "a-1", lifecycle: "queued" }, name);
      assert.equal(r.toolCalls, 2, name);
      assert.equal(f.programRuns().length, 1, `${name}: not continued`);
      assert.ok(
        f.runs.every((x) => x.role === "lane-1"),
        `${name}: as the lane`,
      );
      // Its setup comes first, in the lane's own area; the program runs in the workspace, with
      // its events file, the trial's paths and its token.
      assert.equal(f.runs[0]?.cwd, a, name);
      const run = f.programRuns()[0];
      assert.equal(run?.cwd, join(a, "repo"), name);
      assert.equal(run?.env?.[p.entry.eventsVar], join(a, `${p.entry.prefix}-events.jsonl`), name);
      assert.equal(run?.env?.THERMITE_WORKSPACE, join(a, "repo"), name);
      assert.equal(run?.env?.THERMITE_EDITABLE_PATHS, '["src/**"]', name);
      assert.equal(run?.env?.THERMITE_TRIAL_AUTH, "trial.tok", name);
      assert.ok(run?.rssLimitBytes && run.disk && run.nproc, `${name}: under the lane's limits`);
      assert.match(String(prompts(f)[0]), /Make it faster\./, name);
    }
  });

  test("the turn cap stops the program and ends the trial in words", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, lines(p.turns(3)), { hang: true });
      const r = await trial(p, spec(area(), { maxTurns: 2 }), f);
      assert.equal(r.stopped, "turns", p.entry.name);
      assert.equal(
        r.error,
        "the trial reached its limit of 2 turns before a submission",
        p.entry.name,
      );
      assert.ok(f.killed.includes("lane-1"), `${p.entry.name}: stopped at the cap`);
      assert.match(String(prompts(f)[0]), /at most 2 turns/, p.entry.name);
    }
  });

  test("a memory limit that stops the program ends the trial with the program's name and figures", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, lines(p.turns(1)), {
        outcome: {
          exitCode: null,
          signal: "SIGKILL",
          killedFor: "memory",
          peakRssBytes: 4400 * 1024 ** 2,
        },
      });
      const l = limits({ runRssMib: 4096 });
      const r = await trial(p, spec(area(), { limits: l }), f);
      assert.equal(r.stopped, "error", p.entry.name);
      assert.match(
        String(r.error),
        new RegExp(`^stopped by the lane's memory limit: ${p.entry.name} reached 4400 MiB`),
      );
      assert.equal(f.programRuns().length, 1, `${p.entry.name}: not continued`);
      assert.equal(f.programRuns()[0]?.rssLimitBytes, 4096 * 1024 * 1024, p.entry.name);
    }
  });

  test("the wall clock: a run gets the trial's time left, and one the clock stops ends the trial", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, lines(p.turns(1)), {
        outcome: { exitCode: null, signal: "SIGKILL", killedFor: "timeout" },
      });
      const r = await trial(p, spec(area()), f);
      assert.equal(r.stopped, "wall", p.entry.name);
      assert.equal(r.error, "the trial reached its 1-minute limit before a submission");
      const given = Number(f.programRuns()[0]?.timeoutMs);
      assert.ok(given > 50_000 && given <= 60_000, `${p.entry.name}: given ${given} ms`);
      // With its time used up before a run, no run starts.
      const late = fakeProgramRunner(p.program, lines(p.turns(1)));
      const l = await trial(p, spec(area(), { wallMs: 0 }), late);
      assert.equal(l.stopped, "wall", p.entry.name);
      assert.equal(late.programRuns().length, 0, p.entry.name);
    }
  });

  test("a provider's failure: no credits ends the trial with its kind; a passing fault waits and goes on in the same session", async () => {
    for (const p of PROGRAMS) {
      // The model proxy saw the provider's 402 (OpenCode, Codex); Claude Code's words are its own.
      const broke = fakeProgramRunner(p.program, lines(p.failed("402 insufficient credits")));
      const r = await trial(p, spec(area()), broke, {
        pauseMs: () => 5,
        providerAnswer: () => ({ status: 402, body: '{"error":"insufficient credits"}' }),
      });
      assert.deepEqual([r.stopped, r.errorKind], ["error", "credits"], p.entry.name);
      assert.equal(broke.programRuns().length, 1, p.entry.name);
      // Through the proxy, the program's words alone stop nothing: the model's own error, tried
      // again in the same session.
      if (throughProxy(p.model.api)) {
        const said = fakeProgramRunner(p.program, lines(p.failed("402 insufficient credits")));
        const w = await trial(p, spec(area(), { limits: limits({ failuresInARow: 2 }) }), said, {
          pauseMs: () => 5,
        });
        assert.deepEqual([w.stopped, w.errorKind], ["error", "model"], p.entry.name);
        assert.equal(said.programRuns().length, 2, `${p.entry.name}: went on once`);
      }
      const flaky = fakeProgramRunner(p.program, lines(p.failed("stream disconnected")));
      const waits: unknown[] = [];
      const e = await trial(p, spec(area(), { limits: limits({ failuresInARow: 2 }) }), flaky, {
        pauseMs: () => 5,
        waiting: (w) => waits.push(w),
      });
      assert.equal(e.stopped, "error", p.entry.name);
      assert.match(String(e.error), /failed 2 times in a row .*stream disconnected/, p.entry.name);
      assert.equal(flaky.programRuns().length, 2, `${p.entry.name}: went on once`);
      assert.equal(waits.length, 1, p.entry.name);
      assert.ok(
        flaky.programRuns()[1]?.argv.join(" ").includes(p.resumes),
        `${p.entry.name}: in the same session`,
      );
      assert.match(String(prompts(flaky)[1]), /^The model call failed/, p.entry.name);
    }
  });

  test("an exit with no session ends the trial in the program's words; with a session, the run is continued", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, ["boom"], { outcome: { exitCode: 1 } });
      const r = await trial(p, spec(area()), f);
      assert.equal(r.stopped, "error", p.entry.name);
      assert.equal(r.error, `${p.entry.name} exited 1: boom`);
      assert.equal(f.programRuns().length, 1, p.entry.name);
      // The same exit after the session started: nudged once, then ended without a submission.
      const session = fakeProgramRunner(p.program, sessionStart(p), { outcome: { exitCode: 1 } });
      const s = await trial(p, spec(area()), session);
      assert.equal(s.stopped, "no_submission", p.entry.name);
      assert.equal(s.error, undefined, p.entry.name);
      assert.equal(session.programRuns().length, 2, p.entry.name);
      assert.ok(session.programRuns()[1]?.argv.join(" ").includes(p.resumes), p.entry.name);
    }
  });

  test("the owner's messages continue the session: read once the agent starts on them, never after a submission", async () => {
    for (const p of PROGRAMS) {
      const run = async (submit: boolean) => {
        let waiting = [{ id: 1, text: "look at the inner loop" }];
        const given: number[] = [];
        const f = fakeProgramRunner(p.program, lines(p.turns(1)), { submit });
        // The worker keeps working each run: the campaign's nudges of 2 (none by default).
        const r = await trial(p, spec(area(), { limits: limits({ nudges: 2 }) }), f, {
          messages: {
            waiting: () => waiting,
            given: (ids) => {
              given.push(...ids);
              waiting = waiting.filter((m) => !ids.includes(m.id));
            },
          },
        });
        return { r, f, given, said: prompts(f) };
      };
      const open = await run(false);
      assert.equal(open.said.length, 3, p.entry.name);
      assert.match(String(open.said[1]), /campaign's owner: look at the inner loop/, p.entry.name);
      assert.ok(open.f.programRuns()[1]?.argv.join(" ").includes(p.resumes), p.entry.name);
      assert.doesNotMatch(String(open.said[2]), /campaign's owner/, p.entry.name);
      assert.deepEqual(open.given, [1], `${p.entry.name}: read once the session started on it`);
      const done = await run(true);
      assert.equal(done.r.stopped, "submitted", p.entry.name);
      assert.equal(done.said.length, 1, `${p.entry.name}: no continuation after a submission`);
      assert.deepEqual(done.given, [], `${p.entry.name}: it waits for the lane's next trial`);
    }
  });
});

/** A line of each program's output that starts its session and does no work. */
function sessionStart(p: (typeof PROGRAMS)[number]): string[] {
  if (p.program === "opencode")
    return lines([{ type: "text", sessionID: "ses_1", part: { text: "Looking." } }]);
  if (p.program === "claude-code")
    return lines([{ type: "system", subtype: "init", session_id: "s-1" }]);
  return lines([{ type: "thread.started", thread_id: "th-1" }]);
}

describe("the CLI trial loop's research mode", () => {
  const oc = PROGRAMS[0] as (typeof PROGRAMS)[number];
  /** A research trial in its own area, with the lane's working area of the folder in it. */
  const research = (a: string, over: Partial<ResearchTrialSpec> = {}) => {
    mkdirSync(join(a, "work"), { recursive: true });
    return {
      mode: "research" as const,
      spec: {
        trialId: "t-r",
        token: "tok",
        run: "r-1",
        lane: "lane-1",
        brief: "Topic: 2-bit decoding",
        wallMs: 60_000,
        ...over,
      },
      area: a,
      folder: { root: join(a, "folder"), work: join(a, "work") },
    };
  };
  const deps = (f: Fake, over: Partial<CliTrialDeps> = {}): CliTrialDeps => ({
    runner: f.runner,
    model: oc.model,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    pollMs: 5,
    ...over,
  });

  test("a research trial works in its lane's working area with the research prompt, makes no submission, and ends when the agent stops", async () => {
    const a = area();
    const f = fakeProgramRunner("opencode", lines(oc.turns(2)), { submit: true });
    const r = await runCliTrial(
      opencodeProgram,
      research(a, { mcpServers: ["docs"] }),
      // A submission the ledger has is no research trial's.
      deps(f, { submitted: () => ({ attempt: "a-1", lifecycle: "queued" }) }),
    );
    assert.equal(r.stopped, "finished");
    assert.equal(r.submitted, undefined);
    assert.equal(r.error, undefined);
    assert.equal(r.toolCalls, 2);
    assert.equal(f.programRuns().length, 1, "not continued: no message waits");
    assert.ok(f.runs.every((x) => x.role === "lane-1"));
    assert.equal(f.runs[0]?.cwd, a, "set up in its own area");
    const run = f.programRuns()[0] as RunRequest;
    assert.equal(run.cwd, join(a, "work"));
    assert.equal(run.env?.HOME, join(a, "opencode-home"));
    assert.equal(run.env?.THERMITE_OPENCODE_EVENTS, join(a, "opencode-events.jsonl"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.THERMITE_WORKSPACE, undefined, "nothing to submit");
    assert.equal(run.env?.THERMITE_EDITABLE_PATHS, undefined);
    const prompt = String(run.stdin);
    assert.ok(prompt.startsWith(RESEARCH_WORKER_SYSTEM));
    assert.match(prompt, /OpenCode itself included \(it uses about 650 MiB\)/);
    // The brief, then the trial's length; the MCP line last.
    assert.ok(
      prompt.endsWith(
        `Topic: 2-bit decoding\n\nThis trial lasts 1 minutes.\n\n${mcpLine(["docs"])}`,
      ),
    );
  });

  test("the owner's messages continue it while it works; its turns and its time end it, in words with no submission to name", async () => {
    let waiting = [{ id: 1, text: "look at Pascal too" }];
    const given: number[] = [];
    const f = fakeProgramRunner("opencode", lines(oc.turns(1)));
    const r = await runCliTrial(
      opencodeProgram,
      research(area()),
      deps(f, {
        messages: {
          waiting: () => waiting,
          given: (ids) => {
            given.push(...ids);
            waiting = waiting.filter((m) => !ids.includes(m.id));
          },
        },
      }),
    );
    assert.equal(r.stopped, "finished");
    const said = f.programRuns().map((x) => String(x.stdin));
    assert.equal(said.length, 2, "continued once, for the message; never nudged");
    assert.match(String(said[1]), /^Continue your research\.\n\n.*owner: look at Pascal too$/s);
    assert.ok(f.programRuns()[1]?.argv.join(" ").includes(oc.resumes), "in the same session");
    assert.deepEqual(given, [1]);
    const capped = fakeProgramRunner("opencode", lines(oc.turns(3)), { hang: true });
    const c = await runCliTrial(opencodeProgram, research(area(), { maxTurns: 2 }), deps(capped));
    assert.deepEqual([c.stopped, c.error], ["turns", "the trial reached its limit of 2 turns"]);
    assert.ok(capped.killed.includes("lane-1"));
    const late = fakeProgramRunner("opencode", lines(oc.turns(1)), {
      outcome: { exitCode: null, signal: "SIGKILL", killedFor: "timeout" },
    });
    const w = await runCliTrial(opencodeProgram, research(area()), deps(late));
    assert.deepEqual([w.stopped, w.error], ["wall", "the trial reached its 1-minute limit"]);
  });

  test("only a program whose entry says it runs research takes a research trial", async () => {
    assert.deepEqual(
      PROGRAMS.filter((p) => p.entry.research).map((p) => p.entry.name),
      ["OpenCode"],
    );
    for (const p of PROGRAMS.filter((x) => !x.entry.research)) {
      const f = fakeProgramRunner(p.program, lines(p.turns(1)));
      await assert.rejects(
        runCliTrial(p.entry, research(area()), { ...deps(f), model: p.model }),
        new RegExp(`^Error: ${p.entry.name} runs no research trials$`),
      );
      assert.equal(f.runs.length, 0, p.entry.name);
    }
  });
});

describe("the one-prompt call, in each program's entry", () => {
  const onceDeps = (f: Fake) => ({
    runner: f.runner,
    apiUrl: "http://127.0.0.1:8700",
    scratchDir: mkdtempSync(join(tmpdir(), "thermite-once-")),
    mintProxyToken: () => "proxy.minted",
  });

  test("a planner call runs as the planner's own user in a fresh folder, and answers with what the program said", async () => {
    for (const p of PROGRAMS) {
      const name = p.entry.name;
      const f = fakeProgramRunner(p.program, lines(p.answer("the plan")));
      const d = onceDeps(f);
      const usage: CallUsage[] = [];
      const windows: PlanWindows[] = [];
      const answer = await cliAsk(p.entry, p.model, "Plan the round.", d, {
        read: "/knowledge/r-1",
        usage: (u) => usage.push(u),
        windows: (w) => windows.push(w),
      });
      assert.equal(answer, "the plan", name);
      assert.equal(usage.length, 1, `${name}: its usage handed over`);
      assert.equal(windows.length, p.program === "claude-code" ? 1 : 0, `${name}: its windows`);
      // Its folder, under the lanes' area, is the planner's, set up first and removed after.
      const dir = f.handed[0]?.dir ?? "";
      assert.equal(f.handed[0]?.role, "planner", name);
      assert.match(dir, new RegExp(`/lanes/${p.entry.prefix}-ask/[0-9a-f-]{36}$`), name);
      assert.ok(dir.startsWith(d.scratchDir), name);
      assert.deepEqual(f.removed, [dir], name);
      assert.ok(f.runs.length >= 2 && f.runs.every((x) => x.role === "planner"), name);
      assert.ok(
        f.runs.every((x) => x.cwd === dir),
        name,
      );
      assert.equal(f.programRuns().length, 1, name);
      const run = f.programRuns()[0] as RunRequest;
      // The prompt on its stdin; Claude Code's in a file the controller wrote, with the token
      // on stdin, and the read-only file tools for past research.
      if (p.program === "claude-code") {
        assert.equal(run.stdin, p.model.apiKey, name);
        assert.equal(readFileSync(join(dir, "claude-prompt.txt"), "utf8"), "Plan the round.");
        assert.equal(run.argv[run.argv.indexOf("--tools") + 1], "Read,Grep,Glob", name);
      } else {
        assert.equal(run.stdin, "Plan the round.", name);
        assert.equal(run.argv[0], p.entry.exe() ?? p.entry.bin(), `${name}: by its path`);
        assert.equal(run.env?.THERMITE_PROXY_AUTH, "proxy.minted", `${name}: a minted credential`);
      }
      // With nothing to say, the call fails with the program's name.
      const quiet = fakeProgramRunner(p.program, []);
      await assert.rejects(
        cliAsk(p.entry, p.model, "Plan.", onceDeps(quiet)),
        new RegExp(`^Error: ${name} gave no answer$`),
      );
    }
  });

  test("a call the clock stops says so; one whose program fails, in the program's words", async () => {
    for (const p of PROGRAMS) {
      const late = fakeProgramRunner(p.program, [], { outcome: { killedFor: "timeout" } });
      const t = await cliOnce(p.entry, p.model, "Plan.", onceDeps(late), {
        role: "planner",
        timeoutMs: 2_000,
      });
      assert.deepEqual(t.errors, ["no answer in 2 s"], p.entry.name);
      const broke = fakeProgramRunner(p.program, ["boom"], { outcome: { exitCode: 1 } });
      const b = await cliOnce(p.entry, p.model, "Plan.", onceDeps(broke), { role: "planner" });
      assert.deepEqual(b.errors, [`${p.entry.name} exited 1: boom`], p.entry.name);
    }
  });

  test("the model check: one shell command through the program's own tool, as the model check's user", async () => {
    for (const p of PROGRAMS) {
      const name = p.entry.name;
      // The model runs the command the check asked for (Claude Code's prompt is in its file).
      const asked = (req: RunRequest) =>
        p.program === "claude-code"
          ? readFileSync(join(String(req.cwd), "claude-prompt.txt"), "utf8")
          : String(req.stdin);
      const f = fakeProgramRunner(p.program, (_n, req) =>
        lines(p.printed(/echo (thermite-[a-z0-9]+)/.exec(asked(req))?.[1] ?? "")),
      );
      const r = await cliModelCheck(p.entry, p.model, onceDeps(f));
      assert.equal(r.ok, true, r.summary);
      assert.match(
        r.summary,
        new RegExp(`answered with a correct tool call in .* s \\(${name}\\)$`),
      );
      const detail = r.detail as Record<string, unknown>;
      assert.equal(detail.harness, p.entry.id, name);
      assert.equal(detail.tool_called, true, name);
      // Where its route goes, but for Claude Code; Claude Code's windows instead.
      assert.equal(detail.base_url, p.program === "claude-code" ? undefined : p.model.baseUrl);
      assert.equal("usage" in detail, p.program === "claude-code", name);
      assert.ok(
        f.runs.every((x) => x.role === "model-check"),
        name,
      );
      const run = f.programRuns()[0] as RunRequest;
      assert.equal(
        run.argv.includes("--tools") ? run.argv[run.argv.indexOf("--tools") + 1] : undefined,
        p.program === "claude-code" ? "Bash" : undefined,
        name,
      );
      assert.match(asked(run), p.program === "claude-code" ? /Bash tool/ : /shell tool/, name);
      // A model that only talks fails the check, with what it wrote.
      const talks = fakeProgramRunner(p.program, lines(p.answer("I would run it.")));
      const no = await cliModelCheck(p.entry, p.model, onceDeps(talks));
      assert.equal(no.ok, false, name);
      assert.match(no.summary, new RegExp(`failed the tool-call check in ${name}: no tool call`));
    }
  });
});

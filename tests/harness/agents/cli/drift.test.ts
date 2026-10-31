/**
 * Where the trial loops of OpenCode, Claude Code and Codex had drifted apart, before they become
 * one loop (goal 125, T7): each case runs the same trial or call in each program it concerns.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CHATGPT_LIMIT_CODE, type ModelConfig } from "../../../../src/agents/model/index.ts";
import { NO_CLAUDE_CODE } from "../../../../src/agents/programs/claude-code/index.ts";
import { NO_CODEX } from "../../../../src/agents/programs/codex/index.ts";
import { NO_OPENCODE, opencodeExitWords } from "../../../../src/agents/programs/opencode/index.ts";
import { laneLimits } from "../../../../src/core/contract.ts";
import { claudeOnce, runClaudeTrial } from "../../../../src/harness/agents/cli/claude-code.ts";
import { codexOnce, runCodexTrial } from "../../../../src/harness/agents/cli/codex.ts";
import { PLANNER_ROLE } from "../../../../src/harness/agents/cli/common.ts";
import {
  type OpencodeTrialDeps,
  opencodeModelCheck,
  opencodeOnce,
  runOpencodeResearchTrial,
  runOpencodeTrial,
} from "../../../../src/harness/agents/cli/opencode.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import { fakeProgramRunner, type Program } from "../../../helpers/fake-program.ts";

const PROGRAMS: Program[] = ["opencode", "claude-code", "codex"];

const MODELS = {
  opencode: {
    baseUrl: "https://p.example/v1",
    model: "m-1",
    apiKey: "k",
    contextWindow: 0,
    maxTokens: 8192,
  },
  "claude-code": {
    api: "claude",
    harness: "claude-code",
    baseUrl: "https://api.anthropic.com",
    model: "claude-test",
    apiKey: "token",
    contextWindow: 1_000_000,
    maxTokens: 0,
  },
  codex: {
    api: "chatgpt",
    harness: "codex",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    apiKey: "access",
    contextWindow: 0,
    maxTokens: 0,
    reasoning: "off",
  },
} satisfies Record<Program, ModelConfig>;

let seq = 0;
/** `n` of a program's turns, each a tool call, in one session (Codex's thread starts it). */
function turns(program: Program, n: number): string[] {
  const each = Array.from({ length: n }, (): unknown[] => {
    const i = ++seq;
    if (program === "opencode")
      return [
        {
          type: "tool_use",
          sessionID: "ses_1",
          part: { tool: "shell", state: { status: "completed", input: {}, output: "ok" } },
        },
        { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 1, output: 1 } } },
      ];
    if (program === "claude-code")
      return [
        {
          type: "assistant",
          session_id: "s-1",
          message: {
            id: `msg_${i}`,
            content: [
              { type: "tool_use", id: `tu_${i}`, name: "Bash", input: { command: "make" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ];
    return [
      {
        type: "item.completed",
        item: {
          id: `item_${i}`,
          type: "command_execution",
          command: "make",
          aggregated_output: "ok\n",
          exit_code: 0,
          status: "completed",
        },
      },
    ];
  }).flat();
  const thread = program === "codex" ? [{ type: "thread.started", thread_id: "th-1" }] : [];
  return [...thread, ...each].map((e) => JSON.stringify(e));
}

const area = () => {
  const a = mkdtempSync(join(tmpdir(), "thermite-drift-"));
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

/** One code trial in `program`, on its runner `f`; `over` replaces any of the trial's deps. */
function trial(
  program: Program,
  s: TrialSpec,
  f: Fake,
  over: Partial<Omit<OpencodeTrialDeps, "model">> & { model?: ModelConfig } = {},
) {
  const deps: Omit<OpencodeTrialDeps, "model"> = {
    runner: f.runner,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
    pollMs: 5,
    ...over,
  };
  if (program === "opencode")
    return runOpencodeTrial(s, { ...deps, model: over.model ?? MODELS.opencode });
  if (program === "claude-code")
    return runClaudeTrial(s, { ...deps, model: over.model ?? MODELS["claude-code"] });
  return runCodexTrial(s, { ...deps, model: over.model ?? MODELS.codex });
}

/** The prompts a trial's runs were given, in order (Claude Code's, in its prompt's file). */
function prompts(f: Fake): string[] {
  const written = f.runs.filter((x) => x.argv.join(" ").includes("cat > claude-prompt.txt"));
  return (written.length ? written : f.programRuns()).map((x) => String(x.stdin));
}

describe("the agent programs' trial loops, where they had drifted apart", () => {
  test("a code trial's prompt states its turn cap in every program, OpenCode's as a model reply each", async () => {
    const said: Record<string, string> = {};
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p, turns(p, 1), { submit: true });
      const r = await trial(p, spec(area(), { maxTurns: 40 }), f);
      assert.equal(r.stopped, "submitted", p);
      said[p] = prompts(f)[0] ?? "";
    }
    assert.match(
      String(said.opencode),
      /at most 40 turns \(each model reply is one\)\. Submit before it ends\./,
    );
    assert.match(String(said["claude-code"]), /at most 40 turns \(each model reply is one\)/);
    assert.match(String(said.codex), /at most 40 turns \(each message or tool call is one\)/);
  });

  test("a trial stopped at its turn cap says so in words in every program; an OpenCode research trial too, with no submission to name", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p, turns(p, 3), { hang: true });
      const r = await trial(p, spec(area(), { maxTurns: 2 }), f);
      assert.equal(r.stopped, "turns", p);
      assert.equal(r.error, "the trial reached its limit of 2 turns before a submission", p);
      assert.ok(f.killed.includes("lane-1"), `${p}: stopped at the cap`);
    }
    const a = area();
    const f = fakeProgramRunner("opencode", turns("opencode", 3), { hang: true });
    const r = await runOpencodeResearchTrial(
      {
        trialId: "t-r",
        token: "tok",
        run: "r-1",
        lane: "lane-1",
        brief: "b",
        wallMs: 60_000,
        maxTurns: 2,
      },
      {
        runner: f.runner,
        model: MODELS.opencode,
        apiUrl: "http://127.0.0.1:8700",
        area: a,
        folder: { root: a, work: a },
        live: () => undefined,
        progress: () => undefined,
        pollMs: 5,
      },
    );
    assert.equal(r.stopped, "turns");
    assert.equal(r.error, "the trial reached its limit of 2 turns");
  });

  test("a run that ends by itself with the trial's turns used up ends the trial in every program: no other run starts", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p, turns(p, 2));
      // The worker keeps working, so without the cap a nudge would continue it.
      const limits = { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), nudges: 2 };
      // Its first poll comes after the run has ended.
      const r = await trial(p, spec(area(), { maxTurns: 2, limits }), f, { pollMs: 200 });
      assert.equal(r.stopped, "turns", p);
      assert.equal(f.programRuns().length, 1, `${p}: not continued`);
    }
  });

  test("a submission at the turn cap is waited for in every program: the cap stops the run only after the grace a submission has", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p, turns(p, 2), { hang: true });
      let submittedAt = 0;
      let killedAt = 0;
      const kill = f.runner.killRole.bind(f.runner);
      f.runner.killRole = async (role) => {
        killedAt ||= Date.now();
        return kill(role);
      };
      const r = await trial(p, spec(area(), { maxTurns: 1 }), f, {
        // The agent submitted at once: its submission is in the ledger while the run goes on.
        submitted: () => {
          if (!f.programRuns().length) return undefined;
          submittedAt ||= Date.now();
          return { attempt: "a-1", lifecycle: "queued" };
        },
        afterSubmitMs: 50,
      });
      assert.equal(r.stopped, "submitted", p);
      assert.ok(
        submittedAt > 0 && killedAt - submittedAt >= 50,
        `${p}: stopped ${killedAt - submittedAt} ms after it`,
      );
    }
  });

  test("a one-prompt call stopped before its run starts no program, in every program, and answers with nothing", async () => {
    for (const p of PROGRAMS) {
      for (const when of ["before the call", "during its setup"] as const) {
        const ctrl = new AbortController();
        if (when === "before the call") ctrl.abort();
        const f = fakeProgramRunner(p, turns(p, 1), { onSetup: () => ctrl.abort() });
        const deps = {
          runner: f.runner,
          apiUrl: "http://127.0.0.1:8700",
          scratchDir: mkdtempSync(join(tmpdir(), "thermite-drift-once-")),
          mintProxyToken: () => "proxy",
        };
        const o = { role: PLANNER_ROLE, signal: ctrl.signal };
        const t =
          p === "opencode"
            ? await opencodeOnce(MODELS.opencode, "plan", deps, o)
            : p === "claude-code"
              ? await claudeOnce(MODELS["claude-code"], "plan", deps, { ...o, tools: "" })
              : await codexOnce(MODELS.codex, "plan", deps, o);
        assert.equal(f.programRuns().length, 0, `${p}, stopped ${when}: no run`);
        assert.equal(t.lastText, "", `${p}, stopped ${when}`);
        assert.deepEqual(t.errors, [], `${p}, stopped ${when}`);
        // Stopped during its setup: the stop reached what the call's user ran.
        if (when === "during its setup") assert.deepEqual(f.killed, ["planner"], p);
      }
    }
  });

  test("OpenCode's binary is read at each call, by its full path, in a trial and in a one-prompt call", async () => {
    const was = {
      PATH: process.env.PATH,
      THERMITE_OPENCODE_BIN: process.env.THERMITE_OPENCODE_BIN,
    };
    const bin = mkdtempSync(join(tmpdir(), "thermite-drift-bin-"));
    writeFileSync(join(bin, "opencode-drift"), "");
    process.env.PATH = `${bin}:${was.PATH ?? ""}`;
    try {
      for (const [name, at] of [
        ["opencode-drift", join(bin, "opencode-drift")],
        ["opencode-missing", "opencode-missing"],
      ] as const) {
        process.env.THERMITE_OPENCODE_BIN = name;
        const f = fakeProgramRunner("opencode", turns("opencode", 1), { submit: true });
        await trial("opencode", spec(area()), f);
        assert.ok(f.programRuns()[0]?.argv.includes(at), `a trial runs ${at}`);
        const once = fakeProgramRunner("opencode", turns("opencode", 1));
        await opencodeOnce(
          MODELS.opencode,
          "plan",
          {
            runner: once.runner,
            apiUrl: "http://127.0.0.1:8700",
            scratchDir: mkdtempSync(join(tmpdir(), "thermite-drift-once-")),
            mintProxyToken: () => "proxy",
          },
          { role: PLANNER_ROLE },
        );
        assert.equal(once.programRuns()[0]?.argv[0], at, `a one-prompt call runs ${at}`);
      }
    } finally {
      for (const [k, v] of Object.entries(was))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  test("a full ChatGPT plan: a Codex trial waits as an OpenCode trial on a ChatGPT route does, for the same time and with the same words, and goes on", async () => {
    // OpenAI's refusal as the model proxy saw it; the program kept only an error's message.
    const words = "exceeded retry limit, last status: 429 Too Many Requests";
    const body = JSON.stringify({
      error: { code: CHATGPT_LIMIT_CODE, message: "The usage limit has been reached" },
    });
    const failed = {
      opencode: [{ type: "error", sessionID: "ses_1", error: { message: words } }],
      codex: [
        { type: "thread.started", thread_id: "th-1" },
        { type: "turn.failed", error: { message: words } },
      ],
    };
    const seen: Record<
      string,
      { waits: { until: string; kind: string; words: string }[]; second: string; at: number }
    > = {};
    for (const p of ["opencode", "codex"] as const) {
      const f = fakeProgramRunner(p, (n) =>
        n === 1 ? failed[p].map((e) => JSON.stringify(e)) : turns(p, 1),
      );
      const waits: { until: string; kind: string; words: string }[] = [];
      const at = Date.now();
      const r = await trial(p, spec(area()), f, {
        model: { ...MODELS.codex, harness: p },
        // The agent submits in its second run, the one after the wait.
        submitted: () =>
          f.programRuns().length >= 2 ? { attempt: "a-1", lifecycle: "queued" } : undefined,
        afterSubmitMs: 5,
        providerAnswer: () => ({ status: 429, headers: {}, body }),
        waiting: (w) => waits.push(w),
        pauseMs: () => 5,
      });
      assert.equal(r.stopped, "submitted", p);
      assert.equal(r.errorKind, undefined, p);
      assert.equal(r.retryAfter, undefined, p);
      assert.equal(f.programRuns().length, 2, `${p}: it went on in the same session`);
      seen[p] = { waits, second: prompts(f)[1] ?? "", at };
    }
    const [opencode, codex] = [seen.opencode, seen.codex];
    assert.ok(opencode && codex);
    for (const s of [opencode, codex]) {
      assert.equal(s.waits.length, 1);
      assert.equal(s.waits[0]?.kind, "rate_limit");
      assert.ok(String(s.waits[0]?.words).includes(CHATGPT_LIMIT_CODE));
      // OpenAI gives no time: the agents try again 15 minutes later.
      const wait = Date.parse(String(s.waits[0]?.until)) - s.at;
      assert.ok(wait >= 15 * 60_000 && wait < 15 * 60_000 + 10_000, `waits ${wait} ms`);
      assert.match(s.second, /^The model call failed \(.*\)\. Continue where you left off\./);
    }
    assert.equal(codex.waits[0]?.words, opencode.waits[0]?.words);
    assert.equal(codex.second, opencode.second);
  });

  test("a missing program ends its trial with words that say so, in every program; OpenCode's model check and research trial too", async () => {
    const no: Record<Program, [string, string]> = {
      opencode: ["opencode", NO_OPENCODE],
      "claude-code": ["claude", NO_CLAUDE_CODE],
      codex: ["codex", NO_CODEX],
    };
    for (const p of PROGRAMS) {
      const [bin, words] = no[p];
      // The shell that starts the program can't find it.
      const f = fakeProgramRunner(p, [`sh: 1: exec: ${bin}: not found`], {
        outcome: { exitCode: 127 },
      });
      const r = await trial(p, spec(area()), f);
      assert.equal(r.stopped, "error", p);
      assert.equal(r.error, words, p);
    }
    assert.match(NO_OPENCODE, /^this rig's harness image has no OpenCode binary: /);
    const a = area();
    const research = await runOpencodeResearchTrial(
      { trialId: "t-r", token: "tok", run: "r-1", lane: "lane-1", brief: "b" },
      {
        runner: fakeProgramRunner("opencode", ["sh: 1: exec: opencode: not found"], {
          outcome: { exitCode: 127 },
        }).runner,
        model: MODELS.opencode,
        apiUrl: "http://127.0.0.1:8700",
        area: a,
        folder: { root: a, work: a },
        live: () => undefined,
        progress: () => undefined,
        pollMs: 5,
      },
    );
    assert.equal(research.error, NO_OPENCODE);
    // The model check runs OpenCode behind the GPU fence, which can't find it either.
    const check = await opencodeModelCheck(MODELS.opencode, {
      runner: fakeProgramRunner("opencode", [], {
        outcome: {
          exitCode: 126,
          stderr: "thermite-devfence: /usr/local/bin/opencode: No such file or directory\n",
        },
      }).runner,
      apiUrl: "http://127.0.0.1:8700",
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-drift-check-")),
      mintProxyToken: () => "proxy",
    });
    assert.equal(check.ok, false);
    assert.ok(check.summary.includes(NO_OPENCODE), check.summary);
    // Any other exit keeps OpenCode's own words.
    assert.equal(
      opencodeExitWords(1, "stream disconnected"),
      "OpenCode exited 1: stream disconnected",
    );
  });
});

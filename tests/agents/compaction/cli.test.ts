import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  type CliCompacted,
  CliCompactions,
  codexCompactPrompt,
  compactionTokens,
  type KeptAt,
} from "../../../src/agents/compaction/cli.ts";
import {
  claudeCompactionEnv,
  newClaudeTally,
  readClaudeEvents,
} from "../../../src/agents/programs/claude-code/index.ts";
import {
  codexConfig,
  newCodexTally,
  readCodexEvents,
} from "../../../src/agents/programs/codex/index.ts";
import { OPENCODE_PLUGIN, opencodeConfig } from "../../../src/agents/programs/opencode/index.ts";
import type {
  OpencodeCompaction,
  OpencodePluginContext,
} from "../../../src/agents/programs/opencode/plugin.ts";
import { claudeOnce, runClaudeTrial } from "../../../src/harness/agents/cli/claude-code.ts";
import { codexOnce, runCodexTrial } from "../../../src/harness/agents/cli/codex.ts";
import { opencodeOnce, runOpencodeTrial } from "../../../src/harness/agents/cli/opencode.ts";
import type { TrialSpec } from "../../../src/harness/agents/worker/index.ts";
import type { Runner, RunOutcome, RunRequest } from "../../../src/harness/broker/runner.ts";

/**
 * Compaction in OpenCode v2, the Codex CLI and Claude Code (goal 070): each one's own settings
 * from the route's window (the owner's cap) and compaction point, and each compaction a harness
 * reports, with the program's own conversation (its PreCompact hook's copy, its rollout, or what
 * Thermite's plugin kept), else the conversation as Thermite saw it, and a summary that names
 * where the harness keeps it.
 */

const capped = {
  baseUrl: "https://p.example/v1",
  model: "m-1",
  apiKey: "k",
  contextWindow: 131_072,
  maxTokens: 0,
};

describe("compaction settings in each harness's own terms", () => {
  test("the compaction point: a share of the route's window, 80% unless set", () => {
    assert.equal(compactionTokens(capped), 104_857);
    assert.equal(compactionTokens({ ...capped, compactAt: 60 }), 78_643);
    assert.equal(
      compactionTokens({ ...capped, contextWindow: 0 }),
      undefined,
      "no window, no point",
    );
  });

  test("OpenCode: the model's window is the route's, and its buffer puts the point at the share", () => {
    const c = opencodeConfig({ ...capped, compactAt: 70 }, "http://h/v1/model-proxy") as {
      compaction: { auto: boolean; buffer?: number };
      providers: { thermite: { models: Record<string, { limit?: { context: number } }> } };
    };
    assert.deepEqual(c.providers.thermite.models["m-1"]?.limit, { context: 131_072 });
    // OpenCode compacts at its window less the buffer: 131,072 - 39,322 = 91,750 (70%).
    assert.deepEqual(c.compaction, { auto: true, buffer: 39_322 });
    assert.equal(
      131_072 - (c.compaction.buffer as number),
      compactionTokens({ ...capped, compactAt: 70 }),
    );
    // No window known: no limit, and OpenCode's own buffer.
    const open = opencodeConfig({ ...capped, contextWindow: 0 }, "http://h") as typeof c;
    assert.deepEqual(open.compaction, { auto: true });
    assert.equal(open.providers.thermite.models["m-1"]?.limit, undefined);
    // OpenCode's own models keep what OpenCode knows of them.
    const own = opencodeConfig({ ...capped, api: "opencode" }, "http://h") as typeof c;
    assert.deepEqual(own.compaction, { auto: true });
    assert.equal(own.providers, undefined);
  });

  test("Codex: the window and the token limit at which it compacts, before its tables", () => {
    const c = codexConfig({ ...capped, compactAt: 85 }, "http://h/v1/model-proxy");
    assert.match(c, /^model_context_window = 131072$/m);
    assert.match(c, /^model_auto_compact_token_limit = 111411$/m);
    assert.ok(
      c.indexOf("model_auto_compact_token_limit") < c.indexOf("[model_providers.thermite]"),
    );
    assert.match(codexConfig(capped, "http://h"), /^model_auto_compact_token_limit = 104857$/m);
    const open = codexConfig({ ...capped, contextWindow: 0 }, "http://h");
    assert.doesNotMatch(open, /model_context_window|model_auto_compact_token_limit/);
  });

  test("Claude Code: its compaction window and its percent, from the route", () => {
    assert.deepEqual(claudeCompactionEnv({ contextWindow: 200_000, compactAt: 75 }), {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
    });
    assert.deepEqual(claudeCompactionEnv({ contextWindow: 0 }), {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
    });
  });
});

describe("compactions a harness reports", () => {
  test("Claude Code's compact boundary is a compaction, with its tokens before and after", () => {
    const t = newClaudeTally();
    const live = readClaudeEvents(
      [
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", content: [{ type: "text", text: "Reading the kernel." }] },
        }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 160_512, post_tokens: 18_204 },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", content: [{ type: "text", text: "Going on after it." }] },
        }),
        JSON.stringify({ type: "system", subtype: "init" }),
      ],
      t,
    );
    assert.deepEqual(t.compactions, [{ at: 1, tokensBefore: 160_512, tokensAfter: 18_204 }]);
    assert.deepEqual(
      live.map((l) => l.text),
      ["Reading the kernel.", "Going on after it."],
    );
  });

  test("Codex's warning after its own compaction is a compaction, said in words instead", () => {
    const t = newCodexTally();
    const live = readCodexEvents(
      [
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text: "Building it." },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "error",
            message:
              "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_3", type: "error", message: "something else went wrong" },
        }),
      ],
      t,
    );
    assert.deepEqual(t.compactions, [{ at: 1, tokensBefore: null, tokensAfter: null }]);
    assert.deepEqual(
      live.map((l) => l.text),
      ["Building it.", "(Codex: something else went wrong)"],
    );
  });

  test("each compaction keeps the conversation as Thermite saw it until then", () => {
    const got: CliCompacted[] = [];
    const c = new CliCompactions({
      title: "Trial t-1 (lane-1)",
      harness: "Claude Code",
      on: (x) => got.push(x),
    });
    c.take(
      [
        { kind: "text", text: "first" },
        { kind: "tool", text: "Bash make" },
        { kind: "text", text: "after the compaction" },
      ],
      [{ at: 2, tokensBefore: 150_000, tokensAfter: 20_000 }],
    );
    c.take([{ kind: "text", text: "later" }], [{ at: 1, tokensBefore: null, tokensAfter: null }]);
    assert.equal(c.count, 2);
    assert.deepEqual(
      got.map((g) => [g.number, g.tokensBefore, g.tokensAfter]),
      [
        [1, 150_000, 20_000],
        [2, null, null],
      ],
    );
    const first = got[0]?.markdown ?? "";
    assert.match(
      first,
      /^# Trial t-1 \(lane-1\): the conversation before compaction 1, as Thermite saw it/,
    );
    assert.match(first, /## 1\. text\n\n```text\nfirst\n```/);
    assert.match(first, /## 2\. tool\n\n```text\nBash make\n```/);
    assert.doesNotMatch(first, /after the compaction/, "only what came before it");
    assert.match(
      got[1]?.markdown ?? "",
      /## 3\. text\n\n```text\nafter the compaction\n```[\s\S]*## 4\. text\n\n```text\nlater/,
    );
  });
});

const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
const ok = { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
const at: KeptAt = { dir: "/scratch/research/r-1/compactions", stem: "t-1", readable: true };
const trialArea = (name: string) => {
  const a = mkdtempSync(join(tmpdir(), `thermite-${name}-`));
  mkdirSync(join(a, "repo"));
  return a;
};
const trialSpec = (a: string): TrialSpec => ({
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
});
const trialDeps = (runner: Runner, submitted: () => boolean) => ({
  runner,
  apiUrl: "http://127.0.0.1:8700",
  live: () => undefined,
  progress: () => undefined,
  submitted: () => (submitted() ? { attempt: "a-1", lifecycle: "queued" as const } : undefined),
  pollMs: 5,
  afterSubmitMs: 10,
});

describe("each harness's own conversation, kept before its compaction and named in its summary", () => {
  test("Claude Code: its PreCompact hook copies the transcript and adds the line; the harness keeps the copy, with the summary that names the file", async () => {
    const a = trialArea("cc-keep");
    const runs: RunRequest[] = [];
    let submitted = false;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        if (!req.argv.includes("-p")) return ok;
        // Claude Code, compacting once: its transcript, then its PreCompact hook as its settings
        // name it, with the hook's input on stdin; the summary names what the hook said, and its
        // PostCompact hook gets the summary. Claude Code keeps the transcript private to the
        // agent's user: here it is where the harness does not look, so only the hooks' copies
        // reach it.
        const transcript = join(a, "private", "s-1.jsonl");
        mkdirSync(dirname(transcript), { recursive: true });
        writeFileSync(
          transcript,
          jsonl([
            { type: "user", message: { role: "user", content: "Make the kernel faster." } },
            {
              type: "assistant",
              message: {
                id: "m1",
                content: [
                  { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make" } },
                ],
              },
            },
            {
              type: "user",
              message: {
                content: [{ type: "tool_result", tool_use_id: "tu_1", content: "built" }],
              },
            },
          ]),
        );
        const argv = req.argv;
        const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}") as {
          hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
        };
        const run = (event: string, input: Record<string, unknown>) => {
          const hook = settings.hooks[event]?.[0]?.hooks[0] as { command: string; args: string[] };
          return spawnSync(hook.command, hook.args, {
            input: JSON.stringify({ session_id: "s-1", transcript_path: transcript, ...input }),
            encoding: "utf8",
          });
        };
        const said = run("PreCompact", { trigger: "auto" });
        run("PostCompact", {
          trigger: "auto",
          compact_summary: `Kernel built. ${said.stdout.trim()}`,
        });
        appendFileSync(
          transcript,
          jsonl([
            {
              type: "system",
              subtype: "compact_boundary",
              compactMetadata: { trigger: "auto", preTokens: 160_512 },
            },
            {
              type: "user",
              isCompactSummary: true,
              message: { content: `Kernel built. ${said.stdout.trim()}` },
            },
            {
              type: "assistant",
              message: { id: "m2", content: [{ type: "text", text: "Going on." }] },
            },
          ]),
        );
        appendFileSync(
          String(req.env?.THERMITE_CLAUDE_EVENTS),
          jsonl([
            { type: "system", subtype: "init", session_id: "s-1" },
            {
              type: "assistant",
              session_id: "s-1",
              message: { id: "m1", content: [{ type: "text", text: "Building." }] },
            },
            {
              type: "system",
              subtype: "compact_boundary",
              session_id: "s-1",
              compact_metadata: { trigger: "auto", pre_tokens: 160_512, post_tokens: 18_204 },
            },
            {
              type: "assistant",
              session_id: "s-1",
              message: { id: "m2", content: [{ type: "text", text: "Going on." }] },
            },
          ]),
        );
        await new Promise((r) => setTimeout(r, 30));
        submitted = true;
        return ok;
      },
      killRole: async () => 0,
    } as unknown as Runner;
    const got: CliCompacted[] = [];
    const r = await runClaudeTrial(trialSpec(a), {
      ...trialDeps(runner, () => submitted),
      model: {
        api: "claude",
        harness: "claude-code",
        baseUrl: "",
        model: "claude-opus-5-5",
        apiKey: "k",
        contextWindow: 200_000,
        maxTokens: 0,
      },
      keptAt: at,
      compacted: (c) => got.push(c),
    });
    assert.equal(r.compactions, 1);
    // Its setup makes the hook's folder, readable by the harness.
    assert.match(
      runs[0]?.argv[2] ?? "",
      /mkdir -p claude-home claude-tmp claude-compactions && chmod 0755 claude-compactions/,
    );
    const c = got[0] as CliCompacted;
    assert.equal(c.number, 1);
    assert.equal(c.own, true);
    assert.equal(c.tokensBefore, 160_512);
    assert.match(c.markdown, /from Claude Code's own transcript of the session/);
    assert.match(c.markdown, /Make the kernel faster[\s\S]*Tool result: Bash \(tu_1\)/);
    assert.doesNotMatch(c.markdown, /Going on/);
    // The summary names the file the harness keeps.
    assert.match(
      c.summary ?? "",
      /^Kernel built\. Thermite keeps the whole conversation before this compaction in \/scratch\/research\/r-1\/compactions\/t-1-1\.md\./,
    );
  });

  test("Codex: its compaction prompt names the folder; the harness keeps the conversation from its rollout, with its summary", async () => {
    const a = trialArea("codex-keep");
    let config = "";
    let submitted = false;
    const thread = "0199a213-0000-7000-8000-000000000001";
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (!req.argv.includes("exec")) {
          config = String(req.stdin ?? "");
          return ok;
        }
        // Codex, compacting once: its rollout of the thread in its home, then its warning.
        const day = join(String(req.env?.CODEX_HOME), "sessions", "2026", "10", "21");
        mkdirSync(day, { recursive: true });
        writeFileSync(
          join(day, `rollout-2026-10-21T00-00-00-${thread}.jsonl`),
          jsonl([
            { type: "session_meta", payload: { id: thread } },
            {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Make it faster." }],
              },
            },
            {
              type: "compacted",
              payload: { message: "Built it. Kept in /scratch/research/r-1/compactions/t-1-1.md." },
            },
          ]),
        );
        appendFileSync(
          String(req.env?.THERMITE_CODEX_EVENTS),
          jsonl([
            { type: "thread.started", thread_id: thread },
            {
              type: "item.completed",
              item: { id: "i0", type: "agent_message", text: "Building." },
            },
            {
              type: "item.completed",
              item: {
                id: "i1",
                type: "error",
                message:
                  "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.",
              },
            },
          ]),
        );
        await new Promise((r) => setTimeout(r, 30));
        submitted = true;
        return ok;
      },
      killRole: async () => 0,
    } as unknown as Runner;
    const got: CliCompacted[] = [];
    const r = await runCodexTrial(trialSpec(a), {
      ...trialDeps(runner, () => submitted),
      model: {
        baseUrl: "https://p.example/v1",
        model: "gpt-x",
        apiKey: "k",
        contextWindow: 200_000,
        maxTokens: 0,
      },
      keptAt: at,
      compacted: (c) => got.push(c),
    });
    assert.equal(r.compactions, 1);
    // Codex's own compaction prompt: Thermite's summary prompt, with where the conversation is kept.
    const prompt = /^compact_prompt = (".*")$/m.exec(config)?.[1] ?? '""';
    assert.equal(JSON.parse(prompt), codexCompactPrompt(at));
    assert.match(
      codexCompactPrompt(at),
      /in \/scratch\/research\/r-1\/compactions\/, as the newest file named t-1-<number>\.md/,
    );
    assert.ok(config.indexOf("compact_prompt") < config.indexOf("[model_providers.thermite]"));
    const c = got[0] as CliCompacted;
    assert.equal(c.own, true);
    assert.match(c.markdown, /from the Codex CLI's own rollout of the thread[\s\S]*Make it faster/);
    assert.equal(c.summary, "Built it. Kept in /scratch/research/r-1/compactions/t-1-1.md.");
  });

  test("OpenCode: Thermite's plugin keeps the session and names the file; the harness records each compaction the plugin saw end", async () => {
    const a = trialArea("oc-keep");
    const runs: RunRequest[] = [];
    let submitted = false;
    let line = "";
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        if (!req.argv.includes("run")) return ok;
        // OpenCode, compacting once with Thermite's plugin loaded, as its settings link it.
        const mod = (await import(OPENCODE_PLUGIN)) as {
          thermitePlugin: (env: NodeJS.ProcessEnv) => {
            setup: (ctx: OpencodePluginContext) => Promise<(() => void) | undefined>;
          };
        };
        let hook: ((e: OpencodeCompaction) => Promise<void> | void) | undefined;
        let push: (() => void) | undefined;
        const events: unknown[] = [];
        const ctx: OpencodePluginContext = {
          session: {
            hook: async (_n, cb) => {
              hook = cb;
            },
            context: async () => [{ type: "user", text: "Make it faster." }],
            get: async () => ({ id: "ses_1" }),
          },
          event: {
            subscribe: () => ({
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<unknown>>((resolve) => {
                    const take = () => resolve({ done: false, value: events.shift() });
                    if (events.length) take();
                    else push = take;
                  }),
              }),
            }),
          },
        };
        const stop = await mod.thermitePlugin(req.env ?? {}).setup(ctx);
        const e: OpencodeCompaction = { sessionID: "ses_1", system: [], messages: [] };
        await hook?.(e);
        line = e.system[0]?.text ?? "";
        events.push({
          type: "session.compaction.ended",
          data: {
            sessionID: "ses_1",
            text: `## Objective\n- faster\n\n## Relevant Files\n- ${line}`,
          },
        });
        push?.();
        await new Promise((r) => setTimeout(r, 20));
        stop?.();
        appendFileSync(
          String(req.env?.THERMITE_OPENCODE_EVENTS),
          jsonl([{ type: "text", sessionID: "ses_1", part: { text: "Going on." } }]),
        );
        await new Promise((r) => setTimeout(r, 30));
        submitted = true;
        return ok;
      },
      killRole: async () => 0,
    } as unknown as Runner;
    const got: CliCompacted[] = [];
    const r = await runOpencodeTrial(trialSpec(a), {
      ...trialDeps(runner, () => submitted),
      model: {
        baseUrl: "https://p.example/v1",
        model: "m-1",
        apiKey: "k",
        contextWindow: 131_072,
        maxTokens: 0,
      },
      keptAt: at,
      compacted: (c) => got.push(c),
    });
    assert.equal(r.compactions, 1);
    // Its setup links the plugin into OpenCode's own settings; its run has the plugin's folder
    // and the line naming the kept file.
    const setup = runs[0] as RunRequest;
    assert.match(
      setup.argv[2] ?? "",
      /ln -sf "\$1" opencode-home\/\.config\/opencode\/plugins\/thermite\.(ts|js)/,
    );
    assert.deepEqual(setup.argv.slice(3), ["sh", OPENCODE_PLUGIN]);
    const run = runs.find((x) => x.argv.includes("run")) as RunRequest;
    assert.equal(run.env?.THERMITE_COMPACTION_DROPS, join(a, "opencode-compactions"));
    assert.match(run.env?.THERMITE_COMPACTION_LINE ?? "", /compactions\/t-1-\{n\}\.md/);
    assert.match(line, /in \/scratch\/research\/r-1\/compactions\/t-1-1\.md\./);
    const c = got[0] as CliCompacted;
    assert.equal(c.own, true);
    assert.equal(c.tokensBefore, null);
    assert.match(c.markdown, /OpenCode's own session[\s\S]*Make it faster/);
    assert.match(
      c.summary ?? "",
      /## Relevant Files\n- Thermite keeps the whole conversation before this compaction in \/scratch\/research\/r-1\/compactions\/t-1-1\.md/,
    );
  });

  test("without a place to keep it, nothing is added to Codex's settings, as before", () => {
    assert.doesNotMatch(codexConfig(capped, "http://h"), /compact_prompt/);
    assert.match(codexConfig(capped, "http://h", undefined, at), /^compact_prompt = "/m);
  });
});

describe("a planner call's own compactions, kept once the call is over", () => {
  const planAt: KeptAt = {
    dir: "/scratch/research/r-1/compactions",
    stem: "planner-abc",
    readable: false,
  };
  /** A stand-in runner for one call: `run` acts as the program, in the call's own folder. */
  const onceRunner = (act: (req: RunRequest) => Promise<string>) => {
    const reclaimed: string[] = [];
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (req.argv[0] === "sh" && req.argv[1] === "-c" && !req.argv.includes("-p"))
          return { ...ok, stdout: "" };
        return { ...ok, stdout: await act(req) };
      },
      handOver: async () => undefined,
      reclaim: async (dir: string) => {
        reclaimed.push(dir);
      },
      remove: async () => undefined,
      killRole: async () => 0,
    } as unknown as Runner;
    return { runner, reclaimed };
  };
  const once = (runner: Runner) => ({
    runner,
    apiUrl: "http://127.0.0.1:8700",
    scratchDir: mkdtempSync(join(tmpdir(), "thermite-once-")),
    mintProxyToken: () => "minted",
  });

  test("Claude Code: the hook's copy and the summary, from the call's folder", async () => {
    const f = onceRunner(async (req) => {
      const transcript = join(String(req.env?.HOME), ".claude", "projects", "-p", "s-9.jsonl");
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, jsonl([{ type: "user", message: { content: "Plan the round." } }]));
      const settings = JSON.parse(req.argv[req.argv.indexOf("--settings") + 1] ?? "{}") as {
        hooks: { PreCompact: { hooks: { command: string; args: string[] }[] }[] };
      };
      const hook = settings.hooks.PreCompact[0]?.hooks[0] as { command: string; args: string[] };
      const said = spawnSync(hook.command, hook.args, {
        input: JSON.stringify({ session_id: "s-9", transcript_path: transcript, trigger: "auto" }),
        encoding: "utf8",
      });
      appendFileSync(
        transcript,
        jsonl([
          { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 90_000 } },
          { type: "user", isCompactSummary: true, message: { content: said.stdout.trim() } },
        ]),
      );
      return jsonl([
        { type: "system", subtype: "init", session_id: "s-9" },
        {
          type: "system",
          subtype: "compact_boundary",
          session_id: "s-9",
          compact_metadata: { pre_tokens: 90_000, post_tokens: 5_000 },
        },
        { type: "result", session_id: "s-9", subtype: "success", is_error: false, result: "{}" },
      ]);
    });
    const got: CliCompacted[] = [];
    const t = await claudeOnce(
      {
        api: "claude",
        harness: "claude-code",
        baseUrl: "",
        model: "m",
        apiKey: "k",
        contextWindow: 0,
        maxTokens: 0,
      },
      "Plan.",
      once(f.runner),
      {
        tools: "",
        timeoutMs: 10_000,
        role: "planner",
        compaction: { keptAt: planAt, title: "The planner", compacted: (c) => got.push(c) },
      },
    );
    assert.equal(t.result, "{}");
    assert.equal(f.reclaimed.length, 1, "the call's folder is taken back to read it");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.own, true);
    assert.match(
      got[0]?.markdown ?? "",
      /^# The planner: the conversation before compaction 1[\s\S]*Plan the round/,
    );
    assert.match(
      got[0]?.summary ?? "",
      /in \/scratch\/research\/r-1\/compactions\/planner-abc-1\.md\. Name that file in your summary, as where the conversation is kept\.$/,
    );
  });

  test("Codex: its rollout, from the call's folder", async () => {
    const thread = "0199a213-0000-7000-8000-000000000002";
    let config = "";
    const f = onceRunner(async (req) => {
      const day = join(String(req.env?.CODEX_HOME), "sessions", "2026", "10", "21");
      mkdirSync(day, { recursive: true });
      writeFileSync(
        join(day, `rollout-2026-10-21T00-00-00-${thread}.jsonl`),
        jsonl([
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Plan the round." }],
            },
          },
          { type: "compacted", payload: { message: "Planned so far." } },
        ]),
      );
      config = String(req.env?.CODEX_HOME);
      return jsonl([
        { type: "thread.started", thread_id: thread },
        {
          type: "item.completed",
          item: {
            id: "i1",
            type: "error",
            message:
              "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.",
          },
        },
        { type: "item.completed", item: { id: "i2", type: "agent_message", text: "{}" } },
      ]);
    });
    const got: CliCompacted[] = [];
    const t = await codexOnce(
      {
        baseUrl: "https://p.example/v1",
        model: "gpt-x",
        apiKey: "k",
        contextWindow: 0,
        maxTokens: 0,
      },
      "Plan.",
      once(f.runner),
      {
        role: "planner",
        timeoutMs: 10_000,
        compaction: { keptAt: planAt, title: "The planner", compacted: (c) => got.push(c) },
      },
    );
    assert.equal(t.lastText, "{}");
    assert.ok(config);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.summary, "Planned so far.");
    assert.match(got[0]?.markdown ?? "", /Codex CLI's own rollout[\s\S]*Plan the round/);
  });

  test("OpenCode: what the plugin kept, from the call's folder", async () => {
    const runs: RunRequest[] = [];
    const f = onceRunner(async (req) => {
      runs.push(req);
      // The plugin's records, as it writes them in its folder.
      const dir = String(req.env?.THERMITE_COMPACTION_DROPS);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "1.json"),
        JSON.stringify({ session: "ses_1", messages: [{ type: "user", text: "Plan the round." }] }),
      );
      writeFileSync(
        join(dir, "1.done.json"),
        JSON.stringify({ session: "ses_1", summary: "Planned so far." }),
      );
      return jsonl([{ type: "text", sessionID: "ses_1", part: { text: "{}" } }]);
    });
    const got: CliCompacted[] = [];
    const t = await opencodeOnce(
      {
        baseUrl: "https://p.example/v1",
        model: "m-1",
        apiKey: "k",
        contextWindow: 0,
        maxTokens: 0,
      },
      "Plan.",
      once(f.runner),
      {
        role: "planner",
        timeoutMs: 10_000,
        compaction: { keptAt: planAt, title: "The planner", compacted: (c) => got.push(c) },
      },
    );
    assert.equal(t.lastText, "{}");
    assert.match(runs[0]?.env?.THERMITE_COMPACTION_LINE ?? "", /planner-abc-\{n\}\.md/);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.summary, "Planned so far.");
    assert.match(got[0]?.markdown ?? "", /OpenCode's own session[\s\S]*Plan the round/);
  });
});

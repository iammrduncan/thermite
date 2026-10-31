import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { modelConfigFromEnv } from "../../../../src/agents/model/index.ts";
import {
  codexArgs,
  codexConfig,
  codexExitWords,
  NO_CODEX,
  newCodexTally,
  readCodexEvents,
  tomlString,
} from "../../../../src/agents/programs/codex/index.ts";
import { limitsNote } from "../../../../src/agents/roles/index.ts";
import { WORKER_CODEX_SYSTEM } from "../../../../src/agents/roles/worker.ts";
import { laneLimits } from "../../../../src/core/contract.ts";
import { codexModelCheck, runCodexTrial } from "../../../../src/harness/agents/cli/codex.ts";
import { ControlRoute } from "../../../../src/harness/agents/model/source.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import {
  LocalRunner,
  type Runner,
  type RunOutcome,
  type RunRequest,
} from "../../../../src/harness/broker/runner.ts";
import { fakeProgramRunner } from "../../../helpers/fake-program.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

const ACCESS = "chatgpt-access-token-for-tests";
const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";
// The Codex CLI's `exec --json` output, shaped as version 0.162.1 prints it (no real data).
const events = (o: { failed?: string } = {}) =>
  [
    { type: "thread.started", thread_id: THREAD },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Read it first." } },
    {
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc make",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc make",
        aggregated_output: "ok\n",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "file_change",
        changes: [{ path: "src/kernel/matmul.c", kind: "update" }],
        status: "completed",
      },
    },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Done." } },
    ...(o.failed
      ? [
          { type: "error", message: o.failed },
          { type: "turn.failed", error: { message: o.failed } },
        ]
      : [
          {
            type: "turn.completed",
            usage: {
              input_tokens: 2400,
              cached_input_tokens: 1200,
              cache_write_input_tokens: 0,
              output_tokens: 90,
              reasoning_output_tokens: 40,
            },
          },
        ]),
  ].map((e) => JSON.stringify(e));

const model = {
  api: "chatgpt" as const,
  harness: "codex" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test",
  apiKey: ACCESS,
  contextWindow: 0,
  maxTokens: 0,
  reasoning: "off" as const,
};

describe("the Codex CLI", () => {
  test("its JSON events become counters, live lines and the thread to resume", () => {
    const t = newCodexTally();
    const live = readCodexEvents(events(), t);
    assert.equal(t.session, THREAD);
    assert.equal(t.turns, 3, "each message and each tool call is one turn");
    assert.equal(t.toolCalls, 2);
    assert.equal(t.tokensIn, 2400);
    assert.equal(t.tokensOut, 90);
    assert.deepEqual(t.tools, [
      { tool: "shell", output: "ok\n", ok: true },
      { tool: "apply_patch", output: "update src/kernel/matmul.c", ok: true },
    ]);
    assert.equal(t.lastText, "Done.");
    assert.deepEqual(
      live.map((l) => l.kind),
      ["thinking", "tool", "result", "tool", "result", "text"],
    );
    // A resumed thread reports its whole total again: tokens are not counted twice.
    readCodexEvents(events(), t);
    assert.equal(t.tokensIn, 2400);
    // A failed command is a tool call that did not work; a failed turn is an error.
    const f = newCodexTally();
    readCodexEvents(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_9",
            type: "command_execution",
            command: "false",
            aggregated_output: "",
            exit_code: 1,
            status: "failed",
          },
        }),
        ...events({ failed: "unexpected status 401 Unauthorized: bad key" }),
        "not json at all",
      ],
      f,
    );
    assert.equal(f.tools[0]?.ok, false);
    assert.match(f.errors.at(-1) ?? "", /401/);
    assert.equal(f.notes.at(-1), "not json at all");
  });

  test("its model usage: one record for each turn, what the thread's totals grew by; no count of calls, no times", () => {
    const t = newCodexTally();
    readCodexEvents(events(), t);
    const turn = (input: number, cached: number, output: number, reasoning: number) =>
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
      });
    // The thread resumed: its totals grew.
    readCodexEvents([JSON.stringify({ type: "turn.started" }), turn(3000, 1500, 150, 60)], t);
    assert.deepEqual(
      t.calls.map((u) => [
        u.calls,
        u.tokens_in,
        u.cached_in,
        u.uncached_in,
        u.tokens_out,
        u.reasoning,
      ]),
      [
        [null, 2400, 1200, 1200, 90, 40],
        [null, 600, 300, 300, 60, 20],
      ],
    );
    assert.ok(t.calls.every((u) => u.call_ms === null && u.first_token_ms === null));
    // A new thread's totals, lower than before, are its own.
    readCodexEvents([turn(500, 0, 10, 0)], t);
    assert.equal(t.calls.at(-1)?.tokens_in, 500);
    // A usage without cache or reasoning figures: those are not reported.
    const bare = newCodexTally();
    readCodexEvents(
      [JSON.stringify({ type: "turn.completed", usage: { input_tokens: 70, output_tokens: 7 } })],
      bare,
    );
    assert.equal(bare.calls[0]?.cached_in, null);
    assert.equal(bare.calls[0]?.reasoning, null);
    assert.equal(bare.calls[0]?.tokens_in, 70);
  });

  test("it reaches the model only through the harness's proxy, with approvals and its sandbox off", () => {
    const a = codexArgs(model);
    for (const f of [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--dangerously-bypass-approvals-and-sandbox",
    ])
      assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf("--model") + 1], "gpt-test");
    assert.equal(a.at(-1), "-", "the prompt comes on stdin");
    assert.deepEqual(codexArgs(model, { session: THREAD }).slice(-3), ["resume", THREAD, "-"]);
    const c = codexConfig(model, "http://127.0.0.1:8700/v1/model-proxy");
    assert.match(c, /^model_provider = "thermite"$/m);
    assert.match(c, /^base_url = "http:\/\/127\.0\.0\.1:8700\/v1\/model-proxy"$/m);
    assert.match(c, /^env_key = "THERMITE_PROXY_AUTH"$/m);
    assert.match(c, /^wire_api = "responses"$/m);
    assert.match(c, /^model_reasoning_effort = "none"$/m, "off sends none");
    assert.match(c, /^web_search = "disabled"$/m);
    // The project's AGENTS.md never joins the prompt (goal 166).
    assert.match(c, /^project_doc_max_bytes = 0$/m);
    assert.match(c, /\[analytics\]\nenabled = false/);
    assert.match(c, /\[history\]\npersistence = "none"/);
    // Top-level keys come before the first table, as TOML needs.
    assert.ok(c.indexOf("web_search") < c.indexOf("[model_providers.thermite]"));
    assert.doesNotMatch(
      codexConfig({ ...model, reasoning: undefined }, "http://x"),
      /effort/,
      "unset: nothing is sent",
    );
    assert.ok(!`${a.join(" ")}${c}`.includes(ACCESS), "the access token is in neither");
    assert.equal(tomlString('a"b\\c\nd\u007f'), '"a\\"b\\\\c\\u000ad\\u007f"');
    assert.doesNotMatch(WORKER_CODEX_SYSTEM, /set timeout to 0/);
    assert.match(WORKER_CODEX_SYSTEM, /thermite-trial submit --hypothesis/);
    assert.match(WORKER_CODEX_SYSTEM, /keep field notes with "thermite-trial note --kind KIND/);
    const limits = limitsNote(laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), "Codex");
    assert.match(limits, /Codex itself included\./);
    assert.doesNotMatch(limits, /OpenCode|500 MiB/);
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
  /** A stand-in runner: setup succeeds; each Codex run appends `lines` to its events file. */
  const fakeRunner = (lines: string[], o: { submit?: boolean } = {}) =>
    fakeProgramRunner("codex", lines, o);
  const area = () => {
    const a = mkdtempSync(join(tmpdir(), "thermite-codex-"));
    mkdirSync(join(a, "repo"));
    return a;
  };
  const deps = (f: ReturnType<typeof fakeRunner>) => ({
    runner: f.runner,
    model,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
    pollMs: 5,
  });

  test("a trial runs as the lane's user with only the trial's token, and ends with the submission", async () => {
    const a = area();
    const f = fakeRunner(events(), { submit: true });
    const r = await runCodexTrial(spec(a, join(a, "repo")), deps(f));
    assert.equal(r.stopped, "submitted");
    assert.equal(r.turns, 3);
    assert.equal(r.tokensIn, 2400);
    assert.ok(f.runs.every((x) => x.role === "lane-1"));
    // Its home and configuration are made as the lane's user, in the lane's own area.
    const setup = f.runs[0] as RunRequest;
    assert.equal(setup.cwd, a);
    assert.match(String(setup.argv[2]), /cat > codex-home\/\.codex\/config\.toml/);
    assert.match(String(setup.stdin), /base_url = "http:\/\/127\.0\.0\.1:8700\/v1\/model-proxy"/);
    const run = f.programRuns()[0] as RunRequest;
    assert.equal(run.cwd, join(a, "repo"));
    assert.equal(run.env?.HOME, join(a, "codex-home"));
    assert.equal(run.env?.CODEX_HOME, join(a, "codex-home", ".codex"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.THERMITE_PROXY_AUTH, "trial.tok", "the proxy takes the trial's token");
    assert.match(String(run.stdin), /^You are a research worker/);
    assert.match(String(run.stdin), /Make it faster\./);
    assert.ok(run.rssLimitBytes && run.disk && run.nproc, "under the lane's limits");
    const everything = JSON.stringify(f.runs);
    assert.ok(!everything.includes(ACCESS), "the ChatGPT access token never reaches the lane");
  });

  test("an owner's message waiting when a run ends without a submission resumes the thread with it, and is read there; after a submission it waits for the lane's next trial", async () => {
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
      const r = await runCodexTrial(
        spec(a, join(a, "repo"), {
          limits: { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), nudges: 2 },
        }),
        {
          ...deps(f),
          messages: { waiting: owner.waiting, given: owner.given_ },
        },
      );
      const runs = f.programRuns();
      return { r, runs, prompts: runs.map((x) => String(x.stdin)), given: owner.given };
    };
    const open = await run({ submit: false });
    assert.equal(open.prompts.length, 3);
    assert.match(String(open.prompts[1]), /campaign's owner: look at the inner loop/);
    assert.ok(open.runs[1]?.argv.join(" ").includes(`resume ${THREAD} -`), "the same thread");
    assert.doesNotMatch(String(open.prompts[2]), /campaign's owner/);
    assert.deepEqual(open.given, [1], "read once the resumed thread started on it");
    const done = await run({ submit: true });
    assert.equal(done.r.stopped, "submitted");
    assert.equal(done.prompts.length, 1, "no continuation after a submission");
    assert.deepEqual(done.given, [], "it stays waiting for the lane's next trial");
  });

  test("a turn cap stops a trial; a failed run waits and resumes its thread; no credits the proxy saw ends it", async () => {
    const b = area();
    const capped = fakeRunner(events());
    const c = await runCodexTrial(spec(b, join(b, "repo"), { maxTurns: 1 }), deps(capped));
    assert.equal(c.stopped, "turns");
    assert.ok(capped.killed.includes("lane-1"));
    const d = area();
    const broken = fakeRunner([
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
    ]);
    // A dropped stream is a passing fault (goal 079): the trial waits and resumes the same
    // thread; only the campaign's failures_in_a_row ends it.
    const e = await runCodexTrial(
      spec(d, join(d, "repo"), {
        limits: { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), failuresInARow: 2 },
      }),
      { ...deps(broken), pauseMs: () => 5 },
    );
    assert.equal(e.stopped, "error");
    assert.match(e.error ?? "", /failed 2 times in a row .*stream disconnected/);
    assert.equal(broken.programRuns().length, 2, "resumed once");
    assert.ok(
      broken.programRuns()[1]?.argv.join(" ").includes(`resume ${THREAD} -`),
      "in the same thread",
    );
    // No credits, as the model proxy saw the provider answer: the trial ends at once, with its
    // kind, for the scheduler to stop the agents.
    const g = area();
    const broke = fakeRunner([
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      JSON.stringify({ type: "turn.failed", error: { message: "402 insufficient credits" } }),
    ]);
    const h = await runCodexTrial(spec(g, join(g, "repo")), {
      ...deps(broke),
      pauseMs: () => 5,
      providerAnswer: () => ({ status: 402, body: '{"error":"insufficient credits"}' }),
    });
    assert.deepEqual([h.stopped, h.errorKind], ["error", "credits"]);
    assert.equal(broke.programRuns().length, 1);
  });

  test("an image without the Codex CLI says so in words: in a trial and in the model check", async () => {
    /** A rig whose image has no Codex CLI: the shell, or the fence, can't find it. */
    const missing = (note: { file?: string; stderr?: string }) =>
      ({
        run: async (req: RunRequest): Promise<RunOutcome> => {
          if (!req.argv.includes("exec"))
            return {
              exitCode: 0,
              signal: null,
              killedFor: null,
              stdout: "",
              stderr: "",
            } as RunOutcome;
          if (note.file) appendFileSync(String(req.env?.THERMITE_CODEX_EVENTS), note.file);
          return {
            exitCode: note.file ? 127 : 126,
            signal: null,
            killedFor: null,
            stdout: "",
            stderr: note.stderr ?? "",
          } as RunOutcome;
        },
        killRole: async () => 0,
        handOver: async () => undefined,
        remove: async () => undefined,
      }) as unknown as Runner;
    const a = area();
    const trial = await runCodexTrial(spec(a, join(a, "repo")), {
      ...deps(fakeRunner([])),
      runner: missing({ file: "sh: 1: exec: codex: not found\n" }),
    });
    assert.equal(trial.stopped, "error");
    assert.equal(trial.error, NO_CODEX);
    assert.match(NO_CODEX, /^this rig's harness image has no Codex CLI: /);
    const check = await codexModelCheck(model, {
      runner: missing({
        stderr: "thermite-devfence: /opt/codex/bin/codex: No such file or directory\n",
      }),
      apiUrl: "http://127.0.0.1:8700",
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-codex-check-")),
      mintProxyToken: () => "proxy.minted-1",
    });
    assert.equal(check.ok, false);
    assert.ok(JSON.stringify(check).includes(NO_CODEX), check.summary);
    // Any other exit keeps Codex's own words.
    assert.equal(codexExitWords(1, "stream disconnected"), "Codex exited 1: stream disconnected");
  });

  test("the model check: one shell call through Codex, as the model check's own user, with a minted credential", async () => {
    const runs: RunRequest[] = [];
    let minted = 0;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        const word = /echo (thermite-[a-z0-9]+)/.exec(String(req.stdin))?.[1] ?? "";
        const out = req.argv.includes("exec")
          ? events()
              .join("\n")
              .replace('"aggregated_output":"ok\\n"', `"aggregated_output":"${word}\\n"`)
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
    const r = await codexModelCheck(model, {
      runner,
      apiUrl: "http://127.0.0.1:8700",
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-codex-check-")),
      mintProxyToken: () => `proxy.minted-${++minted}`,
    });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /\(Codex\)/);
    assert.equal((r.detail as { harness: string }).harness, "codex");
    const call = runs.find((x) => x.argv.includes("exec")) as RunRequest;
    assert.equal(call.env?.THERMITE_PROXY_AUTH, "proxy.minted-1");
    assert.equal(call.env?.THERMITE_TRIAL_AUTH, "");
    // The model check's own user: never a lane's, whose cleanup could kill it (or it theirs).
    assert.ok(runs.every((x) => x.role === "model-check"));
    assert.ok(!JSON.stringify(runs).includes(ACCESS));
    // Outside a trial (the model check, a planner call) Codex starts headless in a fresh folder
    // of the call's own, never in a copy of a workspace: no project's `.codex/` is there to load,
    // and no folder is trusted.
    assert.match(call.cwd ?? "", /\/lanes\/codex-ask\/[0-9a-f-]{36}$/);
    assert.ok(runs.every((x) => x.cwd === call.cwd));
    assert.ok(call.argv.includes("--ignore-rules"));
    const setup = runs.find((x) => !x.argv.includes("exec")) as RunRequest;
    assert.match(String(setup.stdin), /^project_doc_max_bytes = 0$/m);
    assert.doesNotMatch(String(setup.stdin), /\[projects\.|trust_level/);
  });

  test("Codex goes only with OpenAI's Responses API: a ChatGPT sign-in or an OpenAI route, in a route or in the environment", () => {
    const route = {
      name: "chatgpt-pro",
      type: "chatgpt" as const,
      harness: "codex" as const,
      version: 1,
      base_url: "https://api.openai.com/v1",
      model: "gpt-test",
      context_window: 0,
      max_tokens: 0,
      reasoning: null,
      key_hint: "…abcd",
      revision: "0123456789abcdef",
      api_key: "t",
    };
    assert.equal(ControlRoute.safeParse(route).success, true);
    assert.equal(ControlRoute.safeParse({ ...route, type: "openai" }).success, true);
    for (const type of ["anthropic", "opencode"] as const)
      assert.equal(ControlRoute.safeParse({ ...route, type }).success, false, type);
    const env = {
      THERMITE_MODEL_BASE_URL: "https://api.openai.com/v1",
      THERMITE_MODEL: "gpt-test",
      THERMITE_MODEL_API_KEY: "t",
      THERMITE_AGENT_HARNESS: "codex",
    };
    assert.equal(modelConfigFromEnv(env)?.harness, "codex");
    assert.equal(modelConfigFromEnv({ ...env, THERMITE_MODEL_API: "chatgpt" })?.harness, "codex");
    assert.throws(
      () => modelConfigFromEnv({ ...env, THERMITE_MODEL_API: "anthropic" }),
      /speaks only OpenAI's Responses API/,
    );
    assert.throws(
      () => modelConfigFromEnv({ ...env, THERMITE_AGENT_HARNESS: "codecs" }),
      /must be pi, opencode, claude-code or codex/,
    );
  });

  test("a route whose agents run in Codex plans in Codex, and a Pi route does not", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    const asked: { model: string; prompt: string }[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "codex-test",
      ask: async (via, m, prompt) => {
        if (via !== "codex") throw new Error(`not ${via}`);
        asked.push({ model: m.model, prompt });
        return JSON.stringify({
          new_families: [{ id: "cx-tidy", description: "Small tidy-ups." }],
          assignments: [
            { lane: "lane-1", family: "cx-tidy", focus: "tidy the kernel", parent: "champion" },
          ],
          notes: "planned in Codex",
        });
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.model, "gpt-test");
    assert.match(asked[0]?.prompt ?? "", /The campaign, as JSON:/);
    const epoch = env.ledger.db.prepare("select source from epoch where n = 1").get() as {
      source: string;
    };
    assert.equal(epoch.source, "planner");
    // The same sign-in with its agents in Pi: the planner is Pi's (here its model is unreachable,
    // so the fixed rules plan), never Codex.
    const pi = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await pi.start();
    const other = new Scheduler({
      service: pi.service,
      runner: new LocalRunner(pi.paths.scratchDir),
      model: { ...model, harness: undefined, baseUrl: "http://127.0.0.1:9/v1" },
      owner: "codex-test",
      ask: async (_via, m, prompt) => {
        asked.push({ model: m.model, prompt });
        return "{}";
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await other.tick();
    await other.idle();
    assert.equal(asked.length, 1, "Codex was not asked");
    const fallback = pi.ledger.db.prepare("select source from epoch where n = 1").get() as {
      source: string;
    };
    assert.equal(fallback.source, "fallback");
  });
});

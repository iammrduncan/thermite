import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Prompt } from "../../../src/agents/prompt.ts";
import { runClaudeTrial } from "../../../src/harness/agents/cli/claude-code.ts";
import { runCodexTrial } from "../../../src/harness/agents/cli/codex.ts";
import {
  runOpencodeResearchTrial,
  runOpencodeTrial,
} from "../../../src/harness/agents/cli/opencode.ts";
import { runPiTrial } from "../../../src/harness/agents/programs.ts";
import {
  type ResearchTrialSpec,
  runResearchTrial,
} from "../../../src/harness/agents/research/worker.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import { runTrial, type TrialSpec } from "../../../src/harness/agents/worker/index.ts";
import type { createHarnessApi } from "../../../src/harness/api/index.ts";
import {
  LocalRunner,
  type Runner,
  type RunOutcome,
  type RunRequest,
} from "../../../src/harness/broker/runner.ts";
import { keepPrompt } from "../../../src/harness/prompts.ts";
import type { Research } from "../../../src/harness/research/research/index.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";
import { makeResearchRun } from "../../helpers/research-run.ts";
import { golden, kept, keptInput, laneTool, PLAN, recorder, sections } from "./capture.ts";

/**
 * The work's roles' whole prompts: the planners, the workers and the research workers, in Pi and in
 * the other programs (goal 166).
 */
describe("every role's whole prompt for a sample run (goal 166)", () => {
  test("a hill-climb run's planner and worker, in Pi", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    // The sample run has what a brief carries: an owner's message in force and a queued idea.
    const run = (env.assign.envelope.payload as { run: string }).run;
    const command = (kind: Parameters<typeof env.sign>[0], payload: unknown) =>
      env.service.applyCommand(env.sign(kind, payload));
    await command("message_agent", {
      run,
      to: "all",
      text: "Prefer a change a reader can follow.",
      keep: true,
    });
    await command("queue_add", {
      run,
      title: "Unroll the loop by four",
      family: "loops",
      why: "the loop does one add per step",
    });
    const { sent, script } = recorder(({ tools }) =>
      tools.some((t) => t.function.name === "submit_plan") ? PLAN : { text: "done" },
    );
    const fake = await startFakeModel(script);
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "prompts-test",
      // As a rig runs it in Pi (programs.ts): its prompt rendered and kept by the harness, then
      // the worker, here in this process.
      runTrial: (spec) =>
        runPiTrial(
          { mode: "code", spec },
          {
            handOver: () => () => undefined,
            sent: (p) =>
              keepPrompt(env.service.ledger, spec.run, p, { lane: spec.lane, trial: spec.trialId }),
            runner,
            scratchDir: env.paths.scratchDir,
            port: 0,
            signal: undefined,
            model: undefined,
          },
          async (trial) =>
            runTrial(trial.spec as TrialSpec, {
              runner,
              laneTool,
              model,
              submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
              status: async (id) => env.service.attemptStatus(id),
              // As worker-main.ts wires them, so the worker has the tools it has on a rig.
              devRun: async () => ({}),
              idea: async () => ({ experiment: "x-000000000000" }),
              note: async () => ({ note: 1 }),
              research: async () => ({}),
            }),
        ),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    golden("planner.pi", sent.get("planner"), paths);
    golden("worker.pi", sent.get("worker"), paths);
    kept(env.service.ledger, "planner", sent.get("planner"));
    kept(env.service.ledger, "worker", sent.get("worker"));
  });

  test("a research run's planner and worker, in Pi", async () => {
    const r = await makeResearchRun("r-1", {
      contract: { notes: "Weigh the sources that measured more than one campaign." },
    });
    await r.env.service.applyCommand(
      r.env.sign("message_agent", {
        run: r.run,
        to: "all",
        text: "Cite page numbers.",
        keep: true,
      }),
    );
    // Every role answers in words only: the planner's plan is then the fallback, and the worker's
    // trial ends with nothing recorded. Only the first request of each is kept.
    const { sent, script } = recorder(() => ({ text: "done" }));
    const fake = await startFakeModel(script);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: r.env.service,
      runner: new LocalRunner(r.env.service.paths.scratchDir),
      model,
      owner: "prompts-test",
      research: r.research,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      // As worker-main.ts wires a research trial.
      runResearchTrial: (spec) =>
        runResearchTrial(spec, {
          model,
          call: async () => ({}),
          idea: async () => ({ experiment: "x-000000000000" }),
          note: async () => ({ note: 1 }),
        }),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, tmpdir()];
    golden("research-planner.pi", sent.get("research-planner"), paths);
    golden("research-worker.pi", sent.get("research-worker"), paths);
    kept(r.env.service.ledger, "research-planner", sent.get("research-planner"));
  });

  test("a hill-climb run's worker in OpenCode, Claude Code and Codex: what each program is given", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    await env.service.applyCommand(
      env.sign("message_agent", {
        run,
        to: "all",
        text: "Prefer a change a reader can follow.",
        keep: true,
      }),
    );
    // The trial the scheduler starts for the sample run, as every program gets it.
    let spec: TrialSpec | undefined;
    const { script } = recorder(() => PLAN);
    const fake = await startFakeModel(script);
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "prompts-test",
      runTrial: async (s) => {
        spec ??= s;
        return { stopped: "no_submission", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    assert.ok(spec);
    /** Every run the trial asks for, answered as a program that did nothing. */
    const recording = () => {
      const runs: RunRequest[] = [];
      const runner = {
        run: async (req: RunRequest) => {
          runs.push(req);
          return {
            exitCode: 0,
            signal: null,
            killedFor: null,
            stdout: "",
            stderr: "",
          } as RunOutcome;
        },
        killRole: async () => 0,
      } as unknown as Runner;
      return { runs, runner };
    };
    const common = {
      apiUrl: "http://127.0.0.1:8700",
      // Kept by the harness as the CLI trial loop renders it (goal 166).
      sent: (p: Prompt) =>
        keepPrompt(env.service.ledger, spec?.run ?? "", p, {
          lane: spec?.lane,
          trial: spec?.trialId,
        }),
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 5,
      afterSubmitMs: 5,
    };
    const programs = [
      [
        "worker.opencode",
        (runner: Runner, s: TrialSpec) =>
          runOpencodeTrial(s, {
            ...common,
            runner,
            model: {
              baseUrl: "http://127.0.0.1:9",
              model: "m",
              apiKey: "k",
              contextWindow: 32000,
              maxTokens: 2000,
            },
          }),
      ],
      [
        "worker.claude-code",
        (runner: Runner, s: TrialSpec) =>
          runClaudeTrial(s, {
            ...common,
            runner,
            model: {
              api: "claude" as const,
              harness: "claude-code" as const,
              baseUrl: "https://api.anthropic.com",
              model: "claude-test",
              apiKey: "token",
              contextWindow: 1_000_000,
              maxTokens: 0,
            },
          }),
      ],
      [
        "worker.codex",
        (runner: Runner, s: TrialSpec) =>
          runCodexTrial(s, {
            ...common,
            runner,
            model: {
              api: "chatgpt" as const,
              harness: "codex" as const,
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-test",
              apiKey: "access",
              contextWindow: 0,
              maxTokens: 0,
              reasoning: "off" as const,
            },
          }),
      ],
    ] as const;
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    for (const [name, start] of programs) {
      const { runs, runner } = recording();
      await start(runner, spec);
      // The program's own run: the one whose input is the brief.
      const given = runs.find((r) => String(r.stdin ?? "").includes("# Assignment"));
      assert.ok(given, `${name}: no run was given the brief`);
      // Where the program is installed differs from machine to machine.
      const command = given.argv
        .join(" ")
        .replace(/\S*\/(opencode|codex|claude)(?=\s|$)/g, "<bin>/$1");
      sections(name, paths, [
        ["command", command],
        ["standard input", String(given.stdin)],
      ]);
      keptInput(env.service.ledger, "worker", String(given.stdin));
    }
  });

  test("a hill-climb run's and a research run's planner, asked through a program", async () => {
    // The planner's model is OpenCode's own: the planner is asked through the program, with its
    // whole prompt on the program's standard input. The program gives no plan: the fallback.
    const asked = async (service: Parameters<typeof createHarnessApi>[0], research?: Research) => {
      let prompt: string | undefined;
      const scheduler = new Scheduler({
        service,
        runner: new LocalRunner(tmpdir()),
        model: {
          api: "opencode" as const,
          baseUrl: "https://opencode.ai/zen/v1",
          model: "m",
          apiKey: "",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        owner: "prompts-test",
        ...(research ? { research } : {}),
        ask: async (_via, _m, p) => {
          prompt ??= p;
          throw new Error("no answer");
        },
        runTrial: async () => ({
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
        }),
        runResearchTrial: async () => ({
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
        }),
      });
      await scheduler.tick();
      await scheduler.idle();
      await scheduler.shutdown("test over");
      assert.ok(prompt, "the planner was asked");
      return prompt;
    };
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    sections(
      "planner.program",
      [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()],
      [["standard input", await asked(env.service)]],
    );
    const r = await makeResearchRun("r-1", {
      contract: { notes: "Weigh the sources that measured more than one campaign." },
    });
    const { stateDir, scratchDir } = r.env.service.paths;
    sections(
      "research-planner.program",
      [scratchDir, stateDir, r.env.root, r.base, tmpdir()],
      [["standard input", await asked(r.env.service, r.research)]],
    );
    await r.close();
  });

  test("a research run's worker in OpenCode: what the program is given", async () => {
    const r = await makeResearchRun("r-1", {
      contract: { notes: "Weigh the sources that measured more than one campaign." },
    });
    // The trial the scheduler starts for the sample run.
    let spec: ResearchTrialSpec | undefined;
    const fake = await startFakeModel(() => ({ text: "done" }));
    const scheduler = new Scheduler({
      service: r.env.service,
      runner: new LocalRunner(r.env.service.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "prompts-test",
      research: r.research,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async (s) => {
        spec ??= s;
        return { stopped: "no_submission", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    assert.ok(spec);
    const runs: RunRequest[] = [];
    const runner = {
      run: async (req: RunRequest) => {
        runs.push(req);
        return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
      },
      killRole: async () => 0,
    } as unknown as Runner;
    const area = mkdtempSync(join(tmpdir(), "thermite-prompts-area-"));
    await runOpencodeResearchTrial(spec, {
      runner,
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 32000,
        maxTokens: 2000,
      },
      apiUrl: "http://127.0.0.1:8700",
      area,
      folder: await r.folder.prepareLane("r-1", spec.lane, spec.lane),
      live: () => undefined,
      progress: () => undefined,
      pollMs: 5,
    });
    await r.close();
    const given = runs.find((x) => String(x.stdin ?? "").includes("# Research assignment"));
    assert.ok(given, "no run was given the brief");
    const { stateDir, scratchDir } = r.env.service.paths;
    sections(
      "research-worker.opencode",
      [scratchDir, stateDir, r.env.root, r.base, area, tmpdir()],
      [
        ["command", given.argv.join(" ").replace(/\S*\/(opencode)(?=\s|$)/g, "<bin>/$1")],
        ["standard input", String(given.stdin)],
      ],
    );
  });
});

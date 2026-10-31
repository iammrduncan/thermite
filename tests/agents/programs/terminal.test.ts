import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelConfig } from "../../../src/agents/model/index.ts";
import {
  claudeArgs,
  claudeTerminalArgs,
  claudeTerminalLog,
  claudeTerminalSeeds,
  claudeTerminalSettings,
  claudeTrialSettings,
  codexConfig,
  codexTerminalArgs,
  codexTerminalConfig,
  codexTerminalLog,
  opencodeServerArgs,
  opencodeTerminalArgs,
  TERMINAL_KEYS,
  TERMINAL_PROFILES,
} from "../../../src/agents/programs/index.ts";

const model: ModelConfig = {
  api: "claude",
  harness: "claude-code",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-5-5",
  apiKey: "made-up",
  contextWindow: 1_000_000,
  maxTokens: 0,
};

describe("each program in its own terminal", () => {
  test("Claude Code starts a session by its id with the first message after --, and resumes it with none", () => {
    const args = claudeTerminalArgs(model, {
      session: "s-1",
      first: "--the brief",
      settings: "{}",
    });
    assert.deepEqual(args.slice(-4), ["--session-id", "s-1", "--", "--the brief"]);
    const deny = args.indexOf("--disallowedTools");
    assert.deepEqual(args.slice(deny, deny + 2), ["--disallowedTools", "AskUserQuestion"]);
    assert.ok(deny < args.indexOf("--"), "the message is not one of the tools denied");
    for (const headless of ["-p", "--output-format", "--verbose"])
      assert.ok(!args.includes(headless));
    assert.deepEqual(
      args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2),
      ["--setting-sources", ""],
    );
    const resumed = claudeTerminalArgs(model, {
      session: "s-1",
      resume: true,
      first: "ignored",
      settings: "{}",
    });
    assert.deepEqual(resumed.slice(-2), ["--resume", "s-1"]);
    assert.ok(!resumed.includes("--"));
    // The headless form keeps its flags.
    assert.deepEqual(claudeArgs(model, { session: "s-1" }).slice(0, 5), [
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-5-5",
    ]);
    assert.deepEqual(claudeArgs(model, { session: "s-1" }).slice(-2), ["--resume", "s-1"]);
  });

  test("Claude Code's settings and seed leave no screen to answer, and its transcript is found by its session", () => {
    const settings = JSON.parse(claudeTerminalSettings(claudeTrialSettings()));
    assert.ok(settings.hooks.Stop, "the trial's hooks stay");
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.autoContinueAtUsageLimit, true);
    const [seed] = claudeTerminalSeeds("/area/claude-home", "/area/repo", "2.1.308");
    assert.equal(seed?.path, "/area/claude-home/.claude.json");
    assert.equal(seed?.mode, 0o600);
    const state = JSON.parse(seed?.content ?? "{}");
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.lastOnboardingVersion, "2.1.308");
    assert.equal(state.projects["/area/repo"].hasTrustDialogAccepted, true);
    const log = claudeTerminalLog("/area/claude-home", "3b77.4632");
    assert.equal(log.dir, "/area/claude-home/.claude/projects");
    assert.ok(new RegExp(log.name).test("3b77.4632.jsonl"));
    assert.ok(!new RegExp(log.name).test("3b77x4632.jsonl"), "the session's dot is a dot");
  });

  test("Codex trusts its workspace, starts with the first message last, and resumes its thread", () => {
    const config = codexTerminalConfig(
      codexConfig(model, "http://127.0.0.1:8700/v1/proxy"),
      '/area/re"po',
    );
    assert.match(config, /^\[projects\."\/area\/re\\"po"\]\ntrust_level = "trusted"$/m);
    assert.match(config, /^\[tui\]\nanimations = false$/m);
    assert.match(config, /^hide_full_access_warning = true$/m);
    const args = codexTerminalArgs(model, { cwd: "/area/repo", first: "the brief" });
    assert.equal(args.at(-1), "the brief");
    assert.ok(args.includes("--dangerously-bypass-hook-trust"));
    assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", "/area/repo"]);
    const resumed = codexTerminalArgs(model, {
      cwd: "/area/repo",
      first: "x",
      resume: "019a-thread",
    });
    assert.equal(resumed[0], "resume");
    assert.equal(resumed.at(-1), "019a-thread");
    assert.ok(!resumed.includes("x"));
    const log = codexTerminalLog("/area/codex-home/.codex");
    assert.equal(log.dir, "/area/codex-home/.codex/sessions");
    assert.ok(new RegExp(log.name).test("rollout-2026-10-29T05-52-15-01a18637.jsonl"));
  });

  test("OpenCode's terminal attaches to its own server", () => {
    assert.deepEqual(opencodeServerArgs(4100), [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4100",
    ]);
    assert.deepEqual(opencodeTerminalArgs(4100, "/area/repo", "the brief"), [
      "--server",
      "http://127.0.0.1:4100",
      "--auto",
      "--prompt",
      "the brief",
      "/area/repo",
    ]);
    // After a crash: the session it had, and no message.
    assert.deepEqual(opencodeTerminalArgs(4100, "/area/repo", undefined, "ses_1"), [
      "--server",
      "http://127.0.0.1:4100",
      "--auto",
      "--session",
      "ses_1",
      "/area/repo",
    ]);
  });

  test("each program is interrupted and ended by named keys and text only, never Ctrl+C", () => {
    assert.ok(!(TERMINAL_KEYS as readonly string[]).includes("ctrl-c"));
    for (const [program, p] of Object.entries(TERMINAL_PROFILES)) {
      // The Pi view takes its interrupt over the trial's routes and ends by SIGTERM: no steps.
      if (program === "pi") {
        assert.deepEqual(p, { interrupt: [], end: [] });
        continue;
      }
      assert.ok(p.interrupt.length && p.end.length, program);
      for (const step of [...p.interrupt, ...p.end])
        if ("keys" in step)
          for (const k of step.keys) assert.ok(TERMINAL_KEYS.includes(k), `${program}: ${k}`);
    }
    assert.deepEqual(TERMINAL_PROFILES.codex.interrupt.at(-1), { text: "/stop" });
    assert.equal(TERMINAL_PROFILES.opencode.interrupt.filter((s) => "keys" in s).length, 2);
  });
});

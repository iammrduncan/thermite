import { join } from "node:path";
import {
  literally,
  type TerminalLog,
  type TerminalProfile,
  type TerminalSeed,
} from "../terminal.ts";

/**
 * Claude Code in its own terminal (goal 169), as the spike ran Claude Code 2.1.308: what the
 * terminal host sends it to interrupt and to end it, what its terminal adds to its environment and
 * its settings, and the file seeded in its home so that no screen waits for an answer. Its command
 * line is claudeTerminalArgs (args.ts).
 */

export const CLAUDE_TERMINAL: TerminalProfile = {
  // Esc stops the turn, and its running command, within a second.
  interrupt: [{ keys: ["esc"] }],
  // `/exit` ends it with its SessionEnd hook, and its totals written to the transcript.
  end: [{ text: "/exit" }],
};

/**
 * What its terminal adds to claudeEnv's environment: no update, feedback, cost or IDE screens,
 * none of which a headless run shows.
 */
export const CLAUDE_TERMINAL_ENV: Readonly<Record<string, string>> = {
  DISABLE_UPDATES: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DISABLE_COST_WARNINGS: "1",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
};

/**
 * Its settings in a terminal (`--settings`, which it reads whatever `--setting-sources` says): the
 * trial's (claudeTrialSettings: its hooks), with the warning about bypassed permissions taken as
 * read (it waits for a key, its default "No, exit"), no feedback survey, and a full usage window
 * waited out, the owner's choice (2026-10-27).
 */
export function claudeTerminalSettings(trial: string): string {
  return JSON.stringify({
    ...(JSON.parse(trial) as Record<string, unknown>),
    skipDangerousModePermissionPrompt: true,
    feedbackSurveyRate: 0,
    autoContinueAtUsageLimit: true,
  });
}

/**
 * The file seeded in its home before it starts, `.claude.json`, 0600 as Claude Code keeps it:
 * its onboarding done for `version` (without it, it shows its onboarding and checks its
 * connection), no IDE to connect to, and the workspace `cwd` trusted.
 */
export function claudeTerminalSeeds(home: string, cwd: string, version: string): TerminalSeed[] {
  const state = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: version,
    autoConnectIde: false,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  };
  return [{ path: join(home, ".claude.json"), content: JSON.stringify(state), mode: 0o600 }];
}

/**
 * Where Claude Code writes the transcript of session `session` in its home:
 * `.claude/projects/<the workspace's path, escaped>/<session>.jsonl`, readable by its own user
 * only, so the host mirrors it.
 */
export function claudeTerminalLog(home: string, session: string): TerminalLog {
  return {
    dir: join(home, ".claude", "projects"),
    depth: 1,
    name: `^${literally(session)}\\.jsonl$`,
  };
}

/**
 * The agent programs that run as command-line programs, as Thermite starts them for the harness's
 * agents and the supervisor's advisors: Claude Code (claude-code/), the Codex CLI (codex/) and
 * OpenCode v2 (opencode/), each with its binary, its configuration and environment, its command
 * line and how its output is read; the PATH their agent's shell gets (path.ts); the adapters
 * that read each one's own session log into one set of events (session-log.ts); and Thermite's
 * hook program for Claude Code and Codex, with the adapter of its signals (hooks/); and how each
 * runs in its own terminal (terminal.ts and each program's `terminal.ts`, goal 169), which
 * Thermite's terminal host (src/harness/terminal/) drives. The harness's trial loop for them is
 * src/harness/agents/cli/.
 */

import { CLAUDE_TERMINAL } from "./claude-code/index.ts";
import { CODEX_TERMINAL } from "./codex/index.ts";
import { OPENCODE_TERMINAL } from "./opencode/index.ts";
import { PI_VIEW_TERMINAL, type TerminalProfile, type TerminalProgram } from "./terminal.ts";

export {
  CLAUDE_BASE_ENV,
  CLAUDE_DROPS,
  CLAUDE_HOOK,
  CLAUDE_PROMPT,
  CLAUDE_TERMINAL_ENV,
  CLAUDE_TOKEN_FD,
  type ClaudeTally,
  claudeArgs,
  claudeBin,
  claudeCompactionEnv,
  claudeEnv,
  claudeExe,
  claudeExitWords,
  claudeHookSettings,
  claudeModelId,
  claudeResultUsage,
  claudeShell,
  claudeTerminalArgs,
  claudeTerminalLog,
  claudeTerminalSeeds,
  claudeTerminalSettings,
  claudeTranscript,
  claudeTrialSettings,
  closeClaudeRun,
  mergeUsage,
  NO_CLAUDE_CODE,
  newClaudeTally,
  type PlanWindows,
  PROMPT_VAR,
  readClaudeEvents,
  type TranscriptState,
  type UsageWindow,
} from "./claude-code/index.ts";
export {
  type CodexTally,
  codexArgs,
  codexBin,
  codexConfig,
  codexEnv,
  codexExe,
  codexExitWords,
  codexHooks,
  codexNotify,
  codexRollout,
  codexTerminalArgs,
  codexTerminalConfig,
  codexTerminalLog,
  NO_CODEX,
  newCodexTally,
  type RolloutState,
  readCodexEvents,
  tomlString,
} from "./codex/index.ts";
export { HOOK_PROGRAM, hookSignals, SIGNALS_VAR } from "./hooks/index.ts";
export {
  NO_OPENCODE,
  newTally,
  OPENCODE_BASE_ENV,
  OPENCODE_DROPS,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  type OpencodeLogState,
  type OpencodeTally,
  opencodeArgs,
  opencodeBin,
  opencodeConfig,
  opencodeExe,
  opencodeExitWords,
  opencodeFound,
  opencodeKeepEnv,
  opencodeModelId,
  opencodeServerArgs,
  opencodeServerUrl,
  opencodeSession,
  opencodeTerminalArgs,
  readNew,
  readOpencodeEvents,
  runEnv,
} from "./opencode/index.ts";
export { agentPath } from "./path.ts";
export {
  newSessionTally,
  type SessionEvent,
  type SessionLogAdapter,
  type SessionTally,
  type TallyCounts,
  type TurnEnd,
  tallyDifferences,
  tallyEvents,
  tallyLog,
  type UserOrigin,
} from "./session-log.ts";
export {
  literally,
  PI_VIEW_TERMINAL,
  TERMINAL_KEYS,
  TERMINAL_PROGRAMS,
  type TerminalKey,
  type TerminalLog,
  type TerminalProfile,
  type TerminalProgram,
  type TerminalSeed,
  type TerminalStep,
} from "./terminal.ts";

/** How the terminal host interrupts and ends each program (goal 169), by its id. */
export const TERMINAL_PROFILES: Readonly<Record<TerminalProgram, TerminalProfile>> = {
  "claude-code": CLAUDE_TERMINAL,
  codex: CODEX_TERMINAL,
  opencode: OPENCODE_TERMINAL,
  pi: PI_VIEW_TERMINAL,
};

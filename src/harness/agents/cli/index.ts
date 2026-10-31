/**
 * The agent programs that run as command-line programs (OpenCode, Claude Code, Codex): each
 * program's entry (program.ts and one file for each), their trial loop (loop.ts, common.ts), their
 * one-prompt call (once.ts), and the one path for any role in its program's own terminal
 * (terminal.ts, with the owner's console.ts): a trial's, or a call's outside a trial (call.ts).
 */

export type { CallTurn, TerminalCallLink } from "./call.ts";
export { claudeProgram } from "./claude-code.ts";
export { codexProgram } from "./codex.ts";
export {
  type ConsoleLater,
  type ConsoleNow,
  type ConsoleTerminal,
  TrialConsole,
} from "./console.ts";
export { runCliTrial } from "./loop.ts";
export { type CliAskOptions, type CliOnceDeps, cliAsk, cliModelCheck } from "./once.ts";
export { opencodeProgram } from "./opencode.ts";
export type { CliHarness, CliProgram, CliTally, CliTrialDeps } from "./program.ts";

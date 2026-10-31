/**
 * The agent programs that run as command-line programs (OpenCode, Claude Code, Codex), as every
 * role's runtime sees them: each program's entry (program.ts and one file for each), and the one
 * path for any role in its program's own terminal (goal 169; terminal.ts), with the owner's
 * console (console.ts), the owner's messages inside a turn (in-turn.ts), a full usage window
 * waited out (usage-window.ts) and a call outside a trial (call.ts). The harness's trial loop and
 * one-prompt call for them are src/harness/agents/cli/.
 */

export {
  type CallDeps,
  type CallLink,
  type CallTurn,
  callFolder,
  type TerminalCallOptions,
  terminalCall,
} from "./call.ts";
export { CLAUDE_CODE_MEMORY, claudeProgram } from "./claude-code.ts";
export { CODEX_MEMORY, codexProgram } from "./codex.ts";
export {
  type ConsoleLater,
  type ConsoleLimit,
  type ConsoleNow,
  type ConsoleTerminal,
  screenFrame,
  TrialConsole,
} from "./console.ts";
export {
  type MessageInbox,
  OFFER_MS,
  TrialSignals,
  type TurnDelivery,
  TurnMessages,
  type TurnMessagesDeps,
} from "./in-turn.ts";
export { OPENCODE_MEMORY, opencodeProgram } from "./opencode.ts";
export type {
  CliCall,
  CliCallEntry,
  CliHarness,
  CliProgram,
  CliRun,
  CliSetup,
  CliTally,
  CliTerminal,
  OwnStop,
  TerminalAt,
  TerminalPlan,
} from "./program.ts";
export { setUp, takeUsage } from "./shared.ts";
export { RoleTerminal, type RoleTerminalDeps, type RunEnd } from "./terminal.ts";
export {
  GO_ON_GRACE_MS,
  TERMINAL_WAIT_MAX_MS,
  type WindowDeps,
  type WindowLink,
  type WindowRun,
  type WindowStep,
  type WindowTerminal,
  waitOutWindow,
} from "./usage-window.ts";

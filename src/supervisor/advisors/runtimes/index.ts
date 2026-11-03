/**
 * The programs an advisor runs in: Claude Code (claude-code.ts), OpenCode and the Codex CLI
 * (opencode-codex.ts), and what the command-line programs share (cli.ts). Pi is ../pi/.
 */

export { runClaudeCode } from "./claude-code.ts";
export { callId, lastJsonObject, parseAnswer, runCli } from "./cli.ts";
export { cliHarnessModel, runCliHarness } from "./opencode-codex.ts";

/**
 * The programs an advisor runs in: Pi (pi.ts), Claude Code (claude-code.ts), OpenCode and the
 * Codex CLI (opencode-codex.ts), and what the command-line programs share (cli.ts).
 */

export { runClaudeCode } from "./claude-code.ts";
export { lastJsonObject, runCli } from "./cli.ts";
export { runCliHarness } from "./opencode-codex.ts";
export { runPi } from "./pi.ts";

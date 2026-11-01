/**
 * The harness's side of the agent programs that run as command-line programs (OpenCode, Claude
 * Code, Codex): their trial loop (loop.ts, common.ts), their one-prompt call and model check
 * (once.ts), and what the loop and a planner's call in its terminal take from the harness
 * (program.ts). Each takes the program's entry from src/agents/cli/, which also holds the one path
 * for any role in its program's own terminal.
 */

export { PLANNER_ROLE } from "./common.ts";
export { runCliTrial } from "./loop.ts";
export {
  type CliAskOptions,
  type CliOnceDeps,
  cliAsk,
  cliModelCheck,
  planJson,
} from "./once.ts";
export type { CliTrialDeps, TerminalCallLink } from "./program.ts";

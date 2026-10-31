/**
 * The harness's side of the agent programs that run as command-line programs (OpenCode, Claude
 * Code, Codex): their trial loop (loop.ts, common.ts), their one-prompt call (once.ts), a trial,
 * a call and the model check in each (one file for each), and what the loop and a planner's call
 * in its terminal take from the harness (program.ts). Each program's entry and the one path for
 * any role in its program's own terminal are src/agents/cli/.
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

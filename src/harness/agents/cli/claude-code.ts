import { claudeProgram } from "../../../agents/cli/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { ClaudeTally } from "../../../agents/programs/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliTrialDeps } from "./program.ts";

/**
 * A worker trial, a one-prompt call and the model check in Claude Code, through the harness's
 * trial loop (loop.ts) and one-prompt call (once.ts), with Claude Code's entry
 * (src/agents/cli/claude-code.ts).
 */

/**
 * One worker trial in Claude Code: the CLI trial loop (cli/loop.ts) with Claude Code's entry.
 * Headless, a full usage window ends the trial with the time it resets; in its terminal, the
 * trial waits it out.
 */
export function runClaudeTrial(spec: TrialSpec, deps: CliTrialDeps): Promise<TrialResult> {
  return runCliTrial(claudeProgram, { mode: "code", spec }, deps);
}

/**
 * One prompt through Claude Code outside a trial (a model check, a planner call), as `role` (the
 * planner's or the model check's own user) in a fresh directory, removed afterwards. `tools` ""
 * gives it none.
 */
export function claudeOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: CliOnceOptions & { tools: string },
): Promise<ClaudeTally> {
  return cliOnce(claudeProgram, model, prompt, deps, o);
}

/** The model check in Claude Code: the model must run one shell command through its Bash tool. */
export function claudeModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(claudeProgram, model, deps, timeoutMs);
}

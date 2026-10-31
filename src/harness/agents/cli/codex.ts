import { codexProgram } from "../../../agents/cli/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { CodexTally } from "../../../agents/programs/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliTrialDeps } from "./program.ts";

/**
 * A worker trial, a one-prompt call and the model check in the Codex CLI, through the harness's
 * trial loop (loop.ts) and one-prompt call (once.ts), with Codex's entry
 * (src/agents/cli/codex.ts).
 */

/** One worker trial in the Codex CLI: the CLI trial loop (cli/loop.ts) with Codex's entry. */
export function runCodexTrial(spec: TrialSpec, deps: CliTrialDeps): Promise<TrialResult> {
  return runCliTrial(codexProgram, { mode: "code", spec }, deps);
}

/**
 * One prompt through the Codex CLI outside a trial (a model check, a planner call), as `role`
 * (the planner's or the model check's own user) in a fresh directory, removed afterwards. It
 * reaches the model through the proxy with a credential minted for this call.
 */
export function codexOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: Omit<CliOnceOptions, "tools">,
): Promise<CodexTally> {
  return cliOnce(codexProgram, model, prompt, deps, o);
}

/** The model check in the Codex CLI (cli/once.ts). */
export function codexModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(codexProgram, model, deps, timeoutMs);
}

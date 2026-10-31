import { opencodeProgram } from "../../../agents/cli/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { OpencodeTally } from "../../../agents/programs/index.ts";
import type { ResearchFolderPaths } from "../../../agents/tools/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { ResearchTrialSpec } from "../research/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliTrialDeps } from "./program.ts";

/**
 * Worker and research trials, a one-prompt call and the model check in OpenCode, through the
 * harness's trial loop (loop.ts) and one-prompt call (once.ts), with OpenCode's entry
 * (src/agents/cli/opencode.ts).
 */

export type OpencodeTrialDeps = CliTrialDeps;

/** One worker trial in OpenCode: the CLI trial loop (cli/loop.ts) with OpenCode's entry. */
export function runOpencodeTrial(spec: TrialSpec, deps: OpencodeTrialDeps): Promise<TrialResult> {
  return runCliTrial(opencodeProgram, { mode: "code", spec }, deps);
}

export interface OpencodeResearchDeps extends Omit<OpencodeTrialDeps, "submitted"> {
  /** The trial's own area in the lane (owned by its user): OpenCode's home, temporary files, events. */
  area: string;
  /** The run's research folder; the agent works in its lane's working area there. */
  folder: ResearchFolderPaths;
}

/**
 * One research trial in OpenCode: the CLI trial loop's research mode. The same tools as a
 * hill-climb trial (its shell, files and web search) plus the research tools as `thermite-trial
 * research` commands, which reach the harness's research service with the trial's token. As in
 * Pi, the trial ends when the agent stops, its time or turns run out, or it is stopped.
 */
export function runOpencodeResearchTrial(
  spec: ResearchTrialSpec,
  deps: OpencodeResearchDeps,
): Promise<TrialResult> {
  return runCliTrial(
    opencodeProgram,
    { mode: "research", spec, area: deps.area, folder: deps.folder },
    deps,
  );
}

/** One prompt through OpenCode as `role`, in a fresh directory of its own, removed afterwards. */
export function opencodeOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: Omit<CliOnceOptions, "tools">,
): Promise<OpencodeTally> {
  return cliOnce(opencodeProgram, model, prompt, deps, o);
}

/** The model check in OpenCode (cli/once.ts). */
export function opencodeModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(opencodeProgram, model, deps, timeoutMs);
}

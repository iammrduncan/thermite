import type { CliProgram, CliTally } from "../../src/agents/cli/index.ts";
import type { ResearchFolderPaths } from "../../src/agents/tools/index.ts";
import { type CliTrialDeps, runCliTrial } from "../../src/harness/agents/cli/index.ts";
import type { ResearchTrialSpec } from "../../src/harness/agents/research/index.ts";
import type { TrialSpec } from "../../src/harness/agents/worker/index.ts";

/**
 * Trials in one agent program through the CLI trial loop, as the harness starts them: a worker's
 * (code mode), and a research trial in the area and folder its deps name (research mode).
 */
export function trialsIn<T extends CliTally>(p: CliProgram<T>) {
  return {
    code: (spec: TrialSpec, deps: CliTrialDeps) => runCliTrial(p, { mode: "code", spec }, deps),
    research: (
      spec: ResearchTrialSpec,
      deps: CliTrialDeps & { area: string; folder: ResearchFolderPaths },
    ) => runCliTrial(p, { mode: "research", spec, area: deps.area, folder: deps.folder }, deps),
  };
}

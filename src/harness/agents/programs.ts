import {
  type CliHarness,
  type CliProgram,
  type CliTally,
  claudeProgram,
  codexProgram,
  opencodeProgram,
  TrialConsole,
} from "../../agents/cli/index.ts";
import type { CliCompacted } from "../../agents/compaction/index.ts";
import type { ModelConfig } from "../../agents/model/index.ts";
import { type TrialProgram, windowFit } from "../../agents/roles/index.ts";
import type { ResearchFolderPaths } from "../../agents/tools/index.ts";
import {
  type Harness,
  type ProviderType,
  programForApi,
  reaches,
  throughProxy,
} from "../../core/agents.ts";
import type { Role } from "../broker/index.ts";
import {
  type CliAskOptions,
  type CliOnceDeps,
  type CliTrialDeps,
  cliAsk,
  cliModelCheck,
  runCliTrial,
} from "./cli/index.ts";
import { checkModel, type RigCheckReport } from "./model/index.ts";
import { PiConsole } from "./pi-view/index.ts";
import { piResearchPrompt, type ResearchTrialSpec } from "./research/index.ts";
import { spawnTrial } from "./spawn.ts";
import { PI_TRIAL, piTrialPrompt, type TrialResult, type TrialSpec } from "./worker/index.ts";
import { prepareResearchArea } from "./workspace.ts";

/**
 * The agent programs (goal 125, T7): one entry for each program a rig's agents may run in, which
 * the harness consults wherever it picks one. Pi runs in the harness itself: a worker process for
 * each trial, the planner in the controller. OpenCode, Claude Code and Codex run as command-line
 * programs, each through its entry in the CLI trial loop (cli/loop.ts) and the one-prompt call
 * (cli/once.ts).
 */

/** A trial as a program runs it: a code trial, or a research trial in the run's research folder. */
export type AgentTrial =
  | { mode: "code"; spec: TrialSpec }
  | { mode: "research"; spec: ResearchTrialSpec; folder: ResearchFolderPaths };

/** What a trial takes from the harness, whichever program runs it. */
export interface TrialLink extends Omit<CliTrialDeps, "model" | "compacted"> {
  /** The route; none: Pi's worker takes the harness's own model settings. */
  model: ModelConfig | undefined;
  /** Records a compaction that `harness` itself made and reported (goal 070). */
  compacted?: ((harness: CliHarness, c: CliCompacted) => void) | undefined;
  /** The controller's scratch area, and the harness API's port (Pi's worker reaches it there). */
  scratchDir: string;
  port: number;
  /**
   * Opens what its program's own code hands over with the trial's token (Pi's worker): its model
   * usage (goal 075), for its route as `harness` runs it, and its session's counters and waits for
   * the provider. The function it returns closes it.
   */
  handOver(harness: Harness): () => void;
  /**
   * Told when the trial's program reaches its provider through the harness's model proxy: from
   * then on, the run's budget counts the tokens the proxy sees in the provider's answers to the
   * trial's calls, not those the program reports.
   */
  throughProxy?: (() => void) | undefined;
}

export interface AgentProgram {
  id: Harness;
  /** Its name in what people read. */
  name: string;
  /** What a trial's prompt says of it (goal 166): its name, its turns and its own memory. */
  trial: TrialProgram;
  /** Whether it reaches a provider of this kind (core/agents.ts). */
  reaches(api: ProviderType | undefined): boolean;
  /** Whether it runs research trials (Pi and OpenCode do). */
  research: boolean;
  /**
   * Whether a planner without a model of its own follows the workers into it (Codex does; the
   * planner of OpenCode's workers on a provider's key plans in Pi).
   */
  plannerFollows: boolean;
  /** The user its trial in `lane` runs as: the lane's own, or Pi's worker's. */
  runsAs(lane: string): Role;
  runTrial(t: AgentTrial, link: TrialLink): Promise<TrialResult>;
  /** A planner call through it: its answer. None for Pi, whose planner runs in the controller. */
  ask?(m: ModelConfig, prompt: string, deps: CliOnceDeps, o: CliAskOptions): Promise<string>;
  /** The model check in it: one correct tool call. */
  modelCheck(m: ModelConfig, deps: CliOnceDeps): Promise<RigCheckReport>;
}

/**
 * A trial in Pi: its prompt, from its role's definition, rendered and kept here in the harness
 * (goal 166), then the worker process, which sends it as it is. On a rig whose agents run in
 * their own terminal, the worker draws its Pi view there (goal 169), and the trial's console is
 * its PiConsole; headless, it has none. `spawn`: the worker process (spawn.ts); tests run the
 * worker in their own.
 */
export async function runPiTrial(
  t: AgentTrial,
  link: Pick<
    TrialLink,
    | "handOver"
    | "sent"
    | "runner"
    | "scratchDir"
    | "port"
    | "signal"
    | "model"
    | "terminal"
    | "console"
  >,
  spawn: typeof spawnTrial = spawnTrial,
): Promise<TrialResult> {
  // Its worker hands its model usage, counters and waits over with the trial's token while the
  // trial runs.
  const close = link.handOver("pi");
  try {
    const mcpServers = t.spec.mcpServers ?? [];
    // Cut to the model's window, when the route says it (decision 8).
    const fit = windowFit(link.model?.contextWindow, link.model?.compactAt);
    const sent =
      t.mode === "code"
        ? piTrialPrompt(t.spec, mcpServers, Date.now(), fit)
        : piResearchPrompt(
            { ...t.spec, folder: t.folder },
            { mcpServers, kbWrites: t.spec.kbWrites, idea: true, note: true, fit },
          );
    link.sent?.(sent);
    const view = link.terminal ? new PiConsole() : undefined;
    link.console?.(view ? new TrialConsole(view) : "headless", view);
    return await spawn(
      t.mode === "code"
        ? { kind: "code", spec: { ...t.spec, sent } }
        : { kind: "research", spec: { ...t.spec, folder: t.folder, sent } },
      link.runner,
      link.scratchDir,
      link.port,
      link.signal,
      link.model,
      view,
    );
  } finally {
    close();
  }
}

/** Pi: each trial in a worker process of its own, as the lane's agent user (spawn.ts). */
const pi: AgentProgram = {
  id: "pi",
  name: "Pi",
  trial: PI_TRIAL,
  reaches: (api) => reaches("pi", api),
  research: true,
  plannerFollows: true,
  runsAs: (lane) => lane.replace(/^lane-/, "agent-") as Role,
  runTrial: (t, link) => runPiTrial(t, link),
  modelCheck: (m) => checkModel(m),
};

/** A program that runs as a command-line program: it takes planner calls of its own. */
type CliAgentProgram = AgentProgram & Required<Pick<AgentProgram, "ask">>;

/** A program that runs as a command-line program, through its entry (cli/program.ts). */
function cli<T extends CliTally>(p: CliProgram<T>, plannerFollows: boolean): CliAgentProgram {
  return {
    id: p.id,
    name: p.name,
    trial: { id: p.id, name: p.name, turnWords: p.turnWords, memory: p.memory },
    reaches: (api) => reaches(p.id, api),
    research: p.research === true,
    plannerFollows,
    runsAs: (lane) => lane as Role,
    runTrial: (t, link) => cliTrial(p, t, link),
    ask: (m, prompt, deps, o) => cliAsk(p, m, prompt, deps, o),
    modelCheck: (m, deps) => cliModelCheck(p, m, deps),
  };
}

/**
 * A trial in a command-line program. A research trial gets an area of its own in the lane for the
 * program's home and files, removed when it ends with what the agent started from its shell.
 */
async function cliTrial<T extends CliTally>(
  p: CliProgram<T>,
  t: AgentTrial,
  link: TrialLink,
): Promise<TrialResult> {
  const model = link.model;
  // Without a route the agents run in Pi (programOf): this is a programmer's error.
  if (!model) throw new Error(`${p.name} runs only on a model route`);
  if (throughProxy(model.api)) link.throughProxy?.();
  const compacted = link.compacted;
  const deps: CliTrialDeps = {
    ...link,
    model,
    compacted: compacted ? (c) => compacted(p.id, c) : undefined,
  };
  if (t.mode === "code") return runCliTrial(p, t, deps);
  const lane = t.spec.lane as Role;
  const area = await prepareResearchArea({
    runner: link.runner,
    scratchDir: link.scratchDir,
    lane,
  });
  try {
    return await runCliTrial(p, { ...t, area: area.dir }, deps);
  } finally {
    await link.runner.killRole(lane).catch(() => 0);
    await link.runner.remove(area.dir).catch(() => undefined);
  }
}

export const CLI_PROGRAMS: Record<CliHarness, CliAgentProgram> = {
  opencode: cli(opencodeProgram, false),
  "claude-code": cli(claudeProgram, true),
  codex: cli(codexProgram, true),
};

export const AGENT_PROGRAMS: Record<Harness, AgentProgram> = { pi, ...CLI_PROGRAMS };

/** Whether a program runs as a command-line program: a planner call goes through it, not Pi. */
export const isCliProgram = (h: Harness): h is CliHarness => h in CLI_PROGRAMS;

/** The program a route's agents run in: the one it names, else Pi (also without a route). */
export const programOf = (m: ModelConfig | undefined): AgentProgram =>
  AGENT_PROGRAMS[m?.harness ?? "pi"];

/**
 * The program a route's research trials run in: its own when that runs research, else Pi, which
 * reaches the same provider (a route whose code trials run in Codex).
 */
export function researchProgramOf(m: ModelConfig | undefined): AgentProgram {
  const p = programOf(m);
  return p.research ? p : AGENT_PROGRAMS.pi;
}

/**
 * Why a rig's model cannot serve its research trials, in words; undefined when it can. They run
 * in Pi or OpenCode (researchProgramOf), and neither reaches a Claude subscription, which runs
 * only in Claude Code; Pi does not reach OpenCode's own (free) models, which run only in OpenCode.
 */
export function researchRefusal(m: ModelConfig | undefined): string | undefined {
  if (!m) return "this rig has no model for its agents: give it one on its Edit rig page";
  if (researchProgramOf(m).reaches(m.api)) return undefined;
  return programForApi(m.api) === "claude-code"
    ? "research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research"
    : `${m.model} is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page`;
}

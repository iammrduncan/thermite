import { join } from "node:path";
import {
  type ModelConfig,
  modelConfigFromEnv,
  withAgentsContext,
} from "../../agents/model/index.ts";
import { mergeUsage, type PlanWindows } from "../../agents/programs/index.ts";
import { log } from "../../common/log.ts";
import {
  CLI_PROGRAMS,
  type CliOnceDeps,
  DevRuns,
  laneCacheEnv,
  ModelSource,
  programOf,
  researchProgramOf,
  researchRefusal,
  Scheduler,
  type TrialLink,
} from "../agents/index.ts";
import { effectiveGpuLists } from "../broker/index.ts";
import { Compactions, compactionOf } from "../compactions.ts";
import type { Ledger } from "../ledger/index.ts";
import { keepPrompt } from "../prompts.ts";
import { Research, ResearchFolder, SAVED_LANES_DIR } from "../research/index.ts";
import type { RigSettingsStore } from "../rig-settings.ts";
import type { HarnessService } from "../service/index.ts";
import { routeOf } from "../usage.ts";
import type { ControllerContext } from "./context.ts";
import type { Targets } from "./targets.ts";

/**
 * The agents' shared parts: the dev runs, each run's research folder and the research record,
 * the compactions, the model route, and what each trial and each one-prompt call takes from the
 * harness; then the scheduler, which runs the trials and the planner with them, and follows the
 * rig's settings.
 */

/** Minutes as milliseconds; none stays none. */
const minutesMs = (m: number | null) => (m === null ? undefined : m * 60_000);

/** What the API, the judge and the scheduler share of the agents' work. */
export interface AgentParts {
  devRuns: DevRuns;
  researchFolder: ResearchFolder;
  research: Research;
}

/**
 * The dev runs, each run's research folder with the research record, and the compactions, with
 * the service's hooks into them.
 */
export function agentParts(
  ctx: ControllerContext,
  ledger: Ledger,
  service: HarnessService,
  targets: Targets,
): AgentParts {
  const { numbers, paths, runner } = ctx;
  const { devCard, devCards, driver } = targets;
  const devRuns = new DevRuns({
    runner,
    ledger,
    scratchDir: paths.scratchDir,
    gpu: driver.type === "cuda-gpu",
    dedicated: devCard?.layout !== undefined,
    cards: devCards.length || undefined,
    unavailable: devCard?.error,
  });

  // Each run's research folder: what it has learned, as files its workers search (and, in a
  // research run, add to), with past research under knowledge/ (the same folders the service's
  // knowledge store writes).
  const researchFolder = new ResearchFolder({
    ledger,
    scratchRoot: join(paths.scratchDir, "research"),
    stateRoot: join(paths.stateDir, SAVED_LANES_DIR),
    runner,
    knowledge: service.knowledge,
  });
  const research = new Research(ledger, paths.stateDir, {
    maxCorpusBytes: numbers.researchMaxBytes,
    onChange: (run) => void researchFolder.sync(run),
  });
  service.researchFolder = (run) => researchFolder.exportFiles(run);
  // A research run's paper, once accepted, is its folder's paper.md at once (goal 112).
  service.researchChanged = (run) => void researchFolder.sync(run);
  // Each compaction's conversation, kept in the run's research folder, and its record (goal 070).
  service.compactions = new Compactions({
    ledger,
    live: service.live,
    folder: researchFolder,
    // A compaction ends what counts as a repeat: the agent may ask again for what it lost.
    recorded: (of) => {
      if (of.trial) service.watch.compacted(of.trial);
    },
  });
  return { devRuns, researchFolder, research };
}

/** The model route, and what a trial or a one-prompt call takes from the harness. */
export interface AgentLinks {
  models: ModelSource;
  /** The workers' route now. */
  model: () => ModelConfig | undefined;
  /** A run's workers' route, with its campaign's context settings. */
  modelFor: (run: string) => ModelConfig | undefined;
  /** What a one-prompt call (a planner call, a model check) takes from the harness. */
  once: CliOnceDeps;
  /** Takes the subscription's windows into the rig's report. */
  windows: (u: PlanWindows) => void;
  /** What a trial takes from the harness. */
  link: (
    spec: { trialId: string; run: string; lane: string },
    m: ModelConfig | undefined,
    signal: AbortSignal,
  ) => TrialLink;
}

/** The agents' links, with the API's port; the model source becomes the service's. */
export function agentLinks(
  ctx: ControllerContext,
  service: HarnessService,
  port: number,
): AgentLinks {
  const { env, paths, runner, routeFile } = ctx;
  // Agents run only with a model route (THERMITE_MODEL_* from the rig's configuration; the key from the
  // broker). Each trial is its own worker process.
  // The route control sets (kept in the state directory, root only) comes before the rig's own
  // settings; every plan and trial takes the route current when it starts.
  const models = new ModelSource(routeFile, modelConfigFromEnv(env));
  service.models = models;
  const model = () => models.current();
  // A run's workers: the route, with the campaign's own context settings when its contract has
  // them (goal 070): the lower window, and the campaign's compaction point.
  const modelFor = (run: string) =>
    withAgentsContext(model(), service.contractFor(run).agents_context);
  // Rig checks control can ask for: the model route, and the isolation selftest under the broker.
  // OpenCode and Codex (worker harnesses a rig may choose) reach the harness API on loopback.
  const apiUrl = `http://127.0.0.1:${port}`;
  const once = {
    runner,
    apiUrl,
    scratchDir: paths.scratchDir,
    mintProxyToken: (m?: ModelConfig) => service.mintProxyToken(m),
  };
  // The subscription's windows, as Claude Code reports them: in the rig's report.
  const windows = (u: PlanWindows) => {
    service.subscriptionUsage = mergeUsage(service.subscriptionUsage, u);
  };
  // What a trial takes from the harness, whichever program runs it (programs.ts).
  const link = (
    spec: { trialId: string; run: string; lane: string },
    m: ModelConfig | undefined,
    signal: AbortSignal,
  ): TrialLink => {
    const trial = { id: spec.trialId, run: spec.run, lane: spec.lane };
    return {
      runner,
      model: m,
      apiUrl,
      scratchDir: paths.scratchDir,
      port,
      live: (entries) => service.trialReport(trial, { entries }),
      progress: (progress) => service.trialReport(trial, { progress }),
      submitted: () => service.trialSubmission(spec.trialId),
      messages: service.trialInbox(trial),
      // Its hooks or plugin take the owner's messages inside the agent's turn, through the
      // trial's routes (goal 169).
      inTurn: (d) => service.inTurn(spec.trialId, d),
      usage: windows,
      // A compaction the program reported (goal 070): kept and recorded as a Pi worker's are,
      // with the program's own conversation where Thermite could read it.
      compacted: (harness, c) => service.compactions?.fromHarness(compactionOf(trial), harness, c),
      // Where its conversation is kept before each compaction, for the program's own summary to
      // name it: the run's research folder, which the worker may read (goal 070).
      keptAt: service.compactions?.keptAt(compactionOf(trial), true),
      // Each model call's usage (goal 075): the harness records what OpenCode, Codex and Claude
      // Code report of a trial's calls; a Pi worker's own code hands its records over, with the
      // trial's token, while the trial runs.
      modelUsage: m
        ? service.usage.recorder(spec.run, { trial: spec.trialId, agent: "workers" }, routeOf(m))
        : undefined,
      // A Pi worker's own code also reports its session's counters and its waits for the
      // provider; a command-line program's trial loop reports them here, in the harness.
      handOver: (harness) => {
        if (m) service.usage.open(trial, routeOf(m, harness));
        const own = service.reportsOwnSession(spec.trialId);
        return () => {
          own();
          service.usage.close(spec.trialId);
        };
      },
      // The provider's error answers the model proxy saw, and each wait for it (goal 079).
      providerAnswer: (since) => service.providerAnswerSince(spec.trialId, since),
      waiting: (w) => service.trialWait(trial, w),
      env: laneCacheEnv(paths.scratchDir, spec.lane),
      // Claude Code, Codex or OpenCode in its own terminal, or headless: the rig's setting when
      // the trial starts (goal 169). Pi has no terminal.
      terminal: service.settings.get().program_mode === "terminal",
      // The prompt that starts the trial, kept whole in the ledger (goal 166).
      sent: (p) =>
        keepPrompt(service.ledger, spec.run, p, { lane: spec.lane, trial: spec.trialId }),
      signal,
    };
  };
  return { models, model, modelFor, once, windows, link };
}

/**
 * The agents' scheduler, which follows the rig's settings from now on (loops.ts runs it), and a
 * line that says whether the agents wait for a model route.
 */
export function createScheduler(
  ctx: ControllerContext,
  {
    service,
    settings,
    links,
    parts,
    split,
  }: {
    service: HarnessService;
    settings: RigSettingsStore;
    links: AgentLinks;
    parts: AgentParts;
    split: { gpuSet: number; judgeNow: number };
  },
): Scheduler {
  const { env, numbers, runner } = ctx;
  const { models, model, modelFor, once, windows, link } = links;
  const { devRuns, researchFolder, research } = parts;
  const { gpuSet, judgeNow } = split;
  // Agents wait while no route is set; one set later starts them without a restart.
  const scheduler = new Scheduler({
    service,
    runner,
    model,
    owner: "scheduler",
    maxConcurrent: settings.get().lanes,
    trialWallMs: minutesMs(settings.get().trial_minutes),
    // No cap on a trial's turns unless one is configured.
    maxTurns: settings.get().max_turns ?? undefined,
    workersOn: () => settings.get().workers,
    plannerOn: () => settings.get().planner,
    // A draining rig, or one at its disk floor, starts no trial or plan (goals 079, 173).
    draining: () => service.draining !== undefined || service.disk?.held !== undefined,
    // Each trial runs in the harness the rig's route names: Pi (a worker process), OpenCode,
    // Claude Code or Codex.
    runTrial: (spec, signal) => {
      const m = modelFor(spec.run);
      return programOf(m).runTrial({ mode: "code", spec }, link(spec, m, signal));
    },
    // The planner through OpenCode, Claude Code or Codex, as the planner's own user (cli/once.ts).
    ask: (via, m, prompt, signal, o) =>
      CLI_PROGRAMS[via].ask(m, prompt, once, { ...o, signal, windows }),
    // The planner's own model, when control gave it one.
    plannerModel: () => models.planner(),
    research,
    // Research workers run in Pi (a worker process with the research tools only) or OpenCode (its
    // own tools plus `thermite-trial research`); a route whose code trials run in another program
    // runs its research workers in Pi, which reaches the same provider. A model that neither can
    // serve says so, in words.
    runResearchTrial: async (spec, signal) => {
      const m = modelFor(spec.run);
      const cannot = researchRefusal(m);
      if (cannot)
        return {
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          error: cannot,
        };
      // The run's research folder, with the lane's working area given to the user the trial
      // runs as: the worker's (Pi) or the lane's (OpenCode). Its files are saved when it ends.
      const program = researchProgramOf(m);
      const folder = await researchFolder.prepareLane(
        spec.run,
        spec.lane,
        program.runsAs(spec.lane),
      );
      try {
        return await program.runTrial({ mode: "research", spec, folder }, link(spec, m, signal));
      } finally {
        await researchFolder.captureLane(spec.run, spec.lane, spec.trialId).catch((err) => {
          log("harness", "research files not saved", { lane: spec.lane, error: String(err) });
        });
      }
    },
    devRuns,
    usdPerMTokIn: numbers.usdPerMTokIn,
    usdPerMTokOut: numbers.usdPerMTokOut,
  });
  settings.onChange((s) => {
    scheduler.configure({
      maxConcurrent: s.lanes,
      trialWallMs: minutesMs(s.trial_minutes),
      maxTurns: s.max_turns ?? undefined,
    });
    log("harness", "settings changed", { ...s });
    // A new GPU split is applied by the broker when the harness starts: exit, and it restarts.
    if (gpuSet >= 2) {
      const next = effectiveGpuLists(env, s.judge_gpus).judge.split(",").length;
      if (next !== judgeNow) {
        log("harness", "the GPU split changed: restarting to regroup the cards", {
          judge: next,
          agents: gpuSet - next,
        });
        setTimeout(() => process.exit(0), 1500).unref();
      }
    }
  });
  const info = models.info();
  log("harness", info.source === "none" ? "agents wait for a model route" : "agents ready", {
    route: info.source,
    model: info.model ?? null,
  });
  // The rig's API previews a role's next prompt with it (goal 166).
  service.promptPreview = (run, ask) => scheduler.preview(run, ask);
  return scheduler;
}

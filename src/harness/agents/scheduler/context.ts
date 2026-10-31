import type { CliHarness } from "../../../agents/cli/index.ts";
import type { OnceKeeping } from "../../../agents/compaction/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import type { Contract } from "../../../core/contract.ts";
import type { StoredRule } from "../../../core/directives.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Runner } from "../../broker/index.ts";
import type { Ledger } from "../../ledger/index.ts";
import type { Research } from "../../research/index.ts";
import type { HarnessService } from "../../service/index.ts";
import { Coordinator, lanesAtWork, rulesInForce } from "../coordinator.ts";
import type { PlannerCallSpec, PlannerViewCall } from "../planner/index.ts";
import { Registry } from "../registry.ts";
import type { ResearchTrialSpec } from "../research/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { lastStopAsked } from "./stops.ts";

/** How much of the judge's reasons a brief shows: for each of a lane's attempts, for each goal. */
export const BRIEF_REASON_CHARS = 1200;
export const BRIEF_GOAL_CHARS = 600;

/**
 * A planner call through another harness: a folder it may read (its past research), the MCP
 * servers it may call with the gateway's credential made for this call (goal 068), and where its
 * model usage goes, as the program's output reports it (goal 075).
 */
export interface PlannerCallOptions {
  read?: string | undefined;
  /** The kit's MCP servers, and Thermite's own with the knowledge base's tools (goal 175). */
  mcp?: { auth: string; servers: string[]; kb?: boolean | undefined } | undefined;
  usage?: ((u: CallUsage) => void) | undefined;
  /**
   * Where the call's conversation is kept before each compaction, and who records it (goal 070):
   * OpenCode's, Codex's or Claude Code's own compactions of a planner call.
   */
  compaction?: OnceKeeping | undefined;
}

export interface SchedulerOptions {
  service: HarnessService;
  runner: Runner;
  /**
   * The model route, or how to read it now: control may set or change the route while the
   * harness runs, and each plan and trial takes the route current when it starts.
   */
  model?: ModelConfig | (() => ModelConfig | undefined) | undefined;
  /**
   * A planner call through a program other than Pi (`via`: OpenCode, Claude Code or Codex, as
   * plannerHarness picks it): the answer's text. `read`: a folder it may read and search (the
   * run's past research), which its user may read and not change.
   */
  ask?:
    | ((
        via: CliHarness,
        model: ModelConfig,
        prompt: string,
        signal?: AbortSignal,
        o?: PlannerCallOptions,
      ) => Promise<string>)
    | undefined;
  /**
   * A planner call in Pi in a process of its own, in its Pi view (goal 169), on a rig whose agents
   * run in their own terminal (planner/view.ts); none: in this process.
   */
  planInView?:
    | ((
        c: Omit<PlannerViewCall, "runner" | "scratchDir" | "port">,
        sent: Prompt,
        spec: PlannerCallSpec,
        signal?: AbortSignal,
      ) => Promise<unknown>)
    | undefined;
  /** The planner's own model route, when control gave the planner one. */
  plannerModel?: (() => ModelConfig | undefined) | undefined;
  /** Runs one trial (in a child process in the harness; in-process in tests); abortable. */
  runTrial: (spec: TrialSpec, signal: AbortSignal) => Promise<TrialResult>;
  /** Research mode: the research service and its trial runner. */
  research?: Research | undefined;
  runResearchTrial?:
    | ((spec: ResearchTrialSpec, signal: AbortSignal) => Promise<TrialResult>)
    | undefined;
  /** Development runs: a lane's queued or running dev run is settled before its next trial. */
  devRuns?: { settle(lane: string): Promise<void> } | undefined;
  owner: string;
  maxConcurrent?: number | undefined;
  /** A trial's length when its contract sets none: none unless the rig sets one (goal 079). */
  trialWallMs?: number | undefined;
  /** A cap on each trial's turns: none unless configured (THERMITE_MAX_TURNS). */
  maxTurns?: number | undefined;
  /** The rig's settings: whether workers start trials and the planner plans (default on). */
  workersOn?: (() => boolean) | undefined;
  plannerOn?: (() => boolean) | undefined;
  /**
   * The rig drains (goal 079): before its images change, no new trial or plan starts, and those
   * running end as they would.
   */
  draining?: (() => boolean) | undefined;
  /** A round's time cap: none unless given (tests only; goal 079). */
  epochCapMs?: number | undefined;
  /** Goal mode: how long an epoch waits for the judge's goal report on a new champion. */
  goalReportWaitMs?: number | undefined;
  /** Model price per million tokens, for the contract's llm_usd budget (unset: not enforced). */
  usdPerMTokIn?: number | undefined;
  usdPerMTokOut?: number | undefined;
  /** Backoff after unproductive trials: base delay and cap. */
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
  /** How long a run waits for its MCP servers before its first plan or trial (MCP_WAIT_MS). */
  mcpWaitMs?: number | undefined;
}

/**
 * How long a run whose kit names MCP servers waits, before its first plan or trial on this
 * harness, for the rig to hold each one its workers or planner get (goal 068). The supervisor
 * hands them over with the model route, every 30 s by default, and a harness that just started
 * or a run just assigned may not have them yet: a trial that started then would list no tools
 * from them for its whole length. A server control says it can't give is not waited for. Pacing,
 * not a cap: once the wait ends, the run goes on without the servers still missing, and History
 * and Live say which and why.
 */
export const MCP_WAIT_MS = 2 * 60_000;

type Optional =
  | "model"
  | "planInView"
  | "research"
  | "runResearchTrial"
  | "devRuns"
  | "usdPerMTokIn"
  | "usdPerMTokOut"
  | "trialWallMs"
  | "epochCapMs"
  | "draining";

/**
 * What the scheduler's parts share, built once by the Scheduler (scheduler.ts): its options with
 * their defaults, the ledger, the lanes' registry and the coordinator, the work in flight, and
 * what each part remembers between steps. Each part is a module of this folder whose functions
 * take it as `sched`.
 */
export interface SchedulerContext {
  o: Required<Omit<SchedulerOptions, Optional>> & Pick<SchedulerOptions, Optional>;
  ledger: Ledger;
  registry: Registry;
  /** How lanes get work from the run's experiment queue. */
  coordinator: Coordinator;
  running: Map<string, Promise<void>>;
  /** Research runs whose starting links this scheduler has begun to archive (goal 078). */
  seeded: Set<string>;
  /** Closed research runs whose final report failed (finishClosedResearch). */
  finalFailed: Set<string>;
  aborts: Map<string, AbortController>;
  /** The run each running trial (by lane) works for. */
  laneRun: Map<string, string>;
  /** The planner call in flight, if any. */
  planning: { run: string; ctrl: AbortController } | undefined;
  watcher: ReturnType<typeof setInterval> | undefined;
  /** The newest workers_reset and trial_stop_asked events acted on. */
  resetSeen: number;
  stopSeen: number;
  reportNoted: string;
  /** Shutting down: no new plan or trial (goal 079). */
  stopping: boolean;
  /**
   * Each run's model calls failing with no call that worked, since when (ms), from its trials'
   * results (goal 079): a trial that ends at its own time limit while its calls fail passes it on.
   */
  failingSince: Map<string, number>;
  /** The provider's limit each run waits for, as Live last said it. */
  limitNoted: Map<string, string>;
  /** Runs waiting for their MCP servers on this harness, since when (ms). */
  mcpWaits: Map<string, number>;
  /** Runs whose wait for their MCP servers is over on this harness. */
  mcpReady: Set<string>;
  /** Each run's champion whose confirmation Live was told about, so it is said once. */
  confirmNoted: Map<string, number>;
  baselineNoted: Map<string, string>;
}

/** The scheduler's context, for its options (scheduler.ts's constructor). */
export function schedulerContext(opts: SchedulerOptions): SchedulerContext {
  const o = {
    maxConcurrent: 1,
    goalReportWaitMs: 2 * 3_600_000,
    backoffBaseMs: 15_000,
    backoffMaxMs: 10 * 60_000,
    mcpWaitMs: MCP_WAIT_MS,
    ...opts,
  } as SchedulerContext["o"];
  const ledger = opts.service.ledger;
  const registry = new Registry(ledger);
  const coordinator = new Coordinator({
    ledger,
    queue: opts.service.queue,
    registry,
  });
  // Resume after a restart: nothing of an earlier process is running any more, and the
  // experiments those trials had go back to the queue.
  registry.interruptUnfinished(opts.owner);
  coordinator.finishOrphans(opts.owner);
  return {
    o,
    ledger,
    registry,
    coordinator,
    running: new Map(),
    seeded: new Set(),
    finalFailed: new Set(),
    aborts: new Map(),
    laneRun: new Map(),
    planning: undefined,
    watcher: undefined,
    resetSeen: ledger.events.lastId("workers_reset"),
    stopSeen: lastStopAsked(ledger),
    reportNoted: "",
    stopping: false,
    failingSince: new Map(),
    limitNoted: new Map(),
    mcpWaits: new Map(),
    mcpReady: new Set(),
    confirmNoted: new Map(),
    baselineNoted: new Map(),
  };
}

/** Trials still running (awaited by tests and on shutdown). */
export async function idle(sched: SchedulerContext): Promise<void> {
  await Promise.all([...sched.running.values()]);
}

/** The directives in force: the owner's first (rulesInForce). */
export function directivesOf(
  sched: SchedulerContext,
  run: string,
): { id: number; body: StoredRule }[] {
  return rulesInForce(sched.ledger, run);
}

export function laneCountOf(sched: SchedulerContext, run: string, contract: Contract): number {
  return lanesAtWork(sched.ledger, run, contract);
}

/** The model route now (none: agents wait). */
export function modelNow(sched: SchedulerContext): ModelConfig | undefined {
  const m = sched.o.model;
  return typeof m === "function" ? m() : m;
}

/**
 * Stopping or draining (goal 079): no new plan or trial starts; those running end as they
 * would. Asked at the top of a step, again after a planner call, and before each trial.
 */
export function halted(sched: SchedulerContext): boolean {
  return sched.stopping || sched.o.draining?.() === true;
}

export function objectiveOf(c: Contract): string {
  if (c.mode === "hill_climb") {
    const p = c.objective.primary;
    return `${p.direction === "max" ? "increase" : "decrease"} ${p.metric} (at least ${(p.min_effect * 100).toFixed(1)}% to count) on cells ${c.cells.join(", ")}, without breaking correctness`;
  }
  if (c.mode === "goal") {
    return `reach these goals: ${c.goals.map((g) => `${g.id} (${g.description})`).join("; ")}`;
  }
  return c.topic;
}

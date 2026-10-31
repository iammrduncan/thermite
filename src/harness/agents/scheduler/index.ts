import type { Prompt } from "../../../agents/prompt.ts";
import type { Contract } from "../../../core/contract.ts";
import { baselineState } from "../../judge/index.ts";
import type { PreviewAsk } from "../../prompts.ts";
import { type Coordinator, keepsWorking } from "../coordinator.ts";
import type { Registry } from "../registry.ts";
import {
  halted,
  idle,
  modelNow,
  type SchedulerContext,
  type SchedulerOptions,
  schedulerContext,
} from "./context.ts";
import { budgetSpent, laneWaitMs, openAttempts, waitingForMcp } from "./gates.ts";
import { awaitingGoalReport, waitingForConfirmation } from "./goal.ts";
import { maybeForkRound, updateLaneBests } from "./lanes.ts";
import { planEpoch } from "./plan.ts";
import { previewPrompt } from "./preview.ts";
import { type AgentsStopped, agentsStopped, stopAgents, waitingForLimit } from "./provider.ts";
import { finishClosedResearch, finishEndedResearch, researchTick } from "./research/index.ts";
import { lanesInRound, roundOver, waitsForJudge } from "./rounds.ts";
import { dropSetupExperiments, isSetupRound, noteBaseline, planSetupEpoch } from "./setup.ts";
import { experimentFor, startTrial } from "./trials.ts";
import { applyResets, applyStops, shutdown } from "./watch.ts";

export { questionDetails } from "../../research/index.ts";
export {
  MCP_WAIT_MS,
  type PlannerCallOptions,
  type SchedulerOptions,
} from "./context.ts";
export { plannerHarness } from "./planner-call.ts";
export { endWait, holdUntil } from "./provider.ts";
export type { AgentsStopped };

/**
 * The agent scheduler (SLA pattern). Each epoch (a round) the planner, as the coordinator of the
 * run's experiment queue, gives every lane an experiment; each lane then runs `trials_per_epoch`
 * trials, one at a time, each on an experiment of its own (the round's first, then the next in
 * the queue): a fresh workspace at the champion (or the lane's best), one worker invocation, at
 * most one submission, and the next trial only after that submission is judged. An epoch ends
 * when its lanes' trials are judged; it has no time cap (goal 079). When its lanes keep working
 * (goal 135), the next trial and the next epoch start while the judge works through their changes
 * (at most max_open_attempts unjudged). Agents never judge: the scheduler only reads verdicts.
 *
 * The model provider decides when agents can work (goal 079): no trial or plan starts while the
 * workers' model check fails or after a trial found no credits, a refused key or an unserved
 * model (the run's agents stop, and the model is checked again after a growing pause), nor while
 * the provider's rate limit asked for a pause.
 *
 * Each part of the scheduler is a module in scheduler/, whose functions take what the parts share
 * (scheduler/context.ts): the stops and resets of work in flight (watch.ts), what the provider
 * allows (provider.ts) and what else holds a run back (gates.ts), a goal campaign's reports
 * (goal.ts), a hill climb's baseline and setup rounds (setup.ts), the lanes' bests (lanes.ts),
 * the planner's calls (planner-call.ts) and the rounds it plans (plan.ts), the trials (trials.ts)
 * and their briefs (briefs.ts), and research mode (research/).
 */
export class Scheduler {
  readonly registry: Registry;
  /** How lanes get work from the run's experiment queue. */
  readonly coordinator: Coordinator;
  /** What the scheduler's parts share. */
  private readonly sched: SchedulerContext;

  constructor(opts: SchedulerOptions) {
    this.sched = schedulerContext(opts);
    this.registry = this.sched.registry;
    this.coordinator = this.sched.coordinator;
  }

  /** The run's agents stop (goal 079), until a model check passes: scheduler/provider.ts. */
  stopAgents(
    run: string,
    why: { kind: AgentsStopped["kind"]; words: string; by: string; said?: string | undefined },
  ): void {
    stopAgents(this.sched, run, why);
  }

  /** Trials still running (awaited by tests and on shutdown): scheduler/context.ts. */
  async idle(): Promise<void> {
    await idle(this.sched);
  }

  /** The harness is stopping (goal 079): scheduler/watch.ts says what stops. */
  async shutdown(reason: string): Promise<void> {
    await shutdown(this.sched, reason);
  }

  /** A role's next prompt in a run, with no side effect (goal 166): scheduler/preview.ts. */
  preview(run: string, ask: PreviewAsk): Prompt {
    return previewPrompt(this.sched, run, ask);
  }

  /** Trials running now (for a drain's report). */
  get trialsRunning(): number {
    return this.sched.running.size;
  }

  /** The run whose planner's call is out now, for the health route (goal 173). */
  get planningFor(): string | undefined {
    return this.sched.planning?.run;
  }

  /** New limits from the rig's settings; they apply from the next trial or check. */
  configure(p: {
    maxConcurrent?: number;
    trialWallMs?: number | undefined;
    maxTurns?: number | undefined;
  }): void {
    Object.assign(this.sched.o, p);
  }

  private run(): { id: string; contract: Contract } | undefined {
    const inst = this.sched.ledger.runs.list().find((i) => i.status === "running");
    // A judge-only run: no planning, no trials.
    if (!inst?.agents) return undefined;
    if (inst.mode === "research" && !(this.sched.o.research && this.sched.o.runResearchTrial))
      return undefined;
    return { id: inst.id, contract: this.sched.o.service.contractFor(inst.id) };
  }

  /** One scheduling step: plan when needed, start trials that may start. */
  async tick(): Promise<boolean> {
    const sched = this.sched;
    applyStops(sched);
    await applyResets(sched);
    // Stopping or draining: no new plan or trial; those running end as they would.
    if (halted(sched)) return false;
    finishClosedResearch(sched);
    finishEndedResearch(sched);
    const inst = this.run();
    if (!inst || !modelNow(sched)) return false;
    // The contract's wall-time budget ends agent work (the judge still finishes what is queued).
    const wallHours = inst.contract.budget.wall_hours;
    const created = sched.ledger.runs.createdAt(inst.id);
    if (
      wallHours !== undefined &&
      created &&
      Date.now() - Date.parse(created) > wallHours * 3_600_000
    ) {
      if (!sched.running.size) {
        sched.ledger.runs.setStatus(
          inst.id,
          "paused",
          "the wall-time budget is spent",
          sched.o.owner,
        );
      }
      return false;
    }
    const spent = budgetSpent(sched, inst.id, inst.contract);
    if (spent) {
      if (!sched.running.size) sched.ledger.runs.setStatus(inst.id, "paused", spent, sched.o.owner);
      return false;
    }
    if (agentsStopped(sched, inst.id)) return false;
    if (waitingForLimit(sched, inst.id)) return false;
    // The MCP servers the run's kit names, before its first plan or trial (goal 068).
    if (waitingForMcp(sched, inst.id)) return false;
    if (inst.contract.mode === "research") return researchTick(sched, inst.id, inst.contract);
    const { id, contract } = inst;
    if (contract.mode === "goal" && waitingForConfirmation(sched, id)) return false;
    let epoch = sched.registry.currentEpoch(id);
    // A hill climb's baseline (goal 115): no round is planned and no trial starts until the
    // judge has measured the starting point. When it can't, the run is in setup: its rounds are
    // setup rounds, one trial a lane, each working to make the starting point build and run.
    const base = contract.mode === "hill_climb" ? baselineState(sched.ledger, id) : undefined;
    if (base?.state === "waiting") {
      noteBaseline(sched, id, base, epoch && !epoch.ended_at ? epoch.n : (epoch?.n ?? 0) + 1);
      return false;
    }
    const setup = base?.state === "setup" ? base : undefined;
    if (base) noteBaseline(sched, id, base, 0);
    if (base?.state === "measured") dropSetupExperiments(sched, id);
    // A round of the other kind (a setup round once the starting point is measured, a round of
    // the plan while in setup) starts no new trial, and ends when its trials have.
    if (base && epoch && !epoch.ended_at && isSetupRound(epoch) !== !!setup) {
      if (!sched.running.size) sched.registry.endEpoch(id, epoch.n, sched.o.owner);
      return false;
    }
    const perEpoch = setup ? 1 : contract.lanes.trials_per_epoch;
    if (!epoch || epoch.ended_at) {
      if (contract.mode === "goal" && awaitingGoalReport(sched, id, (epoch?.n ?? 0) + 1))
        return false;
      if (setup) planSetupEpoch(sched, id, contract, (epoch?.n ?? 0) + 1, setup);
      else {
        maybeForkRound(sched, id, contract, (epoch?.n ?? 0) + 1);
        await planEpoch(sched, id, contract, (epoch?.n ?? 0) + 1);
      }
      epoch = sched.registry.currentEpoch(id);
      if (!epoch) return false;
      // A drain or a stop that began while the planner worked (goal 079): the round is
      // recorded, and no trial starts.
      if (halted(sched)) return false;
    }
    updateLaneBests(
      sched,
      id,
      epoch.assignments.map((a) => a.lane),
    );

    let started = false;
    const keep = keepsWorking(sched.ledger, id, contract);
    for (const a of epoch.assignments) {
      const trials = sched.registry.trials(id, a.lane, epoch.n);
      const last = trials.at(-1);
      if (trials.length >= perEpoch || sched.running.has(a.lane)) continue;
      if (last?.ended === false || waitsForJudge(sched.ledger, sched.registry, id, a.lane, keep))
        continue;
      if (sched.running.size >= sched.o.maxConcurrent) continue;
      if (sched.o.workersOn && !sched.o.workersOn()) continue;
      if (openAttempts(sched, id) >= contract.budget.max_open_attempts) continue;
      if (laneWaitMs(sched, id, a.lane, false) > 0) continue;
      // Each trial asks again: no trial starts once the rig drains or stops.
      if (halted(sched)) return started;
      const k = trials.length + 1;
      const got = experimentFor(sched, id, epoch, a, k, {
        perEpoch,
        laneCount: epoch.assignments.length,
      });
      if (!got) continue;
      startTrial(sched, id, contract, epoch.n, a, k, perEpoch, got);
      started = true;
    }
    // Not waiting for other lanes' trials (goal 136); no time cap unless one is given (tests).
    const capped =
      sched.o.epochCapMs !== undefined &&
      Date.now() - Date.parse(epoch.started_at) > sched.o.epochCapMs;
    const lanes = lanesInRound(sched.ledger, sched.registry, id, epoch, sched.running, keep);
    if (roundOver(lanes, perEpoch) || (capped && !sched.running.size))
      sched.registry.endEpoch(id, epoch.n, sched.o.owner);
    return started;
  }
}

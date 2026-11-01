import type { ModelConfig } from "../agents/model/index.ts";
import {
  type CallContext,
  CallUsage,
  MODEL_CALL_EVENT,
  type UsageAgent,
  type UsageHarness,
  type UsageRoute,
} from "../core/usage.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";

/**
 * The rig's record of its agents' model usage (goal 075): one `model_call` event for each record,
 * about its run. The harness records what it measures itself (OpenCode, Codex and Claude Code
 * output, the planner in Pi) and what a Pi worker's own code hands over with its trial's token;
 * the supervisor hands over its advisors'. The event carries the record whole, so it reaches
 * control with the rig's other events, and an export keeps it with the run.
 */

/** The route of an agent's model as the harness configured it (no provider: the rig's own). */
export function routeOf(m: ModelConfig, harness?: UsageHarness | undefined): UsageRoute {
  return {
    harness: harness ?? m.harness ?? "pi",
    provider: m.provider ?? null,
    model: m.model,
  };
}

export class ModelUsage {
  private readonly ledger: Ledger;
  /** The open trials whose worker hands its records over (Pi's): their run and route. */
  private readonly handedOver = new Map<
    string,
    { run: string; agent: UsageAgent; route: UsageRoute }
  >();

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** Records one record of a run; returns its event's id. */
  record(actor: string, run: string, ctx: CallContext, u: CallUsage): number {
    const usage = CallUsage.parse(u);
    return this.ledger.appendEvent(actor, MODEL_CALL_EVENT, run, { ...ctx, ...usage });
  }

  /** What the harness itself measured of an agent's calls, recorded as it comes. */
  recorder(
    run: string,
    ctx: { trial?: string | null; round?: string | null; agent: UsageAgent },
    route: UsageRoute,
  ): (u: CallUsage) => void {
    const context: CallContext = {
      trial: ctx.trial ?? null,
      round: ctx.round ?? null,
      agent: ctx.agent,
      ...route,
    };
    return (u) => {
      this.record("harness", run, context, u);
    };
  }

  /**
   * A trial whose worker (Pi) hands its records over with the trial's token, until `close`. Only
   * these trials may: an agent whose own program reads the trial's token (OpenCode, Codex, Claude
   * Code) never hands any over, and the harness reads its program's output instead.
   */
  open(trial: { id: string; run: string }, route: UsageRoute, agent: UsageAgent = "workers"): void {
    this.handedOver.set(trial.id, { run: trial.run, agent, route });
  }

  close(trial: string): void {
    this.handedOver.delete(trial);
  }

  /** A worker's records, handed over with its trial's token; returns how many were recorded. */
  fromTrial(trial: { id: string; run: string }, calls: readonly CallUsage[]): number {
    const t = this.handedOver.get(trial.id);
    if (!t || t.run !== trial.run)
      throw new LedgerError(
        "conflict",
        "this trial's model usage is recorded by the harness, not handed over",
      );
    const record = this.recorder(t.run, { trial: trial.id, agent: t.agent }, t.route);
    this.ledger.tx(() => {
      for (const u of calls) record(u);
    });
    return calls.length;
  }

  /** The supervisor's records of one advisor's calls in a run; returns how many were recorded. */
  fromSupervisor(run: string, ctx: CallContext, calls: readonly CallUsage[]): number {
    if (!this.ledger.runs.get(run)) throw new LedgerError("not_found", `no run ${run}`);
    this.ledger.tx(() => {
      for (const u of calls) this.record("supervisor", run, ctx, u);
    });
    return calls.length;
  }
}

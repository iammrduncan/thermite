import { parseDuration } from "../../../core/duration.ts";
import { workedTime } from "../../run-clock.ts";
import type { ResearchContext } from "./context.ts";

/**
 * Running time against the contract's durations. Paused time does not count, and neither does
 * time the agents could not run (goal 079): while they were stopped (no credits, a refused key,
 * a failing model check), waited for the provider's rate limit or for the run's MCP servers, or
 * the rig drained (goal 136), or while the harness did not run at all (the host slept, the
 * harness was stopped or it crashed): the time it worked, `workedTime`, as every run's wall-time
 * budget counts it (goal 198). The minimum is a floor, never
 * a stop: after it, a run ends when the review panel finds every question answered (goal 112),
 * at its maximum, or when the owner closes it.
 */
/** The run's clock; with `now`, as it stood then (running time up to that moment). */
export function clockOf(ctx: ResearchContext, run: string, now = Date.now()) {
  const c = ctx.contract(run);
  const created = String(ctx.ledger.runs.createdAt(run));
  const { elapsed_ms: elapsedMs, waited_ms: waitedMs } = workedTime(ctx.ledger, run, now);
  const minMs = parseDuration(c.min_duration as string);
  const maxMs = c.max_duration ? parseDuration(c.max_duration) : null;
  return {
    started_at: created,
    elapsed_ms: elapsedMs,
    /** Running time the agents could not work: not counted (goal 079). */
    waited_ms: waitedMs,
    min_ms: minMs,
    max_ms: maxMs,
    done: maxMs !== null && elapsedMs >= maxMs,
  };
}

import { parseDuration } from "../../../core/duration.ts";
import { statusEvents } from "../../run-status.ts";
import { blockedSpans } from "../blocked.ts";
import type { ResearchContext } from "./context.ts";

/**
 * Running time against the contract's durations. Paused time does not count, and neither does
 * time the agents could not run (goal 079): while they were stopped (no credits, a refused key,
 * a failing model check), waited for the provider's rate limit or for the run's MCP servers, or
 * the rig drained (goal 136): `blockedSpans`. The minimum is a floor, never
 * a stop: after it, a run ends when the review panel finds every question answered (goal 112),
 * at its maximum, or when the owner closes it.
 */
/** The run's clock; with `now`, as it stood then (running time up to that moment). */
export function clockOf(ctx: ResearchContext, run: string, now = Date.now()) {
  const c = ctx.contract(run);
  const created = String(ctx.ledger.runs.createdAt(run));
  const running: [number, number][] = [];
  let since: number | null = Date.parse(created);
  for (const e of statusEvents(ctx.ledger, run)) {
    const status = e.status;
    const at = Date.parse(e.at);
    if (at > now) break;
    if (status === "running") since ??= at;
    else if (since !== null) {
      running.push([since, at]);
      since = null;
    }
  }
  if (since !== null) running.push([since, now]);
  const blocked = blockedSpans(ctx.ledger, run, now);
  let elapsedMs = 0;
  let waitedMs = 0;
  for (const [a, b] of running) {
    let lost = 0;
    for (const [x, y] of blocked) lost += Math.max(0, Math.min(b, y) - Math.max(a, x));
    elapsedMs += b - a - lost;
    waitedMs += lost;
  }
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

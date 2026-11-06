import type { Ledger } from "./ledger/index.ts";
import { statusEvents } from "./run-status.ts";
import { drainSpans, gapSpans } from "./service/index.ts";

/**
 * When a run's agents could not work, merged and in order, which a run's clock leaves out
 * (goal 079 for research, goal 198 for every mode):
 * - from each `agents_stopped` to the `agents_resumed` after it (or now);
 * - each wait for the provider's rate limit, until the time it named, or until the owner ended it;
 * - each wait for the run's MCP servers (goal 068), from its start to its end;
 * - each drain of the rig (goal 136), when no new trial or plan could start;
 * - each gap in the harness's running time, when the host slept, the harness was stopped or it
 *   crashed (`service/gaps.ts`).
 */
function blockedSpans(ledger: Ledger, run: string, now: number): [number, number][] {
  const spans: [number, number][] = [...drainSpans(ledger, now), ...gapSpans(ledger)];
  const waits: [number, number][] = [];
  let stoppedAt: number | null = null;
  for (const e of ledger.events.list(
    [
      "agents_stopped",
      "agents_resumed",
      "agents_wait_for_limit",
      "agents_wait_ended",
      "mcp_servers_wait",
    ],
    { subject: run },
  )) {
    const at = Date.parse(e.at);
    if (e.kind === "agents_stopped") stoppedAt ??= at;
    else if (e.kind === "agents_resumed") {
      if (stoppedAt !== null) spans.push([stoppedAt, at]);
      stoppedAt = null;
    } else if (e.kind === "mcp_servers_wait") {
      const since = Date.parse(String(e.body.since));
      if (!Number.isNaN(since) && since < at) spans.push([since, at]);
    } else if (e.kind === "agents_wait_ended") {
      // The owner ended the wait: none asked before lasts past it.
      for (const w of waits) w[1] = Math.max(w[0], Math.min(w[1], at));
    } else {
      const until = Date.parse(String(e.body.until));
      if (!Number.isNaN(until) && until > at) waits.push([at, Math.min(until, now)]);
    }
  }
  spans.push(...waits);
  if (stoppedAt !== null) spans.push([stoppedAt, now]);
  spans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

/**
 * The time a run worked, up to `now` (goal 198): its running time, from its creation, with its
 * paused time left out, and the time its agents could not work while it ran (`blockedSpans`)
 * left out too, in `waited_ms`. A research run's durations and every run's `wall_hours` count it.
 */
export function workedTime(
  ledger: Ledger,
  run: string,
  now = ledger.nowMs(),
): { elapsed_ms: number; waited_ms: number } {
  const running: [number, number][] = [];
  let since: number | null = Date.parse(String(ledger.runs.createdAt(run)));
  for (const e of statusEvents(ledger, run)) {
    const at = Date.parse(e.at);
    if (at > now) break;
    if (e.status === "running") since ??= at;
    else if (since !== null) {
      running.push([since, at]);
      since = null;
    }
  }
  if (since !== null) running.push([since, now]);
  const blocked = blockedSpans(ledger, run, now);
  let elapsedMs = 0;
  let waitedMs = 0;
  for (const [a, b] of running) {
    let lost = 0;
    for (const [x, y] of blocked) lost += Math.max(0, Math.min(b, y) - Math.max(a, x));
    elapsedMs += b - a - lost;
    waitedMs += lost;
  }
  return { elapsed_ms: elapsedMs, waited_ms: waitedMs };
}

/**
 * A run's hours of work (goal 198): its contract's `wall_hours` with the hours the owner added
 * since (add_run_hours); undefined for a run with no stop time.
 */
export function hoursOf(
  ledger: Ledger,
  run: string,
  wallHours: number | undefined,
): number | undefined {
  if (wallHours === undefined) return undefined;
  const added = ledger.events.list("run_hours_added", { subject: run });
  return added.reduce((n, e) => n + e.body.hours, wallHours);
}

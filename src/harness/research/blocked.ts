import type { Ledger } from "../ledger/index.ts";
import { drainSpans } from "../service/index.ts";

/**
 * When a run's agents could not work, merged and in order, for its research clock, which leaves
 * this time out (goal 079):
 * - from each `agents_stopped` to the `agents_resumed` after it (or now);
 * - each wait for the provider's rate limit, until the time it named, or until the owner ended it;
 * - each wait for the run's MCP servers (goal 068), from its start to its end;
 * - each drain of the rig (goal 136), when no new trial or plan could start.
 */
export function blockedSpans(ledger: Ledger, run: string, now: number): [number, number][] {
  const spans: [number, number][] = drainSpans(ledger, now);
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

import type { Ledger } from "../ledger/index.ts";
import { drainSpans, gapSpans } from "../service/index.ts";

/**
 * When a run's agents could not work, merged and in order, for its research clock, which leaves
 * this time out (goal 079):
 * - from each `agents_stopped` to the `agents_resumed` after it (or now);
 * - each wait for the provider's rate limit, until the time it named;
 * - each wait for the run's MCP servers (goal 068), from its start to its end;
 * - each drain of the rig (goal 136), when no new trial or plan could start;
 * - each gap in the harness's running time, when the host slept, the harness was stopped or it
 *   crashed (`service/gaps.ts`).
 */
export function blockedSpans(ledger: Ledger, run: string, now: number): [number, number][] {
  const spans: [number, number][] = [...drainSpans(ledger, now), ...gapSpans(ledger)];
  let stoppedAt: number | null = null;
  for (const e of ledger.events.list(
    ["agents_stopped", "agents_resumed", "agents_wait_for_limit", "mcp_servers_wait"],
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
    } else {
      const until = Date.parse(String(e.body.until));
      if (!Number.isNaN(until) && until > at) spans.push([at, Math.min(until, now)]);
    }
  }
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

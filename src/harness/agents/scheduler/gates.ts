import { NOT_HANDED } from "../../../agents/mcp/index.ts";
import type { Contract } from "../../../core/contract.ts";
import type { SchedulerContext } from "./context.ts";

/**
 * What holds a run's next plan or trial back, other than its provider (provider.ts): a lane's
 * backoff after unproductive trials, the contract's budgets, the attempts the judge has not
 * finished with, and the MCP servers the run's kit names.
 */

/** Lifecycles of attempts the judge has not finished with. */
const OPEN_LIFECYCLES = [
  "queued",
  "building",
  "screening",
  "confirming",
  "verifying",
  "awaiting_audit",
  "awaiting_approval",
];

/** Why a lane must wait before its next trial (backoff after unproductive trials), if it must. */
export function laneWaitMs(
  sched: SchedulerContext,
  run: string,
  lane: string,
  research: boolean,
): number {
  const recent = sched.registry.recentTrials(run, lane, 8);
  let k = 0;
  for (const t of recent) {
    const lifecycle = t.attempt ? String(sched.ledger.attempts.get(t.attempt)?.lifecycle) : null;
    const unproductive = research
      ? t.stopped === "error"
      : t.stopped === "error" ||
        (!t.attempt && t.stopped !== "interrupted") ||
        lifecycle === "rejected_v0" ||
        lifecycle === "duplicate";
    if (!unproductive) break;
    k++;
  }
  if (!k || !recent[0]) return 0;
  const delay = Math.min(sched.o.backoffBaseMs * 2 ** (k - 1), sched.o.backoffMaxMs);
  return Math.max(0, Date.parse(recent[0].ended_at) + delay - Date.now());
}

/**
 * Whether a run waits for the MCP servers its kit names (MCP_WAIT_MS): no plan or trial starts
 * until the rig holds each one its workers or planner get, or control says why it can't give
 * one, or the wait ends. Then, once, History (`mcp_servers_wait`) and Live say how long it
 * waited and which are missing and why, and the run goes on without those: each later trial
 * gets a server the rig holds by then. A research run's clock does not count the wait. In this
 * process's memory: after a restart, the harness holds no server until the supervisor hands
 * them over again, so the run waits again.
 */
export function waitingForMcp(sched: SchedulerContext, run: string): boolean {
  if (sched.mcpReady.has(run)) return false;
  const lacking = sched.o.service.mcp.lacking(run);
  const unknown = lacking.filter((l) => l.why === undefined).map((l) => l.name);
  const since = sched.mcpWaits.get(run);
  const now = Date.now();
  const say = (text: string) =>
    sched.o.service.live.append({ source: "planner", kind: "status", text, run });
  const seconds = Math.round(sched.o.mcpWaitMs / 1000);
  if (unknown.length && (since === undefined || now - since < sched.o.mcpWaitMs)) {
    if (since === undefined) {
      sched.mcpWaits.set(run, now);
      say(
        `waiting for the MCP ${unknown.length === 1 ? "server" : "servers"} ${unknown.join(", ")}: control has not handed ${unknown.length === 1 ? "it" : "them"} to this rig yet. No plan or trial starts until ${unknown.length === 1 ? "it comes" : "they come"}, for up to ${seconds} s.`,
      );
    }
    return true;
  }
  sched.mcpReady.add(run);
  sched.mcpWaits.delete(run);
  const missing = lacking.map((l) => ({ name: l.name, why: l.why ?? NOT_HANDED }));
  const waited = since === undefined ? 0 : Math.round((now - since) / 1000);
  if (since !== undefined || missing.length)
    sched.ledger.appendEvent(sched.o.owner, "mcp_servers_wait", run, {
      ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
      waited_s: waited,
      missing,
    });
  if (missing.length) {
    say(
      `the run goes on without the MCP ${missing.length === 1 ? "server" : "servers"} ${missing.map((s) => `${s.name} (${s.why})`).join("; ")}${since !== undefined ? `, after waiting ${waited} s` : ""}. A later trial gets each one once the rig has it.`,
    );
  } else if (since !== undefined) {
    say("the run's MCP servers reached this rig: its plans and trials start with their tools.");
  }
  return false;
}

/** The contract's budgets that end agent work, other than wall time: the first one spent. */
export function budgetSpent(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
): string | undefined {
  const b = contract.budget;
  if (b.device_hours !== undefined && sched.ledger.jobs.deviceHours(run) >= b.device_hours)
    return "the device-hours budget is spent";
  if (
    b.llm_usd !== undefined &&
    sched.o.usdPerMTokIn !== undefined &&
    sched.o.usdPerMTokOut !== undefined
  ) {
    const t = sched.registry.tokensUsed(run);
    const usd = (t.in * sched.o.usdPerMTokIn + t.out * sched.o.usdPerMTokOut) / 1e6;
    if (usd >= b.llm_usd) return `the model budget is spent ($${usd.toFixed(2)})`;
  }
  return undefined;
}

export function openAttempts(sched: SchedulerContext, run: string): number {
  return sched.ledger.attempts.countIn(run, OPEN_LIFECYCLES);
}

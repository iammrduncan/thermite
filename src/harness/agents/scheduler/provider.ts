import type { Contract } from "../../../core/contract.ts";
import type { Ledger } from "../../ledger/index.ts";
import { statusEvents } from "../../run-status.ts";
import { HARNESS_NUMBERS } from "../../settings.ts";
import { limitsInForce } from "../coordinator.ts";
import {
  classifyProviderError,
  FAILING_SAID,
  failedTooLong,
  KIND_WORDS,
  type ProviderErrorKind,
  stopsAgents,
} from "../provider-errors.ts";
import type { TrialResult } from "../worker/index.ts";
import type { SchedulerContext } from "./context.ts";

/**
 * When the model provider lets the run's agents work (goal 079; the Scheduler's comment, in
 * scheduler.ts, says how): the workers' model check, the provider's errors in trials, and a
 * subscription's usage window.
 */

/** The longest a trial may be set to last: a contract's trial_minutes, THERMITE_TRIAL_MINUTES. */
const LONGEST_TRIAL_MS = HARNESS_NUMBERS.trialMinutes.rule.max * 60_000;

/**
 * The end of a wait for the provider that a trial's words ask for (its worker's wait, or a reset
 * time its program gave at its end), at most one of its run's trials long from now: the run's
 * trial length (a trial_minutes rule, else its contract's), else the rig's (`rigMs`), else the
 * longest a trial may be set to, 24 hours. A trial's words never hold its run longer than one
 * trial could last; a limit still in force then shows again in the next trial, which asks again.
 */
export function holdUntil(
  ledger: Ledger,
  run: string,
  contract: Contract,
  rigMs: number | undefined,
  until: string,
  now = Date.now(),
): string {
  const minutes = limitsInForce(ledger, run, contract).trialMinutes;
  const longest = minutes ? minutes * 60_000 : (rigMs ?? LONGEST_TRIAL_MS);
  return new Date(Math.min(Date.parse(until), now + longest)).toISOString();
}

/** The first pause before the model is checked again after the run's agents stopped (goal 079). */
const RECHECK_FIRST_MS = 60_000;
/** The longest pause between those checks: they double up to it. */
const RECHECK_MAX_MS = 30 * 60_000;

/** Why the run's agents are stopped (goal 079): the provider's kind and words. */
export interface AgentsStopped {
  kind: ProviderErrorKind | "check";
  words: string;
  /** What found it: a trial, the model check. */
  by: string;
  since: string;
}

/**
 * The run's wait for its provider's limit now: its newest, until its time, unless the owner ended
 * it (`agents_wait_ended`). Undefined: the run does not wait.
 */
export function holdOf(
  ledger: Ledger,
  run: string,
  now = Date.now(),
): { until: string; reason: string } | undefined {
  const e = ledger.events.newest(["agents_wait_for_limit", "agents_wait_ended"], { subject: run });
  if (e?.kind !== "agents_wait_for_limit") return undefined;
  const until = String(e.body.until);
  return Date.parse(until) > now ? { until, reason: String(e.body.reason ?? "") } : undefined;
}

/**
 * The owner (or an operator, for the owner) ends the run's wait for its provider now (`end_wait`):
 * its new trials and plans start at once. A limit still in force shows again in the next trial,
 * which waits again. Nothing is recorded for a run that does not wait.
 */
export function endWait(
  ledger: Ledger,
  run: string,
  by: string,
  now = Date.now(),
): { run: string; ended: boolean; until?: string } {
  const hold = holdOf(ledger, run, now);
  if (!hold) return { run, ended: false };
  ledger.appendEvent(by, "agents_wait_ended", run, { until: hold.until });
  return { run, ended: true, until: hold.until };
}

/**
 * The provider's limit holds the run (one of its trials said until when, at most one trial's
 * length ahead: holdUntil): no new trials or plans for this run until then, or until the owner
 * ends the wait. The agents wait; nothing pays for more (the owner's rule). A hold is its own
 * run's: the rig's other runs go on.
 */
export function waitingForLimit(sched: SchedulerContext, run: string): boolean {
  const hold = holdOf(sched.ledger, run);
  if (!hold) return false;
  if (sched.limitNoted.get(run) !== hold.until) {
    sched.limitNoted.set(run, hold.until);
    sched.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `agents wait for the subscription's usage window to reset at ${hold.until}`,
      run,
    });
  }
  return true;
}

/** The workers' model checks finished after event `after`, newest first. */
function modelChecks(
  sched: SchedulerContext,
  after: number,
): { id: number; at: string; ok: boolean; summary: string }[] {
  return sched.ledger.events
    .list("rig_check_finished", { after, body: { check: "model" } })
    .reverse()
    .map((e) => ({
      id: e.id,
      at: e.at,
      ok: e.body.ok === true,
      summary: String(e.body.summary),
    }));
}

/**
 * The run's agents stop (goal 079): no new trial or plan, until a model check passes or the
 * route changes. Recorded once, with the provider's words, for History and Needs you. `said`
 * replaces the kind's own words (a failure that never cleared).
 */
export function stopAgents(
  sched: SchedulerContext,
  run: string,
  why: { kind: AgentsStopped["kind"]; words: string; by: string; said?: string | undefined },
): void {
  const stop = sched.ledger.events.newest(["agents_stopped", "agents_resumed"], { subject: run });
  if (stop?.kind === "agents_stopped") return;
  const said =
    why.said ?? (why.kind === "check" ? "the workers' model check fails" : KIND_WORDS[why.kind]);
  sched.ledger.appendEvent(sched.o.owner, "agents_stopped", run, {
    kind: why.kind,
    words: why.words.slice(0, 600),
    by: why.by,
    said,
  });
  sched.o.service.live.append({
    source: "planner",
    kind: "status",
    text: `the agents stop: ${said} (${why.words.slice(0, 300)}). No trial starts until a model check passes; the model is checked again in a minute, then less often.`,
    run,
  });
}

/**
 * Why the run's agents are stopped now, if they are (goal 079). A failing model check of the
 * workers' route (newer than the route) stops them; so does a trial that found no credits, a
 * refused key or an unserved model. They go on once a model check passes after the stop, or the
 * route changes. While stopped, the model is checked again after a pause that doubles from a
 * minute to 30 minutes; at once after the owner resumes the run.
 */
export function agentsStopped(sched: SchedulerContext, run: string): AgentsStopped | undefined {
  const stop = sched.ledger.events.newest(["agents_stopped", "agents_resumed"], { subject: run });
  const change = sched.ledger.events.lastId(["model_route_set", "model_route_cleared"]);
  const open = stop?.kind === "agents_stopped" ? stop : undefined;
  if (open) {
    const checks = modelChecks(sched, open.id);
    const passed = checks.find((c) => c.ok);
    const changed = change > open.id;
    if (passed || changed) {
      sched.ledger.appendEvent(sched.o.owner, "agents_resumed", run, {
        why: passed ? "a model check passed" : "the rig's model route changed",
      });
      sched.o.service.live.append({
        source: "planner",
        kind: "status",
        text: `the agents go on: ${passed ? "a model check passed" : "the rig's model route changed"}`,
        run,
      });
      return undefined;
    }
    maybeRecheck(sched, run, open, checks);
    return {
      kind: open.body.kind as AgentsStopped["kind"],
      words: String(open.body.words ?? ""),
      by: String(open.body.by ?? ""),
      since: open.at,
    };
  }
  // A failing model check of the workers' route, newer than the route and than the last time
  // the agents went on: no trial starts on a model that fails it.
  const last = modelChecks(sched, Math.max(change, stop?.id ?? 0))[0];
  if (last && !last.ok) {
    const kind = classifyProviderError(last.summary).kind;
    stopAgents(sched, run, {
      kind: stopsAgents(kind) ? kind : "check",
      words: last.summary,
      by: "the model check",
    });
    return {
      kind: stopsAgents(kind) ? kind : "check",
      words: last.summary,
      by: "the model check",
      since: last.at,
    };
  }
  return undefined;
}

/** While stopped: the model is checked again after a growing pause, at once after a resume. */
function maybeRecheck(
  sched: SchedulerContext,
  run: string,
  open: { id: number; at: string },
  checks: { id: number; at: string }[],
): void {
  if (sched.o.service.modelCheckRunning()) return;
  const after = Math.max(open.id, checks[0]?.id ?? 0);
  const resumed = statusEvents(sched.ledger, run, after).some((e) => e.status === "running");
  const pause = Math.min(RECHECK_MAX_MS, RECHECK_FIRST_MS * 2 ** checks.length);
  const due = Date.parse(checks[0]?.at ?? open.at) + pause;
  if (!resumed && Date.now() < due) return;
  sched.o.service.checkModelNow("scheduler");
}

/**
 * What a trial's provider error means for the run (goal 079): no credits, a refused key or an
 * unserved model stop the run's agents; so do model calls that failed with the provider's
 * passing faults or the model's own errors, with no call that worked, for 30 minutes; a rate
 * limit with a time makes them wait until then. Only the kind the provider's call set counts
 * (`errorKind`): a local failure (a workspace that could not be set up, a worker process that
 * gave no result, a program that exited) never stops the agents, whatever its words.
 */
export function afterTrial(sched: SchedulerContext, id: string, run: string, r: TrialResult): void {
  if (stopOnLongFailure(sched, id, run, r)) return;
  if (r.stopped !== "error" || !r.error) return;
  const kind = r.errorKind;
  if (stopsAgents(kind)) {
    stopAgents(sched, run, { kind: kind as ProviderErrorKind, words: r.error, by: `trial ${id}` });
    return;
  }
  const until =
    r.retryAfter ?? (kind === "rate_limit" ? classifyProviderError(r.error).retryAt : undefined);
  if (until)
    sched.ledger.appendEvent(sched.o.owner, "agents_wait_for_limit", run, {
      until: holdUntil(
        sched.ledger,
        run,
        sched.o.service.contractFor(run),
        sched.o.trialWallMs,
        until,
      ),
      trial: id,
      reason: r.error,
    });
}

/**
 * The run's model calls have failed with the provider's passing faults or the model's own
 * errors, with no call that worked, for 30 minutes (goal 079): within one trial, or over trials
 * that each ended at their own time limit while their calls failed. The run's agents stop as
 * for no credits, with the newest failure's words. Pacing, so that the owner sees a failure
 * that never clears; the model is checked again as for any stop. A trial whose calls worked at
 * its end clears the run's count. True when the agents stopped.
 */
function stopOnLongFailure(
  sched: SchedulerContext,
  id: string,
  run: string,
  r: TrialResult,
): boolean {
  const f = r.failing;
  if (!f) {
    if (r.submitted || r.tokensIn > 0 || r.tokensOut > 0) sched.failingSince.delete(run);
    return false;
  }
  const since = Math.min(
    sched.failingSince.get(run) ?? Number.POSITIVE_INFINITY,
    Date.parse(f.since),
  );
  if (!failedTooLong(since)) {
    sched.failingSince.set(run, since);
    return false;
  }
  sched.failingSince.delete(run);
  stopAgents(sched, run, {
    kind: f.kind,
    words: f.words,
    by: `trial ${id}`,
    said: `${FAILING_SAID} (${KIND_WORDS[f.kind]})`,
  });
  return true;
}

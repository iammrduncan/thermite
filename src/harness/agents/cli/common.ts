import type { CliProgram, CliRun, CliTally, MessageInbox } from "../../../agents/cli/index.ts";
import { tallyDifferences } from "../../../agents/programs/index.ts";
import { errorText } from "../../../common/errors.ts";
import { log, logDebug, logWarn } from "../../../common/log.ts";
import type { LaneLimitValues } from "../../../core/contract.ts";
import type { Role, RunOutcome } from "../../broker/index.ts";
import type { ProgramStep } from "../provider-errors.ts";
import type { TrialResult } from "../worker/index.ts";

/**
 * What the trial loops of the agent programs that run as command-line programs (OpenCode,
 * Claude Code, Codex) share (goal 125, T7): the limits as the agent reads them, why a limit
 * stopped the program, the owner's messages a continued session carries, the usage hand-over, and
 * the comparison of a program's own session log with its output (goal 169)
 * (the PATH their agent's shell gets is in src/agents/programs/path.ts). What a continued session
 * is told comes from its role's definition (src/agents/roles/, goal 166).
 */

/** Why the broker stopped the program, when a memory or disk limit did. */
export function breachError(
  o: Pick<RunOutcome, "killedFor"> &
    Partial<Pick<RunOutcome, "peakRssBytes" | "peakDiskBytes" | "peakEntries">>,
  limits: LaneLimitValues,
  program: string,
): string | undefined {
  const mib = (b: number | undefined) => Math.round((b ?? 0) / 1024 ** 2);
  if (o.killedFor === "memory")
    return `stopped by the lane's memory limit: ${program} reached ${mib(o.peakRssBytes)} MiB with what it ran, over ${limits.runRssMib} MiB (the contract's lanes.limits.run_rss_mib), and its commands' memory could not be freed`;
  if (o.killedFor === "disk")
    return `stopped by the lane's disk limit: the trial's directory reached ${mib(o.peakDiskBytes)} MiB in ${o.peakEntries ?? 0} files, over ${limits.workspaceMib} MiB (lanes.limits.workspace_mib) or 50,000 files`;
  return undefined;
}

/** Whether a trial used its turns: a cap set by Turns per trial (none unless configured). */
export const turnsUp = (spec: { maxTurns?: number | undefined }, tally: { turns: number }) =>
  spec.maxTurns !== undefined && tally.turns >= spec.maxTurns;

/**
 * How a trial ends when the step after a provider's error (afterProgramFailure) does not go on:
 * stopped, out of time, or ended by the error's kind or the campaign's limit.
 */
export function trialEnd(
  step: Exclude<ProgramStep, { goOn: string }>,
): Pick<TrialResult, "stopped" | "error" | "errorKind"> {
  if ("interrupted" in step) return { stopped: "interrupted" };
  if ("wall" in step) return { stopped: "wall" };
  return { stopped: "error", error: step.end.error, errorKind: step.end.kind };
}

/**
 * A submission ends the trial (OpenCode or Claude Code): the submit command gets this long to
 * finish and its result to be recorded, then the lane's processes are stopped. The submission is
 * in the ledger before the harness sees it, so stopping cuts off only the agent's closing reply,
 * which would keep the lane busy (a slow model's took about 40 s) for nothing.
 */
export const AFTER_SUBMIT_MS = 5_000;

/**
 * The owner's messages carried by the prompt of a continued session (OpenCode, Claude Code or
 * Codex): those its hooks or plugin did not take inside the agent's turn (TurnMessages, goal
 * 169). They are read once the agent has started on that prompt (its first step or tool call),
 * and stay waiting if it never does.
 */
export class CarriedMessages {
  private carrying: { ids: number[]; turns: number; calls: number } | undefined;
  private readonly inbox: MessageInbox | undefined;

  constructor(inbox: MessageInbox | undefined) {
    this.inbox = inbox;
  }

  /** The messages waiting now, to put in the next prompt. */
  take(tally: { turns: number; toolCalls: number }): { id: number; text: string }[] {
    const msgs = this.inbox?.waiting() ?? [];
    this.carrying = msgs.length
      ? { ids: msgs.map((m) => m.id), turns: tally.turns, calls: tally.toolCalls }
      : undefined;
    return msgs;
  }

  /** After reading the run's output: the agent started on the prompt, so they are read. */
  check(tally: { turns: number; toolCalls: number }): void {
    const c = this.carrying;
    if (!c || (tally.turns <= c.turns && tally.toolCalls <= c.calls)) return;
    this.carrying = undefined;
    this.inbox?.given(c.ids, "continuation");
  }

  /** The messages the prompt now carries, until they are read: never offered inside a turn. */
  holding(): readonly number[] {
    return this.carrying?.ids ?? [];
  }

  /** The run ended: what it never started on stays waiting (for the next prompt or trial). */
  drop(): void {
    this.carrying = undefined;
  }
}

/**
 * Compares a program's own session log with what its output said, once at a trial's end, where
 * its entry can read one (goal 169): a log line names each count that differs and each kind of
 * record the log's adapter does not know. It changes nothing in the trial, never fails it, and
 * costs only a look when there is no log to read.
 */
export function compareSessionLog<T extends CliTally>(
  p: CliProgram<T>,
  run: CliRun,
  tally: T,
): void {
  if (!p.sessionLog) return;
  try {
    const read = p.sessionLog(run, tally);
    if (!read) return;
    const differ = tallyDifferences(tally, read.tally);
    const fields = { trial: run.id, program: p.id, session: tally.session };
    if (!Object.keys(differ).length && !read.unknown.size) {
      logDebug("harness", `${p.name}'s session log agrees with its output`, fields);
      return;
    }
    log("harness", `${p.name}'s session log and its output differ`, {
      ...fields,
      differ,
      unknown: Object.fromEntries(read.unknown),
    });
  } catch (err) {
    logWarn("harness", `could not compare ${p.name}'s session log with its output`, {
      trial: run.id,
      program: p.id,
      error: errorText(err),
    });
  }
}

/**
 * The unprivileged users planner calls and model checks run as, under OpenCode or Claude Code.
 * Each has a user of its own, apart from every lane's and from each other's: a run ends by
 * killing its user's processes, so a shared user would let one call's cleanup kill the other's.
 */
export const PLANNER_ROLE: Role = "planner";
export const CHECK_ROLE: Role = "model-check";

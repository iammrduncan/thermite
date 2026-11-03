import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { timeLeftWords } from "../../agents/roles/index.ts";

/**
 * A trial's clock (goal 144). Only a trial with a length, which the campaign or the rig sets
 * (none by default), has one. Its agent is told when the trial ends; near the end, each tool
 * result says the time left, as no turn ends while a long build or test runs; a command stops
 * before the end, so the agent can still submit; and the end itself stops a tool still running,
 * so the worker gives its result, its notes included, instead of being killed with none.
 */

/** From this part of the trial's length on, each tool result says the time left. */
export const LEFT_FROM = 0.75;
/** A command stops this long before the trial's end, so that the agent can still submit. */
export const COMMAND_MARGIN_MS = 3 * 60_000;
/** Nearer the end than the margin, a command still gets this long at most (a git diff). */
export const LAST_COMMAND_MS = 60_000;

/** A command's time limit, and whether the trial's end set it rather than the command's own. */
export interface CommandTime {
  timeoutMs?: number;
  cut: boolean;
}

export class TrialClock {
  readonly started: number;
  readonly wallMs: number | undefined;
  private readonly now: () => number;

  constructor(wallMs: number | undefined, now: () => number = Date.now) {
    this.wallMs = wallMs;
    this.now = now;
    this.started = now();
  }

  /** Milliseconds left; undefined for a trial with no length. */
  leftMs(): number | undefined {
    return this.wallMs === undefined ? undefined : this.wallMs - (this.now() - this.started);
  }

  /** About 18 minutes are left in this trial: in the worker's own words (goal 166). */
  leftWords(): string {
    return timeLeftWords(this.leftMs() ?? 0);
  }

  /** From LEFT_FROM of the trial's length on. */
  late(): boolean {
    return this.wallMs !== undefined && this.now() - this.started >= this.wallMs * LEFT_FROM;
  }

  /**
   * A command's time limit: the one asked for (seconds), within the campaign's when it sets one,
   * and on a trial with a length, ending COMMAND_MARGIN_MS before the trial does. Nearer the end
   * than that, LAST_COMMAND_MS at most, and never past the end.
   */
  commandTime(askedS: unknown, limitS?: number): CommandTime {
    const asked = Number(askedS) > 0 ? Math.ceil(Number(askedS)) : undefined;
    const s = asked === undefined ? limitS : limitS === undefined ? asked : Math.min(asked, limitS);
    const own = s === undefined ? undefined : s * 1000;
    const left = this.leftMs();
    if (left === undefined)
      return own === undefined ? { cut: false } : { timeoutMs: own, cut: false };
    const room = Math.max(
      1000,
      Math.floor(Math.max(left - COMMAND_MARGIN_MS, Math.min(LAST_COMMAND_MS, left))),
    );
    return own !== undefined && own <= room
      ? { timeoutMs: own, cut: false }
      : { timeoutMs: room, cut: true };
  }

  /** What a command's result says when the trial's end stopped it. */
  stoppedWords(killed: unknown, time: CommandTime): string {
    return killed === "timeout" && time.cut
      ? `\n(stopped by the trial's clock: a command ends ${COMMAND_MARGIN_MS / 60_000} minutes before the trial does, so that you can submit. ${this.leftWords()})`
      : "";
  }

  /**
   * The agent's tools on this clock. From LEFT_FROM of the trial's length on, each result ends
   * with the time left. When the trial ends (the agent's abort), a tool still running answers at
   * once, so the worker can end and give its result; the harness then stops what the lane still
   * runs. A submission is always waited for: it changes the run's record.
   */
  wrap(tools: AgentTool[], waitFor: readonly string[] = ["submit"]): AgentTool[] {
    return tools.map((t) => ({
      ...t,
      execute: async (id, params, signal, onUpdate) => {
        const running = t.execute(id, params, signal, onUpdate);
        const r =
          waitFor.includes(t.name) || !signal ? await running : await untilAborted(running, signal);
        return this.late() ? withLine(r, this.leftWords()) : r;
      },
    }));
  }
}

/** A tool's result, or, when the trial ends first, an answer that says so. */
function untilAborted(
  running: Promise<AgentToolResult>,
  signal: AbortSignal,
): Promise<AgentToolResult> {
  // A result that comes after the trial's end, or fails then, is not anyone's to read.
  running.catch(() => undefined);
  return Promise.race([
    running,
    new Promise<AgentToolResult>((resolve) => {
      const ended = () =>
        resolve({
          content: [
            { type: "text", text: "The trial ended while this ran: the harness stops it." },
          ],
          details: {},
        });
      if (signal.aborted) ended();
      else signal.addEventListener("abort", ended, { once: true });
    }),
  ]);
}

/** A result with one more line of text at its end. */
function withLine(r: AgentToolResult, line: string): AgentToolResult {
  return { ...r, content: [...r.content, { type: "text", text: line }] };
}

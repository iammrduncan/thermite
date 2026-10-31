import type { RoleRunner } from "../runner.ts";
import { startTerminal, type TerminalEnded } from "../terminal/index.ts";
import type { PiConsole } from "./console.ts";
import { VIEW_FLAG } from "./start.ts";

/** A Pi process's memory limit, with the terminal host that holds it in its Pi view. */
export const PI_PROCESS_RSS = 2 * 1024 * 1024 * 1024;

/**
 * A Pi process in its Pi view (goal 169), a worker's, a planner's or an advisor's: the terminal
 * host runs it through `runner` as `role`, in `dir`, on a terminal of its own, where it draws its
 * view; `view` is its console, given the host to show the screen. Resolves when the process has
 * ended. The host and the process are both Node: neither is the agent's commands, so both are
 * spared at the memory limit, where the runner keeps one, which ends the run as it would headless.
 * Throws when the host can't start.
 */
export async function runInView(
  runner: RoleRunner,
  o: {
    role: string;
    dir: string;
    env: Record<string, string>;
    /** The trial's id, or the call's. */
    id: string;
    argv: string[];
    timeoutMs?: number | undefined;
    nproc?: number | undefined;
  },
  view: PiConsole,
): Promise<TerminalEnded> {
  const term = await startTerminal(runner, {
    role: o.role,
    area: o.dir,
    env: o.env,
    start: { trial: o.id, program: "pi", argv: [...o.argv, VIEW_FLAG], cwd: o.dir },
    timeoutMs: o.timeoutMs,
    rssLimitBytes: PI_PROCESS_RSS,
    spareExe: process.execPath,
    nproc: o.nproc,
  });
  view.attach(term);
  const ended = await term.done;
  view.ended(ended.exit?.screen);
  return ended;
}

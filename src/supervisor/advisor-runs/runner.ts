import type { RoleRunner, RoleRunOutcome, RoleRunRequest } from "../../agents/runner.ts";
import { errorText } from "../../common/errors.ts";
import { log } from "../../common/log.ts";
import { RunAsClient } from "../../common/run-as/index.ts";
import { ADVISOR_RUNS_ENV } from "../../core/advisor-runs.ts";

/**
 * The supervisor's side of the advisors' runner (core/advisor-runs.ts): the runner root started it
 * with, from its settings, or none. Without one (a test, the supervisor started by hand outside its
 * image), the supervisor runs its advisors' programs as its own user, as it says once in its log,
 * and its part of the isolation check says so too.
 */

export interface AdvisorRunner {
  client: RunAsClient;
  /** Where the supervisor makes each run's folder: the runner hands it to the run's user. */
  root: string;
}

let saidNone = false;

export function advisorRunner(
  env: Record<string, string | undefined> = process.env,
): AdvisorRunner | undefined {
  const socket = env[ADVISOR_RUNS_ENV.socket];
  const root = env[ADVISOR_RUNS_ENV.root];
  if (socket && root) return { client: new RunAsClient(socket), root };
  if (!saidNone) {
    saidNone = true;
    log(
      "supervisor",
      "advisor programs run as the supervisor's own user: no advisors' runner was started with it",
      { setting: ADVISOR_RUNS_ENV.socket },
      "warn",
    );
  }
  return undefined;
}

/** How long a run's folder is asked for again while a run that was just stopped still holds it. */
const REMOVE_WAIT_MS = 5_000;

/**
 * The advisors' runner as the runner the agent runtimes share (agents/runner.ts), for a role in its
 * program's own terminal (goal 169). Each run is an advisor user of the helper's choosing, in a
 * folder that is one of the runs' root's children: the helper hands the folder to that user for
 * the run, with the supervisor's group able to enter and read it, and gives it back after. A role
 * here is the caller's name for its call: `killRole` ends that call's runs, whose connections
 * close, and the helper kills every process of their users.
 */
export class AdvisorRoleRunner implements RoleRunner {
  private readonly runner: AdvisorRunner;
  /** The runs at work, by role, each with what stops it. */
  private readonly runs = new Map<string, Set<AbortController>>();

  constructor(runner: AdvisorRunner) {
    this.runner = runner;
  }

  /**
   * One run, through the helper. It always resolves, as the broker's does: a run the helper
   * refused, or one that was stopped, ends with no exit code and why in its errors.
   */
  async run(req: RoleRunRequest): Promise<RoleRunOutcome> {
    const stop = new AbortController();
    const mine = this.runs.get(req.role) ?? new Set<AbortController>();
    mine.add(stop);
    this.runs.set(req.role, mine);
    try {
      const r = await this.runner.client.run(
        {
          dir: req.cwd,
          argv: req.argv,
          env: req.env ?? {},
          stdin: req.stdin ?? "",
          ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        },
        stop.signal,
      );
      return {
        exitCode: r.exitCode,
        signal: r.signal,
        killedFor: r.timedOut ? "timeout" : null,
        stdout: r.stdout,
        stderr: r.stderr,
      };
    } catch (err) {
      return {
        exitCode: null,
        signal: stop.signal.aborted ? "SIGKILL" : null,
        killedFor: null,
        stdout: "",
        stderr: errorText(err),
      };
    } finally {
      mine.delete(stop);
      if (!mine.size) this.runs.delete(req.role);
    }
  }

  /** Nothing to do now: the helper hands the folder to each run's user as the run starts. */
  async handOver(): Promise<void> {}

  /**
   * Removes a run's folder through the helper. A run just stopped may hold it a moment longer, while
   * the helper ends its user's processes: the helper is asked again for up to REMOVE_WAIT_MS.
   */
  async remove(path: string): Promise<void> {
    const until = Date.now() + REMOVE_WAIT_MS;
    for (;;) {
      try {
        await this.runner.client.remove(path);
        return;
      } catch (err) {
        if (!/a run uses /.test(errorText(err)) || Date.now() >= until) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  async killRole(role: string): Promise<number> {
    const mine = [...(this.runs.get(role) ?? [])];
    for (const stop of mine) stop.abort();
    return mine.length;
  }
}

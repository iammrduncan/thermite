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

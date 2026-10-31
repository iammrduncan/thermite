/**
 * Advisor programs as users of their own (core/advisor-runs.ts), the supervisor's side. In the
 * supervisor image, root's entry (main.ts) closes what the advisor users must not reach
 * (folders.ts), serves the runner (src/common/run-as/) and starts the supervisor as its own user;
 * in the one-container rig image the broker does. The supervisor runs each advisor's program
 * through the runner (runner.ts; src/supervisor/advisors/runtimes/cli.ts), and probes what an
 * advisor user reaches for the isolation check (isolation.ts).
 */

export { type FolderIds, prepareSupervisorFolders, type SupervisorFolders } from "./folders.ts";
export {
  ADVISOR_PROBE,
  type AdvisorProbe,
  advisorIsolation,
  advisorProbes,
  probeAdvisorUsers,
} from "./isolation.ts";
export { AdvisorRoleRunner, type AdvisorRunner, advisorRunner } from "./runner.ts";

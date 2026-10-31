/**
 * The rig's agents: the scheduler (scheduler/) that runs the planner (planner/, research/) and the
 * workers' trials (worker/, cli/) in their workspaces, the coordinator's queue, the agent programs
 * they run in, the model route (model/), dev runs, and agent state in the ledger (registry.ts).
 * worker-main.ts, planner-main.ts, trial-cli.ts and lanetool.ts are programs, each run in a
 * process of its own.
 */

export {
  type CliOnceDeps,
  type ConsoleLater,
  type ConsoleNow,
  TrialConsole,
} from "./cli/index.ts";
export { handedOut, lanesAtWork, rulesInForce } from "./coordinator.ts";
export { DevRuns } from "./devrun.ts";
export type { MessageInbox, ReplyNow, TurnDelivery } from "./live-session.ts";
export {
  type ControlRoute,
  type ModelInfo,
  ModelSource,
  plannerRouteFile,
  type RigCheckReport,
  ROUTE_FILE,
} from "./model/index.ts";
export type { PiConsole } from "./pi-view/index.ts";
export { plannerInView } from "./planner/index.ts";
export {
  CLI_PROGRAMS,
  programOf,
  researchProgramOf,
  researchRefusal,
  type TrialLink,
} from "./programs.ts";
export { KIND_WORDS, type ProviderErrorKind } from "./provider-errors.ts";
export { type Evidence, evidenceOf, Registry } from "./registry.ts";
export { SAME_ANSWER } from "./repeats.ts";
export { endWait, holdUntil, Scheduler } from "./scheduler/index.ts";
export { laneCacheDir, laneCacheEnv } from "./workspace.ts";

/**
 * An advisor in Pi (goals 065 and 169): one call's agent with its read-only tools and `answer`
 * (agent.ts, tools.ts), run in the supervisor's own process (headless.ts), or, on a rig whose
 * agents run in their own terminal, in a process of its own in its Pi view (main.ts, with its spec
 * in spec.ts), which the supervisor starts and answers (../terminal/pi.ts). This file is only the
 * folder's interface.
 */

export {
  type AnswerCheck,
  checkAnswer,
  type PiAdvisorEnd,
  piAdvisor,
  toolAnswer,
} from "./agent.ts";
export { callStamp, type PiRuntime, piKey, piModel, runPi } from "./headless.ts";
export { PI_ADVISOR_MAIN, PI_ADVISOR_SPEC_FILE, type PiAdvisorSpec } from "./spec.ts";
export { advisorPiTools, OUTSIDE_KB_SEARCH } from "./tools.ts";

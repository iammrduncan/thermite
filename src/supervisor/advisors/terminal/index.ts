/**
 * The advisors in their programs' own terminals (goal 169), on the one path every role takes there
 * (src/agents/cli/): an advisor's call in its terminal (call.ts), with each program's advisor
 * profile (profiles.ts) and the call's turn routes, which give it the owner's messages inside its
 * turn (turns.ts); the supervisor's own consoles into its advisors' terminals (consoles.ts), made at
 * its start (start.ts); and their relay with the harness, which takes the owner's input to them
 * (relay.ts).
 */

export {
  type AdvisorInTerminal,
  type AdvisorTerminals,
  runInTerminal,
  runsInTerminal,
  type TerminalRuntime,
} from "./call.ts";
export { AdvisorConsoles, LAST_SCREENS_KEPT } from "./consoles.ts";
export {
  type AdvisorProgramId,
  type AdvisorServed,
  advisorProgram,
} from "./profiles.ts";
export { INPUTS_WAIT_S, relayAdvisorTerminals } from "./relay.ts";
export { advisorTerminals } from "./start.ts";
export { type AdvisorTurns, serveAdvisorTurns } from "./turns.ts";

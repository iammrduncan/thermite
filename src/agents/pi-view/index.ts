/**
 * The Pi view (goal 169): a terminal for a role in Pi, which Thermite draws of the role's own Pi
 * session with pi-tui, in the role's own process (view.ts, terminal.ts, text.ts), on a terminal the
 * terminal host holds, as the role's user (run.ts): a worker's, a planner's or an advisor's. The
 * owner watches it on Live and types into it through the console: each input is one call in the
 * role's loop (commands.ts, levers.ts), which its caller's side of the view hands the process over
 * its call's routes (console.ts) and the process makes (inputs.ts, start.ts). This file is only the
 * folder's interface.
 */

export { PI_VIEW_COMMANDS, piViewCall } from "./commands.ts";
export { PI_VIEW_ANSWER_MS, PiConsole } from "./console.ts";
export { mcpWords, ViewInputs, type ViewInputsDeps } from "./inputs.ts";
export {
  type RoleView,
  swappableTools,
  type ViewCounts,
  type ViewLevers,
  type ViewWait,
} from "./levers.ts";
export { PI_PROCESS_RSS, runInView } from "./run.ts";
export { startView, VIEW_FLAG, type ViewRun } from "./start.ts";
export { headOf, VIEW_TEXT_MAX, viewText } from "./text.ts";
export { PiView, VIEW_ENTRIES_MAX } from "./view.ts";

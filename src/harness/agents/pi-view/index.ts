/**
 * The Pi view (goal 169): a terminal for a worker in Pi, which Thermite draws of the worker's own
 * Pi session with pi-tui, in the worker's process (view.ts, terminal.ts, text.ts), on a terminal
 * the terminal host holds, as the lane's agent user. The owner watches it on Live and types into
 * it through the console: each input is one call in the trial's loop (commands.ts), which the
 * harness hands the worker over its trial's routes (console.ts) and the worker makes (inputs.ts,
 * start.ts). This file is only the folder's interface.
 */

export { PI_VIEW_COMMANDS, piViewCall } from "./commands.ts";
export { PI_VIEW_ANSWER_MS, PiConsole } from "./console.ts";
export { mcpWords, ViewInputs, type ViewInputsDeps } from "./inputs.ts";
export { endWords, startView, VIEW_FLAG, VIEW_RESULT, type ViewRun } from "./start.ts";
export { headOf, VIEW_TEXT_MAX, viewText } from "./text.ts";
export { PiView, VIEW_ENTRIES_MAX } from "./view.ts";

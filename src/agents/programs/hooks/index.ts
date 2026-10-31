import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thermite's hooks in a trial's agent program (goal 169): its hook program for Claude Code and
 * Codex (main.ts), which writes each of the program's signals to the trial's signals file and
 * gives the program the owner's messages inside the agent's turn, and the adapter that reads
 * those signals into the session-log adapters' events (signals.ts). Thermite's OpenCode plugin
 * (../opencode/plugin.ts) does the same for OpenCode, whose signals OpenCode's own adapter reads.
 */

export { type HookSignalsState, hookSignals } from "./signals.ts";

/** The variable that names a trial's signals file to its program, its hooks and its plugin. */
export const SIGNALS_VAR = "THERMITE_SIGNALS";

/** Thermite's hook program (main.ts in this folder), as Node runs it. */
export const HOOK_PROGRAM = fileURLToPath(
  new URL(`./main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** Which program a hook runs for, as its first argument says: its signals' `src`. */
export type HookSource = "claude-code" | "codex" | "codex-notify";

/** The hook program's command line for `src`: Node, the program and its source. */
export const hookArgv = (src: HookSource): string[] => [process.execPath, HOOK_PROGRAM, src];

/** A word for a shell, in single quotes. */
const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The hook program's command line for `src` as one shell line, for a program that takes one. */
export const hookShellLine = (src: HookSource): string => hookArgv(src).map(quoted).join(" ");

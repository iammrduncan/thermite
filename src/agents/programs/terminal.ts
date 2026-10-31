import type { Harness } from "../../core/agents.ts";
import type { TerminalKey } from "../../core/terminal-input.ts";

/**
 * An agent program in its own terminal (goal 169), as Thermite's terminal host
 * (src/agents/terminal/) drives it: the keys it may be sent by name, the shape of each program's
 * steps to interrupt the agent's turn and to end the program, the files seeded before it starts
 * and where its session log is. Each program's own are in its folder (`terminal.ts`), and the
 * table of their profiles in index.ts. What each program does with a key is what the spike of
 * 2026-10-29 saw, on Claude Code 2.1.308, Codex 0.162.1 and OpenCode 2.1.4.
 */

/**
 * The programs that run in a terminal: every agent program. Pi's is its worker's own process,
 * which draws Thermite's Pi view of its session (src/agents/pi-view/).
 */
export type TerminalProgram = Harness;

/** Their ids, as the terminal host's start names them. */
export const TERMINAL_PROGRAMS = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
] as const satisfies readonly TerminalProgram[];

// The keys a program may be sent by name are the signed command's (terminal_input).
export { TERMINAL_KEYS, type TerminalKey } from "../../core/terminal-input.ts";

/** One step of an interrupt or an end: keys, text typed and then Enter, or a pause. */
export type TerminalStep = { keys: TerminalKey[] } | { text: string } | { pauseMs: number };

/** How the terminal host interrupts a program's turn and ends the program cleanly. */
export interface TerminalProfile {
  interrupt: readonly TerminalStep[];
  /** After these, the host waits for the program to exit, then sends it SIGTERM. */
  end: readonly TerminalStep[];
}

/**
 * The Pi view has no steps: the owner's interrupt reaches the worker over its trial's routes, never
 * as a key, and its worker exits at the trial's end, so the host only ever ends it by SIGTERM.
 */
export const PI_VIEW_TERMINAL: TerminalProfile = { interrupt: [], end: [] };

/** A file written before the program starts, by the host, as the lane's user. */
export interface TerminalSeed {
  path: string;
  content: string;
  mode: number;
}

/**
 * Where a program writes its session log, for the host to mirror: a folder, how many folders below
 * it the log may be, and a pattern its file's name matches (a regular expression's source).
 */
export interface TerminalLog {
  dir: string;
  depth: number;
  name: string;
}

/** A regular expression's source that matches `s` exactly. */
export const literally = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

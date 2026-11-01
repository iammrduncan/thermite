/**
 * Thermite's log levels, and the parts of a rig whose level a signed command changes (goal 125,
 * the guide's question 16): words the wire carries, in control's own setting and in the
 * `log_level` command. common/log.ts writes the lines at them.
 */

/** The levels, lowest first: a part writes the lines at its level and above. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The parts of a rig a `log_level` command changes, each on its own. */
export const LOG_PARTS = ["harness", "supervisor"] as const;

/** How long a rig part keeps a level a `log_level` command gave it, in words. */
export const RIG_LOG_LEVEL_LASTS =
  "until another log_level command changes it, or the part restarts: then it writes at its THERMITE_LOG_LEVEL again";

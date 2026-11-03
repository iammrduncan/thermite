/**
 * Thermite's log (goal 125, T4; CONVENTIONS.md, "Logging"): one JSON object per line on standard
 * output, `{at, level, component, msg, ...fields}`. A line names what it is about in its fields
 * (`run`, `trial`, `attempt`, `command`, `rig`), so it can be tied to its cause.
 *
 * Levels, lowest first: debug, info, warn, error (core/log-levels.ts). A part writes the lines at
 * its level and above: THERMITE_LOG_LEVEL, info unless set, read at its start (a bad value stops
 * it there). While it runs, its level changes in memory (setLogLevel): a rig's harness and
 * supervisor by the signed `log_level` command, control by its own setting. SIGUSR2 switches a
 * running part between its level and debug. Each change is said in a line.
 */

import { LOG_LEVELS, type LogLevel } from "../core/log-levels.ts";
import { withoutCredentials } from "./scrub.ts";

/** THERMITE_LOG_LEVEL's level, as the part read it at its start. */
let started: LogLevel = "info";
/** The part's level: started's, or the one a command or control's setting gave it since. */
let own: LogLevel = "info";
/** The level now: the part's, or debug while SIGUSR2's switch is on. */
let level: LogLevel = "info";

/** A line that says the level changed, whatever the level: who reads the log must see it. */
function sayLevel(component: string, fields: Record<string, unknown> = {}): void {
  const line = {
    at: new Date().toISOString(),
    level: "info",
    component,
    msg: `log level now ${level}`,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(line, withoutSecretsIn)}\n`);
}

/** Writes a line at `at`, when the part's level lets it through. */
export function log(
  component: string,
  msg: string,
  fields: Record<string, unknown> = {},
  at: LogLevel = "info",
): void {
  if (LOG_LEVELS.indexOf(at) < LOG_LEVELS.indexOf(level)) return;
  const line = { at: new Date().toISOString(), level: at, component, msg, ...fields };
  process.stdout.write(`${JSON.stringify(line, withoutSecretsIn)}\n`);
}

/** Every string in a line, at any depth, as `redact` leaves it (without its length limit). */
const withoutSecretsIn = (_key: string, value: unknown) =>
  typeof value === "string" ? withoutCredentials(value) : value;

/**
 * A message with what could be a credential taken out, for logs and for words that leave a part:
 * every shape the scrubber knows of a key, a token or a password (scrub.ts, withoutCredentials).
 * At most 2,000 characters. This guards against an echoed URL, header or key, not against
 * anything a message could hold. `log` applies it to every string of every line.
 */
export function redact(text: string): string {
  return withoutCredentials(text).slice(0, 2000);
}

/** Something went wrong, and the part goes on: a call refused, a retry, a fallback taken. */
export const logWarn = (component: string, msg: string, fields: Record<string, unknown> = {}) =>
  log(component, msg, fields, "warn");

/** Something failed: work not done, a step that stops, a part that exits. */
export const logError = (component: string, msg: string, fields: Record<string, unknown> = {}) =>
  log(component, msg, fields, "error");

/** Detail for finding a fault, written only at debug. */
export const logDebug = (component: string, msg: string, fields: Record<string, unknown> = {}) =>
  log(component, msg, fields, "debug");

/** The part's level from THERMITE_LOG_LEVEL; throws, in words, on a value that is not a level. */
export function logLevelOf(env: Record<string, string | undefined>): LogLevel {
  const raw = env.THERMITE_LOG_LEVEL?.trim();
  if (!raw) return "info";
  const found = LOG_LEVELS.find((l) => l === raw);
  if (!found) throw new Error(`THERMITE_LOG_LEVEL takes ${LOG_LEVELS.join(", ")}, not "${raw}"`);
  return found;
}

/**
 * Sets the part's level at its start, from its environment, and lets SIGUSR2 switch it between
 * that level and debug while it runs. `component` names the part in the line that says so; the
 * signal goes on to the processes `parts` gives (the broker's controller and supervisor).
 */
export function startLogging(
  component: string,
  env: Record<string, string | undefined>,
  parts?: () => readonly ({ kill(signal: "SIGUSR2"): unknown } | undefined)[],
): void {
  started = logLevelOf(env);
  own = started;
  level = started;
  process.on("SIGUSR2", () => {
    for (const part of parts?.() ?? []) part?.kill("SIGUSR2");
    switchLogLevel(component);
  });
}

/** What SIGUSR2 does: debug, or back to the part's level, said in a line. */
export function switchLogLevel(component: string): void {
  level = level === "debug" ? own : "debug";
  sayLevel(component, { by: "SIGUSR2" });
}

/**
 * The part's level from now on, in memory: `to`, or THERMITE_LOG_LEVEL's for null, until it is
 * changed again or the part restarts. Said in a line, with `fields` (who changed it, and how). The
 * level before and the level now.
 */
export function setLogLevel(
  component: string,
  to: LogLevel | null,
  fields: Record<string, unknown> = {},
): { was: LogLevel; now: LogLevel } {
  const was = level;
  own = to ?? started;
  level = own;
  sayLevel(component, { was, ...fields });
  return { was, now: level };
}

/** The part's level now. */
export const logLevel = (): LogLevel => level;

/** THERMITE_LOG_LEVEL's level, as the part read it at its start: where null sets it back to. */
export const startedLogLevel = (): LogLevel => started;

/**
 * Thermite's log (goal 125, T4; CONVENTIONS.md, "Logging"): one JSON object per line on standard
 * output, `{at, level, component, msg, ...fields}`. A line names what it is about in its fields
 * (`run`, `trial`, `attempt`, `command`, `rig`), so it can be tied to its cause.
 *
 * Levels, lowest first: debug, info, warn, error. A part writes the lines at its level and above:
 * THERMITE_LOG_LEVEL, info unless set, read at its start (a bad value stops it there). SIGUSR2
 * switches a running part between its level and debug, and says so in a line.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

let level: LogLevel = "info";

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
  typeof value === "string" ? withoutSecrets(value) : value;

/**
 * A message with what could be a credential taken out, for logs and for words that leave a part:
 * a URL's user and password, a bearer token, keys with a known prefix, a NATS key's seed, a
 * query string's or a form's token, key, secret, password, signature or code (`token=…`,
 * `access_token=…`, `api_key=…`), a credential header (`x-api-key: …`, `authorization: …`), and the
 * value given to a Thermite or RunPod variable whose name ends in KEY, CODE, TOKEN, SECRET or PREFIX
 * (`NAME=value`, or `"NAME":"value"` in JSON), such as a pod's snapshot key or enrollment code
 * echoed back. At most 2,000 characters. This guards against an echoed URL, header or key, not
 * against anything a message could hold. `log` applies it to every string of every line.
 */
export function redact(text: string): string {
  return withoutSecrets(text).slice(0, 2000);
}

function withoutSecrets(text: string): string {
  return text
    .replace(/(\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\b(Bearer\s+)\S+/gi, "$1***")
    .replace(
      /\b(sk-|rpa_|ghp_|gho_|ghs_|github_pat_|glpat-|hf_|xox[abp]-)[A-Za-z0-9_-]{6,}/g,
      "$1***",
    )
    .replace(/\bS[UACNOPX][A-Z2-7]{56}\b/g, "S***")
    .replace(
      /\b((?:THERMITE|RUNPOD)_[A-Z0-9_]*(?:KEY|CODE|TOKEN|SECRET|PREFIX)(?:=\\?["']?|\\?["']\s*:\s*\\?["']))[^\s"'\\,;}&]+/g,
      "$1***",
    )
    .replace(
      /\b([a-z0-9_-]*(?:token|api[_-]?key|apikey|secret|password|passwd|signature)=)[^\s&"'#,;}]+/gi,
      "$1***",
    )
    .replace(/([?&](?:code|sig|key)=)[^\s&"'#,;}]+/gi, "$1***")
    .replace(
      /\b((?:x-)?api-key|x-[a-z-]*token|private-token|(?:proxy-)?authorization)(["']?\s*:\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s,;"'}]+/gi,
      "$1$2***",
    );
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
  configured = logLevelOf(env);
  level = configured;
  process.on("SIGUSR2", () => {
    for (const part of parts?.() ?? []) part?.kill("SIGUSR2");
    switchLogLevel(component);
  });
}

let configured: LogLevel = "info";

/** What SIGUSR2 does: debug, or back to the part's level, said in a line. */
export function switchLogLevel(component: string): void {
  level = level === "debug" ? configured : "debug";
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), level: "info", component, msg: `log level now ${level}` })}\n`,
  );
}

/** The part's level now (tests). */
export const logLevel = (): LogLevel => level;

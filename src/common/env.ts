import { existsSync, readFileSync } from "node:fs";
import { log, redact } from "./log.ts";

/** Settings renamed on 2026-10-15 (unit -> rig): the old names still work, for a transition. */
const RENAMED: Record<string, string> = {
  THERMITE_RIG_ID: "THERMITE_UNIT_ID",
  THERMITE_CONTROL_RIG_TOKENS_FILE: "THERMITE_CONTROL_UNIT_TOKENS_FILE",
};

/** Reads a required environment variable. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const old = RENAMED[name];
  const v = env[name] || (old ? env[old] : undefined);
  if (!v) throw new Error(`missing environment variable ${name}`);
  if (!env[name] && old) log("env", `${old} is deprecated; set ${name}`);
  return v;
}

/** Reads a secret from the file named by an environment variable, trimmed. */
export function secretFromFile(varName: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = requireEnv(varName, env);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`secret file for ${varName} is empty`);
  return value;
}

export function optionalSecretFromFile(
  varName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = env[varName];
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

/** Parses "host:port" (host may be empty for all interfaces). */
export function parseListen(value: string): { host: string; port: number } {
  const i = value.lastIndexOf(":");
  const host = i > 0 ? value.slice(0, i) : "0.0.0.0";
  const port = Number(value.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`bad listen address ${value}`);
  return { host, port };
}

/** Waits for a file to appear (for keys written by another container at first start). */
export async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.trim()) return text;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// The log and its redaction are common/log.ts; most parts still import them from here.
export { log, redact };

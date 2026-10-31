import type { CallUsage } from "../../core/usage.ts";
import type { RoleRunner } from "../runner.ts";
import type { CliSetup } from "./program.ts";

/**
 * Sets a program up in its run's area (or its call's folder), as the run's user: relative to that
 * folder, since the user may not walk its caller's directories by name. Undefined when it is set
 * up; else why not.
 */
export async function setUp(
  name: string,
  s: CliSetup,
  runner: RoleRunner,
  at: { role: string; cwd: string },
): Promise<string | undefined> {
  const r = await runner.run({
    role: at.role,
    argv: ["sh", "-c", s.script, ...(s.args ?? [])],
    cwd: at.cwd,
    timeoutMs: 30_000,
    ...(s.stdin !== undefined ? { stdin: s.stdin } : {}),
    captureBytes: 4096,
  });
  return r.exitCode === 0 ? undefined : `could not set ${name} up: ${r.stderr.slice(-300)}`;
}

/** Hands the usage the tally gathered to `usage`, once each (goal 075). */
export function takeUsage(
  t: { calls: CallUsage[] },
  usage: ((u: CallUsage) => void) | undefined,
): void {
  for (const u of t.calls.splice(0)) usage?.(u);
}

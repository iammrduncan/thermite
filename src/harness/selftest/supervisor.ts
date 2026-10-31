import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../../common/fs.ts";
import { SupervisorIsolation } from "../../core/api/harness/supervisor.ts";

/**
 * The supervisor's part of the isolation check: what its advisor users reached, as the
 * supervisor last said (core/api/harness/supervisor.ts: SUPERVISOR_ISOLATION). The harness keeps
 * the newest in its state folder, so a restart of either part keeps it, and the isolation check
 * reads it from there.
 */

/** Where the harness keeps it, in its state folder (the controller's own). */
export const SUPERVISOR_ISOLATION_FILE = "supervisor-isolation.json";

export function keepSupervisorIsolation(stateDir: string, r: SupervisorIsolation): void {
  writeAtomic(join(stateDir, SUPERVISOR_ISOLATION_FILE), `${JSON.stringify(r)}\n`, 0o600);
}

/** The newest the supervisor said, or undefined: none yet, or a file the schema refuses. */
export function readSupervisorIsolation(stateDir: string): SupervisorIsolation | undefined {
  let text: string;
  try {
    text = readFileSync(join(stateDir, SUPERVISOR_ISOLATION_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = SupervisorIsolation.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

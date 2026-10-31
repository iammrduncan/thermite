import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listProcesses, type Proc, type Role, roleIds } from "../broker/index.ts";

/**
 * Whether the rig is too busy for the isolation selftest. Each probe ends by killing every process
 * of its role's user, as every run does, so it would kill a live trial, judge job or agent call.
 */

/**
 * Why the rig is too busy for the selftest, if it is. Each probe ends by killing every process
 * of its role's user (as every run does), so probing while a worker, a dev run or a timed run is
 * live would kill it.
 */
export function busyReason(stateDir: string): string | undefined {
  const path = join(stateDir, "ledger", "ledger.db");
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    const trials = n("select count(*) as n from trial where ended_at is null");
    const jobs = n("select count(*) as n from job where state in ('queued', 'leased')");
    if (trials || jobs) {
      return `${trials} open trial(s) and ${jobs} judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes)`;
    }
    return undefined;
  } finally {
    db.close();
  }
}

/** The users of agent calls outside trials, which the ledger does not show as open. */
const CALL_ROLES: { role: Role; what: string }[] = [
  { role: "planner", what: "a planner call" },
  { role: "model-check", what: "a model check" },
];

/**
 * Why probing now would kill a planner call or a model check, if it would: a process of its user
 * is running. Each probe kills its role's processes, as every run does.
 */
export function callsBusy(procs: Pick<Proc, "uid">[]): string | undefined {
  const live = CALL_ROLES.filter(({ role }) => procs.some((p) => p.uid === roleIds(role).uid));
  if (!live.length) return undefined;
  return `${live.map((c) => c.what).join(" and ")} ${live.length > 1 ? "are" : "is"} running: wait for ${live.length > 1 ? "them" : "it"} to end (each probe kills its role's processes)`;
}

/** Why the isolation selftest should not probe now: open trials or judge jobs, or a live call. */
export function isolationBusy(
  stateDir: string,
  procs: () => Pick<Proc, "uid">[] = listProcesses,
): string | undefined {
  return busyReason(stateDir) ?? callsBusy(procs());
}

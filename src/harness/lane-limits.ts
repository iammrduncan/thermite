import type { LaneLimitValues, RunLaneLimits } from "../core/contract.ts";
import type { Ledger } from "./ledger/index.ts";

/**
 * A running run's lane limits changed in place by the owner (goal 221): the newest
 * `lane_limits_set` event holds those in force over the contract's, and each lane command and
 * development run from then on takes them.
 */

/** The owner's limits in force on a run, by the contract's names; none: the contract's own. */
export function ownersLimits(ledger: Ledger, run: string): Record<string, number> {
  return ledger.events.newest("lane_limits_set", { subject: run })?.body.limits ?? {};
}

/** The owner's limits merged with a change: a value sets one, null goes back to the contract's. */
export function mergedLimits(
  now: Record<string, number>,
  change: RunLaneLimits,
): Record<string, number> {
  const out = { ...now };
  for (const [k, v] of Object.entries(change)) {
    if (v === null) delete out[k];
    else if (typeof v === "number") out[k] = v;
  }
  return out;
}

/** A run's lane limits: the contract's, with the owner's changes over them. */
export function withOwnersLimits(
  limits: LaneLimitValues,
  ledger: Ledger,
  run: string,
): LaneLimitValues {
  const o = ownersLimits(ledger, run);
  return {
    ...limits,
    ...(o.run_timeout_s !== undefined ? { runTimeoutS: o.run_timeout_s } : {}),
    ...(o.run_rss_mib !== undefined ? { runRssMib: o.run_rss_mib } : {}),
    ...(o.workspace_mib !== undefined ? { workspaceMib: o.workspace_mib } : {}),
    ...(o.dev_run_timeout_s !== undefined ? { devRunTimeoutS: o.dev_run_timeout_s } : {}),
    ...(o.dev_run_rss_mib !== undefined
      ? { devRunRssMib: o.dev_run_rss_mib, devRunRssSet: true }
      : {}),
    ...(o.processes !== undefined ? { processes: o.processes } : {}),
  };
}

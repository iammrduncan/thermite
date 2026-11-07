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

/**
 * What a change of a running run's lane limits would set and reach (goal 221), with nothing
 * changed: the limits in force after it, and the lanes at work now, whose next lane command and
 * development run take them.
 */
export function limitsPreview(ledger: Ledger, run: string, limits: Record<string, number>) {
  const atWork = ledger.trials
    .open()
    .filter((t) => t.run === run)
    .map((t) => `${t.lane} (${t.id})`);
  const set = Object.entries(limits).map(([k, v]) => `${k} ${v}`);
  return {
    run,
    preview: true,
    limits,
    words: `${set.length ? `The owner's limits would be ${set.join(", ")}` : "The contract's limits would apply again"}, from the next lane command and development run. ${atWork.length ? `Lanes at work now: ${atWork.join(", ")}; their next commands take them.` : "No lane is at work now."} Nothing changed.`,
  };
}

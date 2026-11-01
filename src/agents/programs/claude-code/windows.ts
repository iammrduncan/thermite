/**
 * A Claude subscription's usage windows, from Claude Code's `rate_limit_event` (goal 151). Each
 * event names one window (`rateLimitType`, `utilization` from 0 to 1, `resetsAt` in seconds), as
 * the Claude Agent SDK types it; older events gave several at once (`unifiedWindows`). A window
 * an event leaves out keeps the value an earlier one gave.
 */

/**
 * Whether the account's usage credits are on, from Claude Code's `overageStatus` (in its
 * `rate_limit_event`, and in its transcript's record of a usage limit): `allowed` or
 * `allowed_warning`, on; `rejected`, off; anything else says nothing. With credits on, a full
 * window can spend paid usage instead of waiting (goal 169: Thermite marks the subscription).
 */
export function creditsOn(overageStatus: string | null | undefined): boolean | undefined {
  if (overageStatus === "allowed" || overageStatus === "allowed_warning") return true;
  if (overageStatus === "rejected") return false;
  return undefined;
}

/**
 * The account's usage credits as a rig last saw them: on or off, and since when they were so on
 * the rig (when they changed from the other), or null when they were so from the first report.
 */
export interface Credits {
  on: boolean;
  since: string | null;
}

/** A subscription's usage window, as Claude Code reports it. */
export interface UsageWindow {
  /** 0 to 1. */
  utilization: number;
  /** When it resets (ISO). */
  resets_at: string;
}

export interface PlanWindows {
  five_hour?: UsageWindow | undefined;
  seven_day?: UsageWindow | undefined;
  /** Its usage credits, when Claude Code said. */
  credits?: Credits | undefined;
}

/** A `rate_limit_event`'s `rate_limit_info`. */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

const WINDOWS = ["five_hour", "seven_day"] as const;

/** The windows an event gives, over those kept before. */
export function windowsOf(info: RateLimitInfo, was: PlanWindows | undefined): PlanWindows {
  const given: Record<string, { utilization?: number; resetsAt?: number }> = {
    ...info.unifiedWindows,
    ...(info.rateLimitType && typeof info.utilization === "number"
      ? { [info.rateLimitType]: info }
      : {}),
  };
  const out: PlanWindows = { ...was };
  for (const k of WINDOWS) {
    const w = given[k];
    if (typeof w?.utilization === "number" && typeof w.resetsAt === "number")
      out[k] = { utilization: w.utilization, resets_at: new Date(w.resetsAt * 1000).toISOString() };
  }
  const on = creditsOn(info.overageStatus);
  if (on !== undefined) out.credits = { on, since: null };
  return out;
}

/**
 * The credits just reported over those the rig kept: the same state keeps its `since`; a change
 * starts it now; the first report has none.
 */
function mergeCredits(
  was: Credits | undefined,
  now: Credits | undefined,
  at: string,
): Credits | undefined {
  if (!now) return was;
  if (!was) return { on: now.on, since: null };
  return was.on === now.on ? was : { on: now.on, since: at };
}

/** The windows just reported over those the rig kept, with when (for the rig's report). */
export function mergeUsage(
  was: PlanWindows | undefined,
  now: PlanWindows,
): PlanWindows & { at: string } {
  const at = new Date().toISOString();
  const credits = mergeCredits(was?.credits, now.credits, at);
  return {
    five_hour: now.five_hour ?? was?.five_hour,
    seven_day: now.seven_day ?? was?.seven_day,
    ...(credits ? { credits } : {}),
    at,
  };
}

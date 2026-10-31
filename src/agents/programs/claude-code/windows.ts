/**
 * A Claude subscription's usage windows, from Claude Code's `rate_limit_event` (goal 151). Each
 * event names one window (`rateLimitType`, `utilization` from 0 to 1, `resetsAt` in seconds), as
 * the Claude Agent SDK types it; older events gave several at once (`unifiedWindows`). A window
 * an event leaves out keeps the value an earlier one gave.
 */

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
}

/** A `rate_limit_event`'s `rate_limit_info`. */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
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
  return out;
}

/** The windows just reported over those the rig kept, with when (for the rig's report). */
export function mergeUsage(
  was: PlanWindows | undefined,
  now: PlanWindows,
): PlanWindows & { at: string } {
  return {
    five_hour: now.five_hour ?? was?.five_hour,
    seven_day: now.seven_day ?? was?.seven_day,
    at: new Date().toISOString(),
  };
}

import { errorText } from "../../../common/errors.ts";
import type { PLAN_CAUSES } from "../../../core/api/harness/planner.ts";

/**
 * Why a try gave no usable plan (goal 079): it ran out of time (only with a time limit someone
 * set), it answered in text without calling submit_plan, its reply was cut off at the output
 * limit, the provider failed (with its kind), it was cancelled (its run paused), or code refused
 * the plan (with which rules).
 */
export type PlanCause = (typeof PLAN_CAUSES)[number];

export interface PlanTry {
  try: number;
  cause: PlanCause;
  /** In words: the provider's, or each rule the plan broke. */
  detail: string;
}

/** A planner call that gave no plan, and why (goal 079). */
export class PlannerCallError extends Error {
  readonly planCause: PlanCause;
  constructor(cause: PlanCause, message: string) {
    super(message);
    this.planCause = cause;
  }
}

/** Each cause in words, for the epoch's record and History. */
export const causeWords: Record<PlanCause, string> = {
  timeout: "it ran out of time",
  text_only: "it answered in text without a plan",
  cut_off: "its reply was cut off at the output limit",
  provider_error: "the provider failed",
  cancelled: "it was cancelled",
  invalid: "the plan was refused",
};

/** The cause of a failed call another harness threw (OpenCode, Claude Code, Codex): its words. */
export function causeOf(err: unknown): PlannerCallError {
  const message = errorText(err);
  if (/no answer in \d+ s|timed? ?out/i.test(message))
    return new PlannerCallError("timeout", message);
  if (/aborted|cancel/i.test(message)) return new PlannerCallError("cancelled", message);
  if (/gave no answer/i.test(message)) return new PlannerCallError("text_only", message);
  return new PlannerCallError("provider_error", message);
}

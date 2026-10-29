/**
 * The judge's verdicts and an attempt's lifecycle (goal 125, T1): the words the ledger records,
 * and the groups control, the harness and the dashboard read them by, each in one place.
 */

/**
 * Every verdict the ledger records. `neutral_simplify` is gone (goal 174): nothing ever recorded
 * it, and the judge has no measure of simpler code to give it; a ledger never held one.
 */
export const VERDICTS = [
  "win_screened",
  "win_confirmed",
  "not_confirmed",
  "regress",
  "neutral",
  "tradeoff",
  "infeasible",
  "no_progress",
  "inconclusive",
  "invalid",
  "rejected_v0",
  "crash_candidate",
  "crash_infra",
  "invalidated",
  "goal_screened",
  "goal_progress",
  "starting_point",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Verdicts that may move a champion. Goal mode's: meets more goals than the champion, loses none. */
export const PROMOTABLE_VERDICTS: readonly string[] = ["win_confirmed", "goal_progress"];

/** A change that won: confirmed on fresh runs, in either mode. */
export const WON_VERDICTS: readonly string[] = ["win_confirmed", "goal_progress"];

/** A change that looked like a win in screening, and waits for its confirmation. */
export const SCREENED_VERDICTS: readonly string[] = ["win_screened", "goal_screened"];

/** A broken change: it did not build or run, or broke a rule of the contract. */
export const BROKEN_VERDICTS: readonly string[] = ["invalid", "rejected_v0", "crash_candidate"];

/** No answer about the change itself: the rig failed, the noise was too high, or its evidence went. */
export const UNCLEAR_VERDICTS: readonly string[] = ["crash_infra", "inconclusive", "invalidated"];

/** An attempt's lifecycles in which its outcome is known for good. */
export const FINAL_LIFECYCLES: ReadonlySet<string> = new Set([
  "promoted",
  "judged",
  "rejected_v0",
  "duplicate",
  "errored",
  "audit_blocked",
  "not_judged",
]);

/** An attempt's lifecycles in which the judge is done with it, for now or for good. */
export const JUDGED_LIFECYCLES: ReadonlySet<string> = new Set([
  ...FINAL_LIFECYCLES,
  "awaiting_approval",
  "awaiting_audit",
]);

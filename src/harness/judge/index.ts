/**
 * The judge: the only code that measures, decides verdicts and moves champions (judge.ts, with
 * its jobs in jobs/), and what the rest of the harness reads of its rules: a run's baseline
 * (baseline.ts), held-out results named safely (held-out.ts), failure reasons (reasons.ts), job
 * leases (lease.ts), one timed run (measure.ts), changes carried to a new champion (ports.ts),
 * a stored build removed by a retention policy (builds.ts), and the runner the judge builds and
 * measures on (runner.ts; the core's own: core-runner.ts, goal 206).
 * The Judge itself stays in judge.ts; this file is only the folder's interface.
 */

export {
  BASELINE_PRIORITY,
  type BaselineState,
  baselineState,
  SETUP_DIRECTION,
  startingPoint,
} from "./baseline.ts";
export { BUILD_KEY, removeBuild } from "./builds.ts";
export { CoreRunner } from "./core-runner.ts";
export { type HeldOutKind, heldOutCellsOf, heldOutKinds, heldOutWords } from "./held-out.ts";
export { Judge, type PromotionPolicy } from "./judge.ts";
export { jobsAtStart } from "./lease.ts";
export { copyForRun } from "./measure.ts";
export { portReplaced } from "./ports.ts";
export { clipReason, REASONS_CHARS } from "./reasons.ts";
export type { Measured, MeasureSpec, RigRunner, Sealed } from "./runner.ts";

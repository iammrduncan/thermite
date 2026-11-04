/**
 * The judge: the only code that measures, decides verdicts and moves champions (judge.ts, with
 * its jobs in jobs/), and what the rest of the harness reads of its rules: a run's baseline
 * (baseline.ts), held-out results named safely (held-out.ts), failure reasons (reasons.ts), job
 * leases (lease.ts), one timed run (measure.ts), changes carried to a new champion (ports.ts),
 * a stored build removed by a retention policy (builds.ts), and what a follower's GPU does for the
 * leader's judge (device.ts, kits.ts and the baseline's folder, goal 205).
 * The Judge itself stays in judge.ts; this file is only the folder's interface.
 */

export {
  BASELINE_PRIORITY,
  type BaselineState,
  baselineDir,
  baselineState,
  keepBaselineDir,
  prepareBaselineDir,
  removeBaselineDir,
  SETUP_DIRECTION,
  startingPoint,
} from "./baseline.ts";
export { BUILD_KEY, removeBuild } from "./builds.ts";
export { LocalDevice } from "./device.ts";
export { type HeldOutKind, heldOutCellsOf, heldOutKinds, heldOutWords } from "./held-out.ts";
export { Judge, type PromotionPolicy } from "./judge.ts";
export { exportKit, loadKit } from "./kits.ts";
export { jobsAtStart } from "./lease.ts";
export { FollowerLink } from "./link.ts";
export { type Arm, copyForRun } from "./measure.ts";
export { portReplaced } from "./ports.ts";
export { clipReason, REASONS_CHARS } from "./reasons.ts";
export { RemoteDevice } from "./remote.ts";

/**
 * The judge: the only code that measures, decides verdicts and moves champions (judge.ts, with
 * its jobs in jobs/), and what the rest of the harness reads of its rules: a run's baseline
 * (baseline.ts), held-out results named safely (held-out.ts), failure reasons (reasons.ts), job
 * leases (lease.ts), one timed run (measure.ts) and changes carried to a new champion (ports.ts).
 * The Judge itself stays in judge.ts; this file is only the folder's interface.
 */

export {
  BASELINE_PRIORITY,
  type BaselineState,
  baselineState,
  SETUP_FAMILY,
  startingPoint,
} from "./baseline.ts";
export { type HeldOutKind, heldOutCellsOf, heldOutKinds, heldOutWords } from "./held-out.ts";
export { Judge, type PromotionPolicy } from "./judge.ts";
export { jobsAtStart } from "./lease.ts";
export { copyForRun } from "./measure.ts";
export { portReplaced } from "./ports.ts";
export { clipReason, REASONS_CHARS } from "./reasons.ts";

/**
 * The judge's jobs, each run on the judge's context (../context.ts): the baseline, the A/A
 * calibration, evaluate, confirm and validate.
 */

export { baseline } from "./baseline.ts";
export { calibrate } from "./calibrate.ts";
export { confirm } from "./confirm.ts";
export { evaluate } from "./evaluate.ts";
export { validate } from "./validate.ts";

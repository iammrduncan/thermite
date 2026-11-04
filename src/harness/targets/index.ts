/**
 * Target drivers, which connect the judge to what a campaign measures on (driver.ts): a CPU set
 * (cpu.ts) or a CUDA GPU (cuda.ts); and the CPU throttling of the harness's own cgroup
 * (cgroup.ts).
 */

export { readThrottle, throttledFraction } from "./cgroup.ts";
export { CpuDriver } from "./cpu.ts";
export { CudaDriver, smiAs, smiAsRun } from "./cuda.ts";
export type { TargetDriver } from "./driver.ts";

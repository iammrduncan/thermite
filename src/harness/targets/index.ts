/**
 * Target drivers, which connect the judge to what a campaign measures on (driver.ts): a CPU set
 * (cpu.ts), a CUDA GPU (cuda.ts) or a GPU reached through Vulkan (vulkan.ts); and the CPU
 * throttling of the harness's own cgroup (cgroup.ts).
 */

/** The target types that measure on a GPU: their runs are given the GPU's device. */
const GPU_TARGETS: readonly string[] = ["cuda-gpu", "vulkan-gpu"];
/** Whether a target of this type measures on a GPU. */
export const onGpu = (type: string | undefined): boolean => GPU_TARGETS.includes(type ?? "");

export { readThrottle, type ThrottleSample, throttledFraction } from "./cgroup.ts";
export { CpuDriver } from "./cpu.ts";
export { CudaDriver, smiAs, smiAsRun } from "./cuda.ts";
export type { Readiness, TargetDriver, TargetIdentity, TargetUse } from "./driver.ts";
export { VulkanDriver, vulkanInfoAs } from "./vulkan.ts";

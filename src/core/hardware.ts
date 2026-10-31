/**
 * What a rig runs on, as its harness reports it (inside the signed report's summary) and the
 * dashboard shows it. Collected once when the harness starts: the device, its driver, the
 * container's CPU and memory, and the disks it works on.
 */
export interface Hardware {
  collected_at: string;
  /** The judge's target, as its driver identifies it (the comparability key is `id`). */
  target: { type: string; class: string; id: string };
  /**
   * "shared": one device for the judge and agents' dev runs; "dedicated": cards of their own for
   * the judge and for dev runs (one or more of each; devices lists them with their roles).
   */
  device_mode: "shared" | "dedicated" | "none";
  devices: HardwareDevice[];
  cpu: {
    model: string;
    /** CPUs the host has, the harness may run on (affinity), and the container's quota. */
    host: number;
    usable: number;
    quota: number | null;
  };
  memory: { host_mib: number; limit_mib: number | null };
  disks: { name: "state" | "scratch"; total_gib: number; free_gib: number }[];
  os: { kernel: string; arch: string; node: string; image: string | null };
  toolchain: { cc: string | null; nvcc: string | null };
  /** What could not be read. */
  errors: string[];
}

export interface HardwareDevice {
  /** Who uses it: the judge, agents' dev runs, or both. */
  role: "judge" | "dev" | "shared";
  name: string;
  uuid: string;
  bus: string;
  memory_mib: number | null;
  driver: string | null;
  cuda: string | null;
  power_limit_w: number | null;
  max_sm_mhz: number | null;
  max_mem_mhz: number | null;
  /** PCIe generation and width, as "gen3 x16". */
  pcie: string | null;
  vbios: string | null;
}

/** Reads a reported hardware object loosely: anything malformed is dropped, never trusted. */
export function readHardware(x: unknown): Hardware | null {
  if (!x || typeof x !== "object") return null;
  const h = x as Partial<Hardware>;
  if (typeof h.collected_at !== "string" || !Array.isArray(h.devices) || !h.cpu || !h.memory) {
    return null;
  }
  return h as Hardware;
}

/**
 * The judge's GPUs on a rig of `n` when no split is given: half, rounded up (the one GPU of a
 * rig with one). Control's pages and the broker split the same way; a page's script takes this
 * function's source.
 */
export const judgeGpusByDefault = (n: number): number => Math.ceil(n / 2);

/** At most 8 judge GPUs and 8 for the agents (the harness image has users for that many). */
export const MAX_RIG_GPUS = 16;

/**
 * The harness's GPU settings for a rig with `n` GPUs, as the container numbers them (0 to n-1,
 * in the order given): none, one shared, or the GPU set with the judge's share to start with (the
 * first `judge` for the judge, the rest for the agents' dev runs; default half, rounded up). A
 * campaign deployed on the rig, or Edit rig, may change the share later (the rig's settings).
 */
export function gpuSplit(
  n: number,
  judge?: number | undefined,
): { THERMITE_GPU_INDEX?: string; THERMITE_GPUS?: string; THERMITE_JUDGE_GPUS?: string } {
  if (n > MAX_RIG_GPUS) throw new Error(`a rig takes at most ${MAX_RIG_GPUS} GPUs`);
  if (n === 0) return {};
  if (n === 1) return { THERMITE_GPU_INDEX: "0" };
  const j = judge ?? judgeGpusByDefault(n);
  if (!Number.isInteger(j) || j < 1 || j > n - 1 || j > 8 || n - j > 8)
    throw new Error(
      `with ${n} GPUs the judge takes 1 to ${Math.min(8, n - 1)} of them, and the agents at most 8`,
    );
  return {
    THERMITE_GPUS: Array.from({ length: n }, (_, i) => i).join(","),
    THERMITE_JUDGE_GPUS: String(j),
  };
}

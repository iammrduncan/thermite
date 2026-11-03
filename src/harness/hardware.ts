import { execFileSync } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { arch, availableParallelism, cpus, release, totalmem } from "node:os";
import type { Hardware, HardwareDevice } from "../core/hardware.ts";
import type { TargetDriver } from "./targets/index.ts";

/**
 * Collects what this rig runs on, for the dashboard. Device details come from nvidia-smi as the
 * user that may open each card (the run user for the judge's card, a development user for a
 * dedicated development card); everything else from the container's own view. Nothing here is a
 * measurement, and a part that cannot be read is listed in `errors` rather than guessed.
 */

const GPU_FIELDS = [
  "uuid",
  "name",
  "pci.bus_id",
  "driver_version",
  "memory.total",
  "power.limit",
  "clocks.max.sm",
  "clocks.max.mem",
  "pcie.link.gen.max",
  "pcie.link.width.max",
  "vbios_version",
] as const;

const num = (s: string | undefined): number | null => {
  const n = Number(s);
  return s !== undefined && s.trim() !== "" && Number.isFinite(n) ? n : null;
};

/** One card's row from `nvidia-smi --query-gpu=<GPU_FIELDS> --format=csv,noheader,nounits`. */
export function parseDevice(
  row: string,
  role: HardwareDevice["role"],
  cuda: string | null,
): HardwareDevice {
  const f = row.split(",").map((x) => x.trim());
  if (f.length < GPU_FIELDS.length) throw new Error(`unexpected nvidia-smi row: ${row}`);
  const [uuid, name, bus, driver, mem, power, sm, memClock, gen, width, vbios] = f;
  return {
    role,
    name: name ?? "",
    uuid: uuid ?? "",
    bus: bus ?? "",
    memory_mib: num(mem),
    driver: driver || null,
    cuda,
    power_limit_w: num(power),
    max_sm_mhz: num(sm),
    max_mem_mhz: num(memClock),
    pcie: num(gen) !== null && num(width) !== null ? `gen${gen} x${width}` : null,
    vbios: vbios || null,
  };
}

/** The CUDA version from plain `nvidia-smi` output ("CUDA Version: 12.4"). */
export function parseCudaVersion(text: string): string | null {
  return /CUDA Version:\s*([0-9.]+)/.exec(text)?.[1] ?? null;
}

function firstLine(cmd: string, args: string[], last = false): string | null {
  try {
    const lines = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    return (last ? lines.at(-1) : lines[0]) ?? null;
  } catch {
    return null;
  }
}

function readOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function collectHardware(opts: {
  driver: TargetDriver;
  /** nvidia-smi for each card the rig uses, as a user that may open it. */
  cards?: { role: HardwareDevice["role"]; select: string; smi: (a: string[]) => Promise<string> }[];
  deviceMode: Hardware["device_mode"];
  stateDir: string;
  scratchDir: string;
  now?: Date;
}): Promise<Hardware> {
  const errors: string[] = [];
  const id = await opts.driver.identify().catch((err) => {
    errors.push(`target: ${String(err)}`);
    return { type: opts.driver.type, class: "", id: "" };
  });
  const devices: HardwareDevice[] = [];
  for (const card of opts.cards ?? []) {
    try {
      const row = await card.smi([
        `--query-gpu=${GPU_FIELDS.join(",")}`,
        "--format=csv,noheader,nounits",
        "-i",
        card.select,
      ]);
      const cuda = parseCudaVersion(await card.smi([]).catch(() => ""));
      devices.push(parseDevice(row.trim().split("\n")[0] ?? "", card.role, cuda));
    } catch (err) {
      errors.push(`${card.role} card: ${String(err).slice(0, 200)}`);
    }
  }
  const cpuinfo = readOr("/proc/cpuinfo") ?? "";
  const quotaText = readOr("/sys/fs/cgroup/cpu.max")?.trim().split(/\s+/);
  const quota =
    quotaText && quotaText[0] !== "max" && Number(quotaText[1]) > 0
      ? Number(quotaText[0]) / Number(quotaText[1])
      : null;
  const memMax = readOr("/sys/fs/cgroup/memory.max")?.trim();
  const disks: Hardware["disks"] = [];
  for (const [name, path] of [
    ["state", opts.stateDir],
    ["scratch", opts.scratchDir],
  ] as const) {
    try {
      const s = statfsSync(path);
      const gib = (blocks: number) => Math.round(((blocks * s.bsize) / 2 ** 30) * 10) / 10;
      disks.push({ name, total_gib: gib(s.blocks), free_gib: gib(s.bavail) });
    } catch (err) {
      errors.push(`${name} disk: ${String(err)}`);
    }
  }
  return {
    collected_at: (opts.now ?? new Date()).toISOString(),
    target: { type: id.type, class: id.class, id: id.id },
    device_mode: opts.deviceMode,
    devices,
    cpu: {
      model: /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? cpus()[0]?.model ?? "",
      host: cpus().length,
      usable: availableParallelism(),
      quota: quota === null ? null : Math.round(quota * 100) / 100,
    },
    memory: {
      host_mib: Math.round(totalmem() / 2 ** 20),
      limit_mib: memMax && memMax !== "max" ? Math.round(Number(memMax) / 2 ** 20) : null,
    },
    disks,
    os: {
      kernel: release(),
      arch: arch(),
      node: process.version,
      // Set by the release images (empty in an image built from a checkout).
      image: process.env.THERMITE_IMAGE_ID || null,
    },
    toolchain: {
      cc: firstLine("cc", ["--version"]),
      nvcc: firstLine("nvcc", ["--version"], true),
    },
    errors,
  };
}

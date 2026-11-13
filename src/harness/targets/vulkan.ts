import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import type { Role, Runner } from "../broker/index.ts";
import type { Readiness, TargetDriver, TargetIdentity } from "./driver.ts";

const run = promisify(execFile);

/**
 * A GPU reached through Vulkan (goal 106), read through `vulkaninfo`: first of all a Mac's GPU as
 * a Linux container sees it on a Podman machine that gives its containers one (Mesa's Venus
 * driver in the container, the Mac's Metal behind it). The device has no tool of its own, as
 * nvidia-smi is for a CUDA card: no temperature, no clocks, no figure of the memory in use. So
 * the driver says which device it is and that it is a real GPU, and nothing of its state.
 *
 * It never takes the software device (Mesa's llvmpipe, which computes on the CPU): a rig that
 * sees only that one is not ready, in words.
 */

/** One physical device as `vulkaninfo --summary` lists it. */
interface VulkanDevice {
  name: string;
  /** PHYSICAL_DEVICE_TYPE_ without its prefix: INTEGRATED_GPU, DISCRETE_GPU, VIRTUAL_GPU, CPU. */
  kind: string;
  vendor: string;
  device: string;
  driver: string;
  driverInfo: string;
  api: string;
  /** The device's UUID as Vulkan gives it; empty when it gives none. */
  uuid: string;
}

/** The devices of `vulkaninfo --summary`'s text, in its order. */
export function parseVulkanSummary(text: string): VulkanDevice[] {
  const out: VulkanDevice[] = [];
  let at: Record<string, string> | undefined;
  const keep = () => {
    if (!at?.deviceName) return;
    out.push({
      name: at.deviceName,
      kind: (at.deviceType ?? "").replace(/^PHYSICAL_DEVICE_TYPE_/, ""),
      vendor: at.vendorID ?? "",
      device: at.deviceID ?? "",
      driver: at.driverName ?? "",
      driverInfo: at.driverInfo ?? "",
      api: at.apiVersion ?? "",
      uuid: at.deviceUUID ?? "",
    });
  };
  for (const line of text.split("\n")) {
    if (/^GPU\d+:\s*$/.test(line)) {
      keep();
      at = {};
      continue;
    }
    const m = /^\s+(\w+)\s+=\s+(.*\S)\s*$/.exec(line);
    if (at && m?.[1] && m[2] !== undefined) at[m[1]] = m[2];
  }
  keep();
  return out;
}

/** The device a rig measures on: the first one that is a GPU, never the software one. */
export const realGpu = (devices: VulkanDevice[]): VulkanDevice | undefined =>
  devices.find((d) => d.kind !== "CPU" && d.kind !== "");

interface VulkanDriverOptions {
  targetClass: string;
  /** Why the device must not be used for timing at all (for example a failed device setup). */
  unusable?: string | undefined;
  /** For tests: replaces running vulkaninfo. */
  info?: ((args: string[]) => Promise<string>) | undefined;
}

export class VulkanDriver implements TargetDriver {
  readonly type = "vulkan-gpu";
  private readonly targetClass: string;
  private readonly unusable: string | undefined;
  private readonly info: (args: string[]) => Promise<string>;

  constructor(opts: VulkanDriverOptions) {
    this.targetClass = opts.targetClass;
    this.unusable = opts.unusable;
    this.info =
      opts.info ?? (async (args) => (await run("vulkaninfo", args, { encoding: "utf8" })).stdout);
  }

  /** The devices Vulkan lists now. */
  async devices(): Promise<VulkanDevice[]> {
    return parseVulkanSummary(await this.info(["--summary"]));
  }

  private async gpu(): Promise<VulkanDevice> {
    const devices = await this.devices();
    const gpu = realGpu(devices);
    if (gpu) return gpu;
    const others = devices.map((d) => d.name).join(", ");
    throw new Error(
      others
        ? `Vulkan lists no GPU, only ${others}, which computes on the CPU: the container was not given the GPU's device (/dev/dri), or its Vulkan driver can't use it`
        : "Vulkan lists no device: the container was not given the GPU's device (/dev/dri)",
    );
  }

  async identify(): Promise<TargetIdentity> {
    const d = await this.gpu();
    const id = createHash("sha256")
      .update(`${d.name}|${d.vendor}|${d.device}`)
      .digest("hex")
      .slice(0, 16);
    return {
      type: this.type,
      class: this.targetClass,
      id: `vulkan-${id}`,
      details: {
        name: d.name,
        kind: d.kind,
        vendor: d.vendor,
        device: d.device,
        driver: d.driver,
        driver_info: d.driverInfo,
        api: d.api,
        uuid: d.uuid,
      },
    };
  }

  /**
   * Ready when Vulkan lists the GPU. The device gives no use, memory or temperature, so the
   * driver can't say that it is idle: a run's own repeats show a disturbed block.
   */
  async readyForTiming(): Promise<Readiness> {
    if (this.unusable) return { ready: false, reasons: [this.unusable], details: {} };
    try {
      const d = await this.gpu();
      return { ready: true, reasons: [], details: { name: d.name, driver: d.driverInfo } };
    } catch (err) {
      return {
        ready: false,
        reasons: [String(err instanceof Error ? err.message : err)],
        details: {},
      };
    }
  }

  async envSnapshot(): Promise<Record<string, unknown>> {
    return { vulkan: await this.devices() };
  }

  /** Nothing to read after a block: the device reports no throttling or temperature. */
  async afterBlock(): Promise<string[]> {
    return [];
  }

  plausibility(metrics: Record<string, number>): string[] {
    return Object.entries(metrics)
      .filter(([, v]) => !Number.isFinite(v))
      .map(([k]) => `${k} is not finite`);
  }

  async recover(): Promise<Readiness> {
    return this.readyForTiming();
  }
}

/**
 * vulkaninfo as a role that may open the device (`run`, or a lane's development user): the
 * controller's own user may not. Without the broker (local development) it runs as the controller.
 */
export function vulkanInfoAs(
  runner: Runner,
  role: Role,
  dir: string,
): (args: string[]) => Promise<string> {
  let ready: Promise<void> | undefined;
  return async (args) => {
    ready ??= (async () => {
      mkdirSync(dir, { recursive: true });
      await runner.handOver(dir, role);
    })();
    await ready;
    let last = "";
    // A query can be caught by the judge killing the run user's processes after a timed run.
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await runner.run({
        role,
        argv: ["vulkaninfo", ...args],
        cwd: dir,
        timeoutMs: 30_000,
        captureBytes: 1024 * 1024,
      });
      if (r.exitCode === 0) return r.stdout;
      last = `vulkaninfo exited ${r.exitCode ?? r.signal}: ${r.stderr.slice(-300)}`;
    }
    throw new Error(last);
  };
}

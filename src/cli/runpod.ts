import type { z } from "zod";
import type { LaunchBody, LimitsBody } from "../core/api/control/owner.ts";
import type { RunpodRigView } from "../core/api/control/runpod.ts";

/**
 * `thermite runpod`: rigs on a GPU cloud, through control's REST API with the owner's token.
 * These turn the command's options into the API's bodies and its answers into lines.
 */

const number = (flag: string, text: string, whole: boolean): number => {
  const n = Number(text);
  if (!text.trim() || !Number.isFinite(n) || (whole && !Number.isInteger(n)))
    throw new Error(`${flag} takes ${whole ? "a whole number" : "a number"}, not "${text}"`);
  return n;
};

/** A limit: a number, or `off` to clear it. */
const limit = (flag: string, text: string | undefined, whole: boolean) =>
  text === undefined ? undefined : text === "off" ? null : number(flag, text, whole);

export interface LaunchOptions {
  gpu?: string | undefined;
  gpus?: string | undefined;
  "cloud-type"?: string | undefined;
  datacenter?: string | undefined;
  image?: string | undefined;
  disk?: string | undefined;
  volume?: string | undefined;
  rig?: string | undefined;
  "enroll-within"?: string | undefined;
  setting?: string[] | undefined;
  "spend-limit"?: string | undefined;
  "idle-stop"?: string | undefined;
}

/** The body of POST /v1/gpu-clouds/<name>/rigs. Throws, in words, on an option it can't take. */
export function launchBody(o: LaunchOptions): z.input<typeof LaunchBody> {
  if (!o.gpu) throw new Error("--gpu names the GPU type: its id or name in RunPod's list");
  const cloudType = o["cloud-type"]?.toUpperCase();
  if (cloudType !== undefined && cloudType !== "SECURE" && cloudType !== "COMMUNITY")
    throw new Error(`--cloud-type is SECURE or COMMUNITY, not "${o["cloud-type"]}"`);
  // Control checks each name: only the pod's settings it lists (POD_CONFIG_ENV) are taken.
  const settings: Record<string, string> = {};
  for (const s of o.setting ?? []) {
    const eq = s.indexOf("=");
    if (eq < 1) throw new Error(`--setting takes NAME=VALUE, not "${s}"`);
    settings[s.slice(0, eq)] = s.slice(eq + 1);
  }
  type Launch = z.input<typeof LaunchBody>;
  const body: Launch = {
    gpu: o.gpu,
    ...(o.gpus !== undefined ? { gpu_count: number("--gpus", o.gpus, true) } : {}),
    ...(cloudType ? { cloud_type: cloudType } : {}),
    ...(o.datacenter ? { datacenter: o.datacenter } : {}),
    ...(o.image ? { image: o.image } : {}),
    ...(o.disk !== undefined ? { container_disk_gb: number("--disk", o.disk, true) } : {}),
    ...(o.volume !== undefined ? { volume_gb: number("--volume", o.volume, true) } : {}),
    ...(o.rig ? { rig: o.rig } : {}),
    ...(o["enroll-within"] !== undefined
      ? { enroll_within_minutes: number("--enroll-within", o["enroll-within"], false) }
      : {}),
    ...(Object.keys(settings).length ? { settings: settings as Launch["settings"] } : {}),
    ...(o["spend-limit"] !== undefined
      ? { spend_limit_usd: number("--spend-limit", o["spend-limit"], false) }
      : {}),
    ...(o["idle-stop"] !== undefined
      ? { idle_stop_minutes: limit("--idle-stop", o["idle-stop"], false) }
      : {}),
  };
  return body;
}

/** The body of POST /v1/rigs/<rig>/runpod/limits: a number sets a limit, `off` clears it. */
export function limitsBody(o: {
  "spend-limit"?: string | undefined;
  "idle-stop"?: string | undefined;
}): z.input<typeof LimitsBody> {
  const spend = limit("--spend-limit", o["spend-limit"], false);
  const idle = limit("--idle-stop", o["idle-stop"], false);
  if (spend === undefined && idle === undefined)
    throw new Error("give --spend-limit, --idle-stop or both (a number, or off)");
  return {
    ...(spend !== undefined ? { spend_limit_usd: spend } : {}),
    ...(idle !== undefined ? { idle_stop_minutes: idle } : {}),
  };
}

const usd = (v: number | null) => (v === null ? "no price" : `$${v.toFixed(2)}`);

/** One line for each rig: its pod, status, GPUs, price, spend so far and limits. */
export function formatRunpodRigs(rigs: RunpodRigView[]): string {
  if (!rigs.length) return "no rig on a GPU cloud\n";
  return rigs
    .map((r) => {
      const parts = [
        r.rig,
        `pod ${r.pod}`,
        r.active ? r.status : "gone",
        `${r.gpu_count} × ${r.gpu_name} (${r.cloud_type === "SECURE" ? "Secure" : "Community"})`,
        `${usd(r.price_per_hr)}/h`,
        `spent ${usd(r.spend_usd)}`,
        r.spend_limit_usd !== null ? `spend limit ${usd(r.spend_limit_usd)}` : "no spend limit",
        r.idle_stop_minutes !== null ? `idle stop ${r.idle_stop_minutes} min` : "no idle stop",
        r.enrolled_at ? "enrolled" : "not enrolled yet",
      ];
      const stopped = !r.stopped_by
        ? ""
        : r.stopped_by === "owner"
          ? "\n  stopped by the owner"
          : `\n  stopped by control: ${r.stopped_by === "spend_limit" ? "spend limit" : "idle stop"}`;
      const op = r.op_words ? `\n  under way: ${r.op_words}` : "";
      const error = r.error ? `\n  last error: ${r.error}` : "";
      return `${parts.join(" · ")}${stopped}${op}${error}`;
    })
    .join("\n")
    .concat("\n");
}

/** What a lifecycle command did, in a line after the rig's. */
export function lifecycleSaid(sub: "stop" | "start" | "restart" | "terminate"): string {
  return {
    stop: "Stopping: its runs are paused and its results go out first, then the pod stops. Follow it with thermite runpod list.\n",
    start:
      "Started: RunPod bills the pod from now. The runs the last stop paused resume once it runs.\n",
    restart: "Restarting: the pod stops, then starts again. Its volume stays.\n",
    terminate:
      "Terminating: its runs are paused, and the pod is removed only once every result has left it. Follow it with thermite runpod list.\n",
  }[sub];
}

/** The reset of `rig` that has not ended, from GET /v1/resets; throws, in words, when none. */
export function openResetOf(resets: { id: number; rig: string; state: string }[], rig: string) {
  const r = resets.find((x) => x.rig === rig && !["done", "failed", "cancelled"].includes(x.state));
  if (!r) throw new Error(`no full reset of ${rig} is under way`);
  return r;
}

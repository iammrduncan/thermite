import { gpuSplit, MAX_RIG_GPUS } from "../core/hardware.ts";
import type { Probes, RunResult } from "./doctor/index.ts";

/**
 * What the local rig can use on this machine: the CPUs and memory its container engine gives
 * containers, the NVIDIA GPUs it can be given, and the GPUs it can't use yet (AMD's, and Apple's
 * on a Mac). `thermite local init` writes compose.gpu.yaml from it, and `thermite doctor` reports
 * it. Every probe goes through Probes, so each case is tested with stand-ins, and a program that
 * is missing is "not found", never an error. Nothing here changes the machine.
 *
 * The local stack sets no CPU or memory limits, so the rig has every CPU and all the memory the
 * engine has: on Linux the machine's, on a Mac its virtual machine's. GPUs need the harness's
 * CUDA image and the devices passed in: compose.gpu.yaml does both, for Docker through NVIDIA's
 * runtime and for Podman through the CDI spec of NVIDIA's container toolkit.
 */

export type EngineName = "docker" | "podman";
export const ENGINE_LABEL: Record<EngineName, string> = { docker: "Docker", podman: "Podman" };

/** The CDI spec files `nvidia-ctk cdi generate` writes, where Podman looks for them. */
export const CDI_SPECS = ["/etc/cdi/nvidia.yaml", "/var/run/cdi/nvidia.yaml"];
export const CDI_GENERATE = "sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml";
const DOCKER_RUNTIME =
  "sudo nvidia-ctk runtime configure --runtime=docker, then sudo systemctl restart docker";
/** The nvidia-smi query the doctor's driver check and the GPU count share. */
export const SMI_ARGS = ["--query-gpu=name,driver_version", "--format=csv,noheader"];
/** The file local init writes next to `.dev/`, and the compose file it adds to. */
export const GPU_OVERRIDE = "compose.gpu.yaml";

/**
 * The CUDA harness's base image, as the release workflow builds it (`CUDA_BASE_IMAGE` in
 * .github/workflows/release.yml; a test keeps the two the same). A checkout's compose.yaml builds
 * the harness from source, so its GPU override builds it on this base.
 */
export const CUDA_BASE_IMAGE =
  "docker.io/nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:d49bb8a4ff97fb5fe477947a3f02aa8c0a53eae77e11f00ec28618a0bcaa2ad1";
/** The tag a checkout's GPU override gives the CUDA harness it builds. */
export const LOCAL_CUDA_TAG = "thermite-harness:local-cuda";

export interface EngineFacts {
  name: EngineName;
  /** CPUs and memory its containers can use: its virtual machine's on a Mac. */
  cpus?: number | undefined;
  memBytes?: number | undefined;
  /** Its containers run in a virtual machine: on a Mac, or Docker Desktop anywhere. */
  vm: boolean;
  /** Docker's runtimes (`docker info`), such as runc and nvidia. */
  runtimes: string[];
}

/** Whether the engine can give containers the NVIDIA GPUs. */
export type GpuPass =
  | { ok: true; how: string }
  | { ok: false; why: string; fix: string }
  /** Seen from inside a container (the release's init service), it can't be checked. */
  | { ok: "unchecked" };

export interface MachineFacts {
  /** Where the probes ran: on the machine itself, or in a container on it. */
  where: "machine" | "container";
  platform: NodeJS.Platform;
  arch: string;
  /** The engine the local rig runs on; none when no engine answers. */
  engine?: EngineFacts | undefined;
  /** The other engine, when both answer: the rig could run there instead. */
  other?: EngineFacts | undefined;
  /** The machine's own CPUs and memory (on a Mac, the Mac's, not its virtual machine's). */
  hostCpus: number;
  hostMemBytes: number;
  nvidia: {
    /** An NVIDIA GPU is on the machine, listed or not. */
    present: boolean;
    /** The GPUs nvidia-smi (or, in a container, the driver) lists, by name. */
    names: string[];
    /** nvidia-smi's answer, on the machine, when there is an NVIDIA GPU. */
    smi?: RunResult | undefined;
    /** NVIDIA's container toolkit: nvidia-ctk's version line, when it answers. */
    toolkit?: RunResult | undefined;
  };
  /** Whether the engine can give containers the NVIDIA GPUs (only with GPUs nvidia-smi lists). */
  pass?: GpuPass | undefined;
  /** AMD GPUs: how many, and their names where lspci gives them. */
  amd: { count: number; names: string[] };
  /** A Mac with Apple silicon: containers there can't reach its GPU. */
  appleSilicon: boolean;
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A name as a line of plain text: printable characters only, not too long. */
const clean = (s: string) =>
  s
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 80);

// ---------------------------------------------------------------- probes

/** The engine that runs this process's container, when it runs in one. */
export function containerEngine(p: Probes): EngineName | undefined {
  if (p.exists("/run/.containerenv")) return "podman";
  if (p.exists("/.dockerenv")) return "docker";
  return undefined;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** CPUs, memory and runtimes from `docker info` or `podman info`; undefined when it fails. */
export async function engineFacts(p: Probes, name: EngineName): Promise<EngineFacts | undefined> {
  if (name === "docker") {
    const r = await p.run("docker", ["info", "--format", "{{json .}}"]);
    if (r.code !== 0) return undefined;
    let info: { NCPU?: unknown; MemTotal?: unknown; Runtimes?: unknown; OperatingSystem?: unknown };
    try {
      info = JSON.parse(r.stdout) as typeof info;
    } catch {
      return { name, vm: p.platform === "darwin", runtimes: [] };
    }
    const runtimes =
      info.Runtimes && typeof info.Runtimes === "object" ? Object.keys(info.Runtimes) : [];
    const desktop =
      typeof info.OperatingSystem === "string" && /docker desktop/i.test(info.OperatingSystem);
    return {
      name,
      cpus: num(info.NCPU),
      memBytes: num(info.MemTotal),
      vm: p.platform === "darwin" || desktop,
      runtimes,
    };
  }
  const r = await p.run("podman", ["info", "--format", "json"]);
  if (r.code !== 0) return undefined;
  let host: { cpus?: unknown; memTotal?: unknown } = {};
  try {
    host = (JSON.parse(r.stdout) as { host?: typeof host }).host ?? {};
  } catch {
    // Podman answered with something else: its numbers stay unknown.
  }
  return {
    name,
    cpus: num(host.cpus),
    memBytes: num(host.memTotal),
    vm: p.platform === "darwin",
    runtimes: [],
  };
}

/** Whether there is an NVIDIA GPU on this Linux machine, listed by the driver or not. */
export async function hasNvidiaGpu(p: Probes): Promise<boolean> {
  if (p.exists("/dev/nvidia0") || p.exists("/proc/driver/nvidia/gpus")) return true;
  const pci = await p.run("lspci", []);
  return (
    pci.code === 0 &&
    pci.stdout.split("\n").some((l) => /NVIDIA/i.test(l) && /VGA|3D|Display/i.test(l))
  );
}

/** The GPUs' names from nvidia-smi's CSV answer (name, driver version). */
export function smiNames(smi: RunResult | undefined): string[] {
  if (smi?.code !== 0) return [];
  return smi.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => clean(l.split(",")[0] ?? l));
}

/** NVIDIA GPUs as the driver lists them under /proc: readable inside a container too. */
function procNvidiaNames(p: Probes): string[] {
  const dir = "/proc/driver/nvidia/gpus";
  return p
    .list(dir)
    .sort()
    .map((bus) => {
      const info = p.readText(`${dir}/${bus}/information`) ?? "";
      return clean(/^Model:\s*(.+)$/m.exec(info)?.[1] ?? "NVIDIA GPU");
    });
}

/**
 * AMD GPUs: display devices with AMD's PCI vendor id (0x1002) under /sys/class/drm, or AMD's
 * compute device /dev/kfd. Their names come from lspci where it is installed.
 */
export async function amdGpus(p: Probes, withNames: boolean): Promise<MachineFacts["amd"]> {
  const cards = p
    .list("/sys/class/drm")
    .filter((n) => /^card\d+$/.test(n))
    .filter(
      (c) => p.readText(`/sys/class/drm/${c}/device/vendor`)?.trim().toLowerCase() === "0x1002",
    );
  const count = cards.length || (p.exists("/dev/kfd") ? 1 : 0);
  if (!count || !withNames) return { count, names: [] };
  const pci = await p.run("lspci", []);
  const names =
    pci.code === 0
      ? pci.stdout
          .split("\n")
          .filter((l) => /VGA|3D|Display/i.test(l) && /\b(AMD|ATI)\b/.test(l))
          .map((l) => clean(l.replace(/^\S+\s+[^:]+:\s*/, "")))
      : [];
  return { count, names: names.length === count ? names : [] };
}

/** Whether the engine can give containers the NVIDIA GPUs, and if not, why and the fix. */
export async function nvidiaPass(
  p: Probes,
  engine: EngineFacts,
  toolkit: RunResult | undefined,
): Promise<GpuPass> {
  const installed = toolkit !== undefined && !toolkit.missing && toolkit.code === 0;
  const install = "Install NVIDIA's container toolkit.";
  if (engine.name === "docker") {
    if (engine.runtimes.includes("nvidia")) return { ok: true, how: "NVIDIA's runtime" };
    return installed
      ? {
          ok: false,
          why: "Docker has no NVIDIA runtime, which gives containers the GPUs.",
          fix: `Register NVIDIA's runtime with Docker: ${DOCKER_RUNTIME}.`,
        }
      : {
          ok: false,
          why: "NVIDIA's container toolkit is not installed, so Docker can't give containers the GPUs.",
          fix: `${install} Then register its runtime with Docker: ${DOCKER_RUNTIME}.`,
        };
  }
  const spec = CDI_SPECS.find((f) => p.exists(f));
  if (spec) return { ok: true, how: `the CDI spec in ${spec}` };
  const listed = installed ? await p.run("nvidia-ctk", ["cdi", "list"]) : undefined;
  if (listed?.code === 0 && /nvidia\.com\/gpu=all/.test(`${listed.stdout}\n${listed.stderr}`))
    return { ok: true, how: "the CDI spec of NVIDIA's container toolkit" };
  return installed
    ? {
        ok: false,
        why: "NVIDIA's container toolkit has no CDI spec, which tells Podman which GPUs there are.",
        fix: `Make the CDI spec: ${CDI_GENERATE}. Make it again after each driver update.`,
      }
    : {
        ok: false,
        why: "NVIDIA's container toolkit is not installed, so Podman can't give containers the GPUs.",
        fix: `${install} Then make its CDI spec: ${CDI_GENERATE}.`,
      };
}

/**
 * The machine as `thermite doctor` and `thermite local init` see it from the machine itself.
 * `engines` are the engines that answer; the rig runs on `prefer` when it answers, else on the
 * first that can give containers the GPUs, else on Docker, else on Podman.
 */
export async function detectOnMachine(
  p: Probes,
  engines: EngineName[],
  prefer?: EngineName,
): Promise<MachineFacts> {
  const facts: EngineFacts[] = [];
  for (const name of engines) {
    const f = await engineFacts(p, name);
    if (f) facts.push(f);
  }
  const linux = p.platform === "linux";
  const present = linux && (await hasNvidiaGpu(p));
  const smi = present ? await p.run("nvidia-smi", SMI_ARGS) : undefined;
  const names = smiNames(smi);
  const toolkit = present ? await p.run("nvidia-ctk", ["--version"]) : undefined;
  const passes = new Map<EngineName, GpuPass>();
  if (names.length) for (const f of facts) passes.set(f.name, await nvidiaPass(p, f, toolkit));
  const engine =
    facts.find((f) => f.name === prefer) ??
    facts.find((f) => passes.get(f.name)?.ok === true) ??
    facts.find((f) => f.name === "docker") ??
    facts[0];
  return {
    where: "machine",
    platform: p.platform,
    arch: p.arch,
    engine,
    other: facts.find((f) => f !== engine),
    hostCpus: p.cpus,
    hostMemBytes: p.memBytes,
    nvidia: { present, names, smi, toolkit },
    pass: engine ? passes.get(engine.name) : undefined,
    amd: linux ? await amdGpus(p, true) : { count: 0, names: [] },
    appleSilicon: p.platform === "darwin" && p.arch === "arm64",
  };
}

/**
 * The machine as the release's init service sees it, from inside its container: the engine that
 * runs it (from the file each engine puts in its containers), the CPUs and memory the containers
 * have, and the GPUs the driver lists. Whether the engine can give containers the GPUs can't be
 * seen from there.
 */
export async function detectInContainer(p: Probes, engine: EngineName): Promise<MachineFacts> {
  const names = procNvidiaNames(p);
  return {
    where: "container",
    platform: p.platform,
    arch: p.arch,
    engine: { name: engine, cpus: p.cpus, memBytes: p.memBytes, vm: false, runtimes: [] },
    hostCpus: p.cpus,
    hostMemBytes: p.memBytes,
    nvidia: { present: names.length > 0, names },
    pass: names.length ? { ok: "unchecked" } : undefined,
    amd: await amdGpus(p, false),
    appleSilicon: false,
  };
}

// ---------------------------------------------------------------- what the rig gets

/**
 * How the local rig uses `n` NVIDIA GPUs: at most MAX_RIG_GPUS; one is shared by the judge and
 * the agents; with more, the judge gets one and the agents the rest, as long as the agents get at
 * most 8 (the harness image has users for 8 of each). Edit rig can change the split later.
 */
export function localGpuPlan(n: number): {
  use: number;
  judge: number;
  agents: number;
  env: Record<string, string>;
} {
  const use = Math.min(n, MAX_RIG_GPUS);
  const judge = use <= 1 ? use : Math.max(1, use - 8);
  return {
    use,
    judge,
    agents: use <= 1 ? 0 : use - judge,
    env: { THERMITE_TARGET: "cuda-gpu", ...gpuSplit(use, use > 1 ? judge : undefined) },
  };
}

/** "2 NVIDIA GPUs (NVIDIA A100 ×2)": how many, and each model once with its count. */
export function gpuWords(names: string[], kind = "NVIDIA"): string {
  const counts = new Map<string, number>();
  for (const n of names.map(clean)) counts.set(n, (counts.get(n) ?? 0) + 1);
  const models = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
  return `${plural(names.length, `${kind} GPU`)}${models ? ` (${models})` : ""}`;
}

/** The machine's GPUs after "have": "its NVIDIA GPU (…)" for one, "the 2 NVIDIA GPUs (…)" for more. */
function theGpus(names: string[]): string {
  return names.length === 1
    ? `its ${gpuWords(names).replace(/^1 /, "")}`
    : `the ${gpuWords(names)}`;
}

/** The split in words: who gets which share, and why when the rig can't take every GPU. */
export function splitWords(n: number): string {
  const plan = localGpuPlan(n);
  if (plan.use === 1) return "The judge and the agents share it.";
  const words = [`The judge gets ${plan.judge}, the agents ${plan.agents}.`];
  if (plan.judge > 1) words.push("The agents take at most 8.");
  if (n > plan.use)
    words.push(`A rig takes at most ${MAX_RIG_GPUS} GPUs, so it gets the first ${plan.use}.`);
  return words.join(" ");
}

/** How to start the stack with the GPU override. */
export const upWithGpus = (engine: EngineName) =>
  `${engine} compose -f compose.yaml -f ${GPU_OVERRIDE} up -d`;

export interface RigReport {
  /** ok, or warn when the rig can't have GPUs the machine has; skip when nothing answers. */
  status: "ok" | "warn" | "skip";
  /** Sentences: CPUs and memory, then NVIDIA, AMD and Apple's GPU where they apply. */
  lines: string[];
  fix?: string | undefined;
  /** The NVIDIA GPUs the rig gets through compose.gpu.yaml, when it can have them. */
  gpus?: { engine: EngineName; names: string[] } | undefined;
}

function resourceWords(m: MachineFacts, e: EngineFacts): string {
  const label = ENGINE_LABEL[e.name];
  if (e.cpus === undefined || e.memBytes === undefined)
    return `${label} did not say how many CPUs and how much memory its containers have. The stack sets no limits, so the rig can use all of them.`;
  const has = `${plural(e.cpus, "CPU")} and ${gb(e.memBytes)} of memory`;
  if (m.where === "container")
    return `The containers have ${has} (on a Mac, the virtual machine's), and the stack sets no limits, so the rig can use all of them.`;
  if (!e.vm)
    return `${label} gives containers this machine's ${has}. The stack sets no limits, so the rig can use all of them.`;
  const words = [
    `${label}'s virtual machine has ${has}, and the rig can use all of them.`,
    `This ${m.platform === "darwin" ? "Mac" : "machine"} has ${plural(m.hostCpus, "CPU")} and ${gb(m.hostMemBytes)}.`,
  ];
  if (e.cpus < m.hostCpus || e.memBytes < m.hostMemBytes / 2) {
    const mb = Math.max(2048, Math.floor(m.hostMemBytes / 2 / 2 ** 30) * 1024);
    words.push(
      e.name === "podman"
        ? `To give it more, stop it and set them: podman machine stop, then podman machine set --cpus ${m.hostCpus} --memory ${mb}, then podman machine start.`
        : "To give it more, set them in Docker Desktop's Settings › Resources.",
    );
  }
  return words.join(" ");
}

/** What the local rig gets on this machine, and what it doesn't, in sentences. */
export function rigReport(m: MachineFacts): RigReport {
  const e = m.engine;
  if (!e)
    return {
      status: "skip",
      lines: ["No container engine answers, so what the rig gets was not checked."],
    };
  const lines = [resourceWords(m, e)];
  const o = m.other;
  if (o?.cpus && o.memBytes)
    lines.push(
      `With ${ENGINE_LABEL[o.name]} instead, the rig gets ${plural(o.cpus, "CPU")} and ${gb(o.memBytes)} of memory${o.vm ? ", its virtual machine's" : ""}.`,
    );
  let status: RigReport["status"] = "ok";
  let fix: string | undefined;
  let gpus: RigReport["gpus"];
  const n = m.nvidia.names.length;
  if (m.nvidia.present && !n) {
    status = "warn";
    lines.push(
      "This machine has an NVIDIA GPU, but nvidia-smi does not list it, so the rig can't have it and uses the CPU.",
    );
    fix =
      "Fix NVIDIA's driver, as the GPU driver check of thermite doctor says. Then run thermite local init again.";
  } else if (n && m.pass?.ok === true) {
    gpus = { engine: e.name, names: m.nvidia.names };
    lines.push(
      `The rig can also have ${theGpus(m.nvidia.names)}: ${ENGINE_LABEL[e.name]} gives ${n === 1 ? "it" : "them"} to containers through ${m.pass.how}. ${splitWords(n)}`,
    );
  } else if (n && m.pass?.ok === "unchecked") {
    gpus = { engine: e.name, names: m.nvidia.names };
    const needs =
      e.name === "docker"
        ? "NVIDIA's container toolkit, with its runtime registered with Docker"
        : "NVIDIA's container toolkit and its CDI spec";
    lines.push(
      `The rig can also have ${theGpus(m.nvidia.names)}. ${splitWords(n)} That needs ${needs}, which can't be checked from inside a container: run thermite doctor on the machine to check it.`,
    );
  } else if (n && m.pass?.ok === false) {
    status = "warn";
    lines.push(
      `This machine has ${gpuWords(m.nvidia.names)}, but the rig can't have ${n === 1 ? "it" : "them"} yet: ${m.pass.why} So it uses the CPU.`,
    );
    fix = `${m.pass.fix} Then run thermite local init again.`;
  }
  if (m.amd.count) {
    const what =
      m.amd.names.length === m.amd.count
        ? gpuWords(m.amd.names, "AMD")
        : plural(m.amd.count, "AMD GPU");
    lines.push(
      `This machine has ${what}. The rig does not get ${m.amd.count === 1 ? "it" : "them"}: Thermite's GPU images are built on CUDA, which runs on NVIDIA GPUs only, and AMD GPUs need a ROCm image, which Thermite does not have yet.`,
    );
  }
  if (m.appleSilicon)
    lines.push(
      "This Mac has Apple silicon. Containers on macOS run in a Linux virtual machine, which can't reach the Apple GPU (Metal), so MLX-style work can't run in a rig yet. The rig gets the virtual machine's CPUs and memory, not the GPU.",
    );
  return { status, lines, fix, gpus };
}

// ---------------------------------------------------------------- compose.gpu.yaml

/** Which image the GPU override gives the harness, from the compose file next to `.dev/`. */
export type HarnessImage =
  /** A checkout's compose.yaml builds the harness: build it on the CUDA base. */
  | { kind: "build" }
  /** A release's compose.yaml names its CUDA harness as control's default. */
  | { kind: "image"; fallback: string }
  /** Neither: THERMITE_RIG_HARNESS_CUDA_IMAGE must name it. */
  | { kind: "unset" };

export function harnessImageFrom(compose: string | undefined): HarnessImage {
  if (compose === undefined) return { kind: "unset" };
  if (/dockerfile: containers\/harness\/Containerfile/.test(compose)) return { kind: "build" };
  const m =
    /THERMITE_RIG_HARNESS_CUDA_IMAGE: "\$\{THERMITE_RIG_HARNESS_CUDA_IMAGE:-([^}"\s]+)\}"/.exec(
      compose,
    );
  return m?.[1] ? { kind: "image", fallback: m[1] } : { kind: "unset" };
}

/**
 * compose.gpu.yaml: the harness of the local rig (local-1) on the CUDA image, with every NVIDIA
 * GPU (the first MAX_RIG_GPUS) and the split its broker reads. Docker gets them through the
 * device reservation of NVIDIA's runtime, Podman through the CDI device nvidia.com/gpu, with
 * SELinux labels off as on rigs that control sets up.
 */
export function gpuOverride(engine: EngineName, names: string[], image: HarnessImage): string {
  const n = names.length;
  const plan = localGpuPlan(n);
  const all = plan.use === n;
  const ids = Array.from({ length: plan.use }, (_, i) => String(i));
  const imageLines =
    image.kind === "build"
      ? [
          `    image: ${LOCAL_CUDA_TAG}`,
          "    build:",
          "      args:",
          `        BASE_IMAGE: ${CUDA_BASE_IMAGE}`,
        ]
      : image.kind === "image"
        ? [`    image: "\${THERMITE_RIG_HARNESS_CUDA_IMAGE:-${image.fallback}}"`]
        : [
            `    image: "\${THERMITE_RIG_HARNESS_CUDA_IMAGE:?put THERMITE_RIG_HARNESS_CUDA_IMAGE, the CUDA harness image, in .env}"`,
          ];
  const deviceLines =
    engine === "docker"
      ? [
          "    deploy:",
          "      resources:",
          "        reservations:",
          "          devices:",
          "            - driver: nvidia",
          all
            ? "              count: all"
            : `              device_ids: [${ids.map((i) => `"${i}"`).join(", ")}]`,
          "              capabilities: [gpu]",
        ]
      : [
          "    devices:",
          ...(all ? ["      - nvidia.com/gpu=all"] : ids.map((i) => `      - nvidia.com/gpu=${i}`)),
          "    security_opt:",
          "      - label=disable",
        ];
  return [
    "# Written by thermite local init: the local rig's harness on this machine's NVIDIA GPUs.",
    `# ${gpuWords(names)}. ${splitWords(n)}`,
    `# For ${ENGINE_LABEL[engine]}, through ${engine === "docker" ? "NVIDIA's runtime" : "the CDI spec of NVIDIA's container toolkit"}. Start Thermite with it:`,
    `#   ${upWithGpus(engine)}`,
    "# local init writes this file again each time it runs. Leave it out of up to keep the rig on the CPU.",
    "services:",
    "  harness:",
    ...imageLines,
    "    environment:",
    ...Object.entries(plan.env).map(([k, v]) => `      ${k}: "${v}"`),
    ...deviceLines,
    "",
  ].join("\n");
}

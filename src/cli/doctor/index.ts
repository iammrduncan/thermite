import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { arch, cpus, totalmem } from "node:os";
import { readNumber } from "../../common/settings.ts";
import {
  CDI_GENERATE,
  CDI_SPECS,
  detectOnMachine,
  ENGINE_LABEL,
  type EngineName,
  GPU_OVERRIDE,
  type MachineFacts,
  rigReport,
  upWithGpus,
} from "../machine.ts";
import { CLI_NUMBERS } from "../settings.ts";
import { composeFinding } from "./compose.ts";

/**
 * `thermite doctor`: checks the machine that runs Thermite, where most first-run failures are.
 * It checks the container engine and its compose tool, control's port, free disk, the clock, the
 * GPU driver and NVIDIA's container toolkit where there is a GPU, what the local rig gets (CPUs,
 * memory and GPUs: see machine.ts), and whether control and the model's server answer. Each
 * check says what it found and, when something is wrong, how to fix it, in short plain
 * sentences. Every probe goes through one interface, so each check is tested with stand-ins.
 * Nothing here changes the machine.
 */

export type Status = "ok" | "warn" | "fail" | "skip";

export interface Finding {
  /**
   * A short id: engine, compose, port, disk, clock, gpu-driver, gpu-toolkit, rig, control, model.
   */
  check: string;
  title: string;
  status: Status;
  /** What the check found. */
  said: string;
  /** How to fix it, when the status is warn or fail. */
  fix?: string | undefined;
}

export interface RunResult {
  /** The exit code; null when the program was stopped or did not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program is not on the PATH. */
  missing: boolean;
}

export type HttpResult =
  | { status: number; date?: string | undefined; body: string }
  | { error: string; code?: string | undefined };

/** Everything the checks ask of the machine. */
export interface Probes {
  platform: NodeJS.Platform;
  /** The processor's architecture, as Node names it: x64, arm64. */
  arch: string;
  /** This machine's CPUs and memory, as its own system counts them. */
  cpus: number;
  memBytes: number;
  env: Record<string, string | undefined>;
  cwd: string;
  run(cmd: string, args: string[]): Promise<RunResult>;
  exists(path: string): boolean;
  /** A file's text, or undefined when it cannot be read. */
  readText(path: string): string | undefined;
  /** A folder's entries; none when it cannot be read. */
  list(dir: string): string[];
  /** Free bytes on the file system that holds the path, or undefined when it cannot be read. */
  freeBytes(path: string): number | undefined;
  /** Whether a program listens on the port at 127.0.0.1. */
  portInUse(port: number): Promise<boolean>;
  /** A GET with a time limit. */
  get(url: string): Promise<HttpResult>;
  now(): number;
}

export interface DoctorOptions {
  /** Control's address, such as https://control.example.com. */
  control?: string | undefined;
  /** The model server's address, such as a provider's base URL. */
  modelUrl?: string | undefined;
  /** Control's port on 127.0.0.1. Default: THERMITE_CONTROL_PORT, else 8800. */
  port?: number | undefined;
}

/** Below these, the engine's storage cannot hold Thermite's images and builds. */
export const DISK_FAIL_BYTES = 5e9;
export const DISK_WARN_BYTES = 15e9;
/** Below these, the folder Thermite runs from (its .dev folder, the inbox) is short of room. */
export const FOLDER_FAIL_BYTES = 1e9;
export const FOLDER_WARN_BYTES = 5e9;
/** Control refuses a rig's report dated more than five minutes ahead of its own clock. */
export const CLOCK_FAIL_S = 300;
export const CLOCK_WARN_S = 30;

interface Engine {
  name: EngineName;
  installed: boolean;
  answers: boolean;
  version: string;
  /** Why it does not answer, from its own error. */
  reason: string;
}

const lastLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 300) ?? "";
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
/** A program's own message as the end of a sentence: a full stop unless it has its own. */
const ending = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

// ---------------------------------------------------------------- the container engine

async function probeEngine(p: Probes, name: EngineName): Promise<Engine> {
  const installed = await p.run(name, ["--version"]);
  // A docker command that is Podman's stand-in (podman-docker) is Podman, checked as Podman.
  if (installed.missing || (name === "docker" && /podman/i.test(installed.stdout)))
    return { name, installed: false, answers: false, version: "", reason: "not installed" };
  const info =
    name === "docker"
      ? await p.run("docker", ["info", "--format", "{{.ServerVersion}}"])
      : await p.run("podman", ["info", "--format", "{{.Version.Version}}"]);
  const version = info.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (info.code === 0 && version)
    return { name, installed: true, answers: true, version, reason: "" };
  return {
    name,
    installed: true,
    answers: false,
    version: "",
    reason: lastLine(info.stderr) || lastLine(info.stdout) || `exit ${info.code}`,
  };
}

/** The engines that answer: Docker, Podman, both or neither. */
export async function answeringEngines(p: Probes): Promise<EngineName[]> {
  const engines = [await probeEngine(p, "docker"), await probeEngine(p, "podman")];
  return engines.filter((e) => e.answers).map((e) => e.name);
}

/** How to make an installed engine answer, from the platform and its own error. */
function engineFix(e: Engine, platform: NodeJS.Platform): string {
  if (e.name === "docker") {
    if (platform === "darwin") return "Start Docker Desktop. Then run thermite doctor again.";
    if (/permission denied/i.test(e.reason))
      return "Add your user to the docker group: sudo usermod -aG docker $USER. Then log out and log in again.";
    return "Start the Docker service: sudo systemctl start docker. Then run thermite doctor again.";
  }
  if (platform === "darwin")
    return "Start Podman's virtual machine: podman machine start. If you have none yet, make it first: podman machine init.";
  return "Run podman info to see the full error. Fix it, then run thermite doctor again.";
}

function engineFinding(engines: Engine[], platform: NodeJS.Platform): Finding {
  const title = "Container engine";
  const installed = engines.filter((e) => e.installed);
  const answering = engines.filter((e) => e.answers);
  if (!installed.length)
    return {
      check: "engine",
      title,
      status: "fail",
      said: "No container engine is installed. Neither docker nor podman is on the PATH.",
      fix: "Install Docker with Docker Compose, or Podman with a compose tool. Then run thermite doctor again.",
    };
  const silent = installed.filter((e) => !e.answers);
  const silentText = silent
    .map((e) => `${ENGINE_LABEL[e.name]} is installed, but it does not answer: ${ending(e.reason)}`)
    .join(" ");
  if (!answering.length)
    return {
      check: "engine",
      title,
      status: "fail",
      said: silentText,
      fix: silent.map((e) => engineFix(e, platform)).join(" "),
    };
  return {
    check: "engine",
    title,
    status: "ok",
    said: [
      answering.map((e) => `${ENGINE_LABEL[e.name]} ${e.version} answers.`).join(" "),
      silentText,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// ---------------------------------------------------------------- control's port

async function portFinding(p: Probes, opts: DoctorOptions): Promise<Finding> {
  const title = "Control's port";
  const port = opts.port ?? readNumber(p.env, CLI_NUMBERS.controlPort);
  if (!(await p.portInUse(port)))
    return {
      check: "port",
      title,
      status: "ok",
      said: `Port ${port} on 127.0.0.1 is free for control's dashboard and API.`,
    };
  const health = await p.get(`http://127.0.0.1:${port}/v1/health`);
  if ("status" in health && health.status === 200 && /"ok"\s*:\s*true/.test(health.body))
    return {
      check: "port",
      title,
      status: "ok",
      said: `Control already answers on port ${port}.`,
    };
  const next = port === 8800 ? 8801 : port + 1;
  return {
    check: "port",
    title,
    status: "fail",
    said: `Port ${port} is in use by another program. Control needs this port for its dashboard and API.`,
    fix: `Stop that program. To find it, run lsof -nP -iTCP:${port} -sTCP:LISTEN. Or use another port: put THERMITE_CONTROL_PORT=${next} in a .env file next to compose.yaml. Then run thermite doctor --port ${next}.`,
  };
}

// ---------------------------------------------------------------- disk

interface Place {
  what: string;
  free: number;
  failBelow: number;
  warnBelow: number;
  fix: string;
}

async function enginePlace(p: Probes, e: Engine): Promise<Place | string | undefined> {
  if (e.name === "podman") {
    const info = await p.run("podman", ["info", "--format", "json"]);
    if (info.code !== 0) return undefined;
    let store: { graphRoot?: string; graphRootAllocated?: number; graphRootUsed?: number } = {};
    try {
      store = (JSON.parse(info.stdout) as { store?: typeof store }).store ?? {};
    } catch {
      return undefined;
    }
    const vm = p.platform === "darwin" ? " in its virtual machine" : "";
    const fix =
      p.platform === "darwin"
        ? "Free some space: podman image prune -f removes image layers no image uses. Then give the space back to your Mac: podman machine ssh sudo fstrim -a. Never prune tagged images: they can belong to other projects."
        : "Free some space: podman image prune -f removes image layers no image uses. Never prune tagged images: they can belong to other projects.";
    const { graphRootAllocated: total, graphRootUsed: used } = store;
    let free: number | undefined;
    if (typeof total === "number" && typeof used === "number" && total > 0) free = total - used;
    else if (store.graphRoot && p.platform !== "darwin") free = p.freeBytes(store.graphRoot);
    if (free === undefined) return undefined;
    return {
      what: `for Podman's images${vm}`,
      free,
      failBelow: DISK_FAIL_BYTES,
      warnBelow: DISK_WARN_BYTES,
      fix,
    };
  }
  if (p.platform === "darwin")
    return "Docker Desktop keeps its images on a disk of its own: Settings › Resources shows its size.";
  const root = await p.run("docker", ["info", "--format", "{{.DockerRootDir}}"]);
  const dir = root.code === 0 ? root.stdout.trim() : "";
  const free = dir ? p.freeBytes(dir) : undefined;
  if (free === undefined) return undefined;
  return {
    what: "for Docker's images",
    free,
    failBelow: DISK_FAIL_BYTES,
    warnBelow: DISK_WARN_BYTES,
    fix: "Free some space: docker image prune -f removes image layers no image uses. Never prune tagged images: they can belong to other projects.",
  };
}

async function diskFinding(p: Probes, engines: Engine[]): Promise<Finding> {
  const title = "Disk";
  const places: Place[] = [];
  const notes: string[] = [];
  for (const e of engines.filter((x) => x.answers)) {
    const place = await enginePlace(p, e);
    if (typeof place === "string") notes.push(place);
    else if (place) places.push(place);
  }
  const here = p.freeBytes(p.cwd);
  if (here !== undefined)
    places.push({
      what: "in this folder",
      free: here,
      failBelow: FOLDER_FAIL_BYTES,
      warnBelow: FOLDER_WARN_BYTES,
      fix: "Free some space on this disk, or run Thermite from a folder on another disk.",
    });
  if (!places.length)
    return {
      check: "disk",
      title,
      status: "skip",
      said: ["The free space could not be read.", ...notes].join(" "),
    };
  const said = places.map((x) => `${gb(x.free)} is free ${x.what}.`);
  const failing = places.filter((x) => x.free < x.failBelow);
  const short = places.filter((x) => x.free >= x.failBelow && x.free < x.warnBelow);
  const need = `Thermite's images take about 2 GB, and their builds and the agents' caches need more. Keep ${gb(DISK_WARN_BYTES)} free for the images, and ${gb(FOLDER_WARN_BYTES)} in this folder.`;
  if (failing.length || short.length)
    return {
      check: "disk",
      title,
      status: failing.length ? "fail" : "warn",
      said: [...said, ...notes, need].join(" "),
      fix: [...new Set([...failing, ...short].map((x) => x.fix))].join(" "),
    };
  return { check: "disk", title, status: "ok", said: [...said, ...notes].join(" ") };
}

// ---------------------------------------------------------------- the clock

function clockFix(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "Turn on System Settings › General › Date & Time › Set time and date automatically. If control's clock is the wrong one, fix it on control's machine."
    : "Turn on time sync: sudo timedatectl set-ntp true. If control's clock is the wrong one, fix it on control's machine.";
}

async function clockFinding(p: Probes, opts: DoctorOptions): Promise<Finding> {
  const title = "Clock";
  if (opts.control) {
    const t0 = p.now();
    const r = await p.get(`${opts.control}/v1/health`);
    const t1 = p.now();
    const date = "status" in r && r.date ? Date.parse(r.date) : Number.NaN;
    if (!Number.isFinite(date))
      return {
        check: "clock",
        title,
        status: "skip",
        said: "Control did not answer with its time, so the clocks were not compared. The control check says why.",
      };
    // The Date header counts whole seconds: control's time is half a second later on average.
    const skew = Math.round(((t0 + t1) / 2 - (date + 500)) / 1000);
    const size = Math.abs(skew);
    const way = skew > 0 ? "ahead of" : "behind";
    if (size > CLOCK_FAIL_S)
      return {
        check: "clock",
        title,
        status: "fail",
        said: `This clock is ${size} s ${way} control's. Control refuses a rig's reports from more than ${CLOCK_FAIL_S / 60} minutes ahead, and signed commands carry their time.`,
        fix: clockFix(p.platform),
      };
    if (size > CLOCK_WARN_S)
      return {
        check: "clock",
        title,
        status: "warn",
        said: `This clock is ${size} s ${way} control's. Keep them within ${CLOCK_WARN_S} s.`,
        fix: clockFix(p.platform),
      };
    return {
      check: "clock",
      title,
      status: "ok",
      said: `This clock and control's agree to within ${Math.max(size, 1)} s.`,
    };
  }
  if (p.platform === "linux") {
    const sync = await p.run("timedatectl", ["show", "--property=NTPSynchronized", "--value"]);
    const v = sync.stdout.trim();
    if (sync.code === 0 && v === "yes")
      return {
        check: "clock",
        title,
        status: "ok",
        said: "The system says its clock is synchronized. Give --control to compare it with control's clock.",
      };
    if (sync.code === 0 && v === "no")
      return {
        check: "clock",
        title,
        status: "warn",
        said: "The system says its clock is not synchronized.",
        fix: "Turn on time sync: sudo timedatectl set-ntp true.",
      };
  }
  return {
    check: "clock",
    title,
    status: "skip",
    said: "Give --control to compare this clock with control's clock.",
  };
}

// ---------------------------------------------------------------- the GPU and the local rig

function gpuFindings(p: Probes, m: MachineFacts): Finding[] {
  const driver = "GPU driver";
  const toolkit = "GPU container toolkit";
  if (m.platform !== "linux" || !m.nvidia.present) {
    const said = m.appleSilicon
      ? "Thermite uses NVIDIA GPUs on Linux only: containers on a Mac can't reach its Apple GPU. A CPU rig needs no GPU driver."
      : m.platform === "darwin"
        ? "Thermite uses NVIDIA GPUs on Linux only. A CPU rig needs no GPU driver."
        : m.amd.count
          ? "This machine has no NVIDIA GPU. Its AMD GPUs are not used yet: the Local rig check says why. A CPU rig needs no GPU driver."
          : "This machine has no NVIDIA GPU. A CPU rig needs no GPU driver.";
    return [
      { check: "gpu-driver", title: driver, status: "skip", said },
      {
        check: "gpu-toolkit",
        title: toolkit,
        status: "skip",
        said: "No NVIDIA GPU, so the container toolkit is not needed.",
      },
    ];
  }
  const out: Finding[] = [];
  const smi = m.nvidia.smi;
  const gpus = (smi?.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const driverFix =
    "Install NVIDIA's driver for this GPU. Restart the machine if the install asks you to. Then check that nvidia-smi lists the GPU.";
  if (!smi || smi.missing)
    out.push({
      check: "gpu-driver",
      title: driver,
      status: "fail",
      said: "This machine has an NVIDIA GPU, but nvidia-smi is not installed.",
      fix: driverFix,
    });
  else if (smi.code !== 0 || !gpus.length)
    out.push({
      check: "gpu-driver",
      title: driver,
      status: "fail",
      said: `nvidia-smi fails: ${ending(lastLine(smi.stderr) || lastLine(smi.stdout) || `exit ${smi.code}`)}`,
      fix: driverFix,
    });
  else {
    const names = gpus.map((g) => g.split(",")[0]?.trim() ?? g);
    const version = gpus[0]?.split(",")[1]?.trim() ?? "";
    out.push({
      check: "gpu-driver",
      title: driver,
      status: "ok",
      said: `nvidia-smi lists ${gpus.length} GPU${gpus.length === 1 ? "" : "s"}: ${names.join(", ")}${version ? `. Driver ${version}.` : "."}`,
    });
  }
  const ctk = m.nvidia.toolkit;
  const v = ctk ? /version\s+([0-9][\w.-]*)/i.exec(ctk.stdout)?.[1] : undefined;
  const installed = `NVIDIA's container toolkit${v ? ` ${v}` : ""} is installed`;
  // The engine the rig runs on decides what the toolkit must give it: Docker its runtime,
  // Podman a CDI spec.
  if (m.engine && m.pass && m.pass.ok !== "unchecked") {
    const label = ENGINE_LABEL[m.engine.name];
    out.push(
      m.pass.ok
        ? {
            check: "gpu-toolkit",
            title: toolkit,
            status: "ok",
            said: `${installed}, and ${label} gives containers the GPUs through ${m.pass.how}.`,
          }
        : {
            check: "gpu-toolkit",
            title: toolkit,
            status: "fail",
            said: m.pass.why,
            fix: m.pass.fix,
          },
    );
    return out;
  }
  const spec = CDI_SPECS.find((f) => p.exists(f));
  if (!ctk || ctk.missing || ctk.code !== 0)
    out.push({
      check: "gpu-toolkit",
      title: toolkit,
      status: "fail",
      said: "NVIDIA's container toolkit is not installed. Containers get the GPUs through it.",
      fix: `Install NVIDIA's container toolkit. Then make its CDI spec: ${CDI_GENERATE}. When control sets the rig up on this machine, it can install the toolkit for you.`,
    });
  else if (!spec)
    out.push({
      check: "gpu-toolkit",
      title: toolkit,
      status: "fail",
      said: "NVIDIA's container toolkit is installed, but it has no CDI spec. The CDI spec tells Podman which GPUs there are.",
      fix: `Make the CDI spec: ${CDI_GENERATE}. Make it again after each driver update.`,
    });
  else
    out.push({
      check: "gpu-toolkit",
      title: toolkit,
      status: "ok",
      said: `${installed}, with its CDI spec in ${spec}.`,
    });
  return out;
}

/** What the local rig gets on this machine: CPUs and memory, and the GPUs it can and can't use. */
function rigFinding(m: MachineFacts): Finding {
  const r = rigReport(m);
  const said = [...r.lines];
  if (r.gpus)
    said.push(
      `thermite local init writes ${GPU_OVERRIDE}, which gives them to the rig. Then start Thermite with ${upWithGpus(r.gpus.engine)}.`,
    );
  return {
    check: "rig",
    title: "Local rig",
    status: r.status,
    said: said.join(" "),
    fix: r.fix,
  };
}

// ---------------------------------------------------------------- control and the model

/** What a failed request means, and how to fix it, in words. */
function unreachable(
  r: { error: string; code?: string | undefined },
  url: URL,
  start: string,
): { said: string; fix: string } {
  const code = r.code ?? "";
  if (code === "ECONNREFUSED")
    return {
      said: `Nothing listens at ${url.host}.`,
      fix: `${start} Or check the address and its port.`,
    };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return {
      said: `The name ${url.hostname} does not resolve.`,
      fix: "Check the address. Check this machine's DNS.",
    };
  if (code === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")
    return {
      said: `${url.host} did not answer in 10 s.`,
      fix: "Check that a firewall lets this machine reach that address and port.",
    };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/i.test(code))
    return {
      said: `Its TLS certificate is not trusted here (${code}).`,
      fix: "Give the server a certificate that this machine trusts.",
    };
  return {
    said: `The request failed: ${ending(`${r.error}${code ? ` (${code})` : ""}`)}`,
    fix: "Check the address and this machine's network.",
  };
}

function parseUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

async function controlFinding(p: Probes, opts: DoctorOptions): Promise<Finding> {
  const title = "Control";
  if (!opts.control)
    return {
      check: "control",
      title,
      status: "skip",
      said: "Give --control with control's address to check that this machine reaches control.",
    };
  const url = parseUrl(opts.control);
  if (!url)
    return {
      check: "control",
      title,
      status: "fail",
      said: `${opts.control} is not an http or https address.`,
      fix: "Give control's address, such as https://control.example.com or http://127.0.0.1:8800.",
    };
  if (url.hostname === "control")
    return {
      check: "control",
      title,
      status: "fail",
      said: "control is control's name inside the compose stack. It does not resolve on this machine.",
      fix: "From this machine, give http://127.0.0.1:8800, or control's address for rigs.",
    };
  const r = await p.get(`${opts.control}/v1/health`);
  if ("error" in r) {
    const u = unreachable(r, url, "Start control.");
    return { check: "control", title, status: "fail", ...u };
  }
  if (r.status === 200 && /"ok"\s*:\s*true/.test(r.body))
    return { check: "control", title, status: "ok", said: `Control answers at ${opts.control}.` };
  // Control, not well yet: it starts, or one of its loops is late (goal 173).
  if (r.status === 503 && /"ok"\s*:\s*false/.test(r.body))
    return {
      check: "control",
      title,
      status: "fail",
      said: `Control answers at ${opts.control}, but ${/"starting"\s*:\s*true/.test(r.body) ? "it is still starting" : "one of its loops is late"}: /v1/health answered HTTP 503.`,
      fix: "Wait for it to start; else read its /v1/health and its log (Troubleshoot: A part that is unhealthy).",
    };
  return {
    check: "control",
    title,
    status: "fail",
    said: `A server answers at ${opts.control}, but it is not Thermite's control: /v1/health answered HTTP ${r.status}.`,
    fix: "Check the address. Give control's base address, such as https://control.example.com, without /ui.",
  };
}

async function modelFinding(p: Probes, opts: DoctorOptions): Promise<Finding> {
  const title = "Model server";
  if (!opts.modelUrl)
    return {
      check: "model",
      title,
      status: "skip",
      said: "Give --model-url with your model provider's address to check that this machine reaches it.",
    };
  const url = parseUrl(opts.modelUrl);
  if (!url)
    return {
      check: "model",
      title,
      status: "fail",
      said: `${opts.modelUrl} is not an http or https address.`,
      fix: "Give the provider's base URL, the same address as on Settings › Providers.",
    };
  // The containers' name for this machine: from the machine itself, that is 127.0.0.1.
  let note = "";
  if (url.hostname === "host.docker.internal" || url.hostname === "host.containers.internal") {
    note = ` ${url.hostname} is this machine as the containers see it, so it was checked at 127.0.0.1.`;
    url.hostname = "127.0.0.1";
  }
  const r = await p.get(url.toString());
  if ("error" in r) {
    const u = unreachable(r, url, "Start the model server.");
    return { check: "model", title, status: "fail", said: `${u.said}${note}`, fix: u.fix };
  }
  return {
    check: "model",
    title,
    status: "ok",
    said: `The model server answers at ${opts.modelUrl} (HTTP ${r.status}).${note} The rig's Model route check tests the model itself.`,
  };
}

// ---------------------------------------------------------------- all of it

/** Every check, in the order a first install meets them. */
export async function doctor(p: Probes, opts: DoctorOptions = {}): Promise<Finding[]> {
  const engines = [await probeEngine(p, "docker"), await probeEngine(p, "podman")];
  const machine = await detectOnMachine(
    p,
    engines.filter((e) => e.answers).map((e) => e.name),
  );
  return [
    engineFinding(engines, p.platform),
    await composeFinding(p, engines),
    await portFinding(p, opts),
    await diskFinding(p, engines),
    await clockFinding(p, opts),
    ...gpuFindings(p, machine),
    rigFinding(machine),
    await controlFinding(p, opts),
    await modelFinding(p, opts),
  ];
}

/** 1 when a check failed, else 0: warnings and skipped checks do not fail the machine. */
export const doctorExit = (findings: Finding[]) =>
  findings.some((f) => f.status === "fail") ? 1 : 0;

const MARK: Record<Status, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL", skip: "skip" };

/** The report as text: one block per check, then a summary line. */
export function formatReport(findings: Finding[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${MARK[f.status]}  ${f.title}: ${f.said}`);
    if (f.fix && (f.status === "fail" || f.status === "warn")) lines.push(`      Fix: ${f.fix}`);
  }
  const failed = findings.filter((f) => f.status === "fail").length;
  const warned = findings.filter((f) => f.status === "warn").length;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  lines.push("");
  lines.push(
    failed
      ? `${count(failed, "check failed", "checks failed")}, ${count(warned, "warning", "warnings")}. Fix the failures, then run thermite doctor again.`
      : `No check failed. ${count(warned, "warning", "warnings")}.`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- the real machine

export function machineProbes(): Probes {
  return {
    platform: process.platform,
    arch: arch(),
    cpus: cpus().length,
    memBytes: totalmem(),
    env: process.env,
    cwd: process.cwd(),
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
          (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
            resolve({
              code: e ? (typeof e.code === "number" ? e.code : null) : 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? "") || (e && typeof e.code !== "number" ? e.message : ""),
              missing: e?.code === "ENOENT",
            });
          },
        );
      }),
    exists: (path) => existsSync(path),
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    freeBytes: (path) => {
      try {
        const s = statfsSync(path);
        return s.bavail * s.bsize;
      } catch {
        return undefined;
      }
    },
    portInUse: (port) =>
      new Promise((resolve) => {
        // A program that answers a connection listens there. Then also try to listen: a program
        // bound to every address may not take connections on 127.0.0.1.
        const sock = connect({ host: "127.0.0.1", port });
        sock.setTimeout(1500);
        let tried = false;
        const listen = () => {
          sock.destroy();
          if (tried) return;
          tried = true;
          const srv = createServer();
          srv.once("error", () => resolve(true));
          srv.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
            srv.close(() => resolve(false)),
          );
        };
        sock.once("connect", () => {
          sock.destroy();
          resolve(true);
        });
        sock.once("timeout", listen);
        sock.once("error", listen);
      }),
    get: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
        const body = (await res.text()).slice(0, 2000);
        return { status: res.status, date: res.headers.get("date") ?? undefined, body };
      } catch (err) {
        const e = err as Error & { cause?: { code?: string; message?: string } };
        return {
          error: e.cause?.message ?? e.message,
          code: e.cause?.code ?? (e.name === "TimeoutError" ? "TimeoutError" : undefined),
        };
      }
    },
    now: () => Date.now(),
  };
}

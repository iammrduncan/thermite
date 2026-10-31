import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Probes, RunResult } from "../../src/cli/doctor/index.ts";
import {
  CDI_GENERATE,
  CUDA_BASE_IMAGE,
  detectInContainer,
  detectOnMachine,
  type EngineName,
  gpuOverride,
  harnessImageFrom,
  LOCAL_CUDA_TAG,
  localGpuPlan,
  rigReport,
} from "../../src/cli/machine.ts";
import { effectiveGpuLists } from "../../src/harness/broker/devices.ts";
import { COMPOSE_NEEDS, placeholders, render } from "../../src/release/bundle.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * Stand-ins for the machine: programs by their command line (a program not listed is not
 * installed), files that exist, files' text and folders' entries.
 */
interface Machine {
  platform?: NodeJS.Platform;
  arch?: string;
  cpus?: number;
  memBytes?: number;
  cmds?: Record<string, Partial<RunResult>>;
  files?: string[];
  texts?: Record<string, string>;
  dirs?: Record<string, string[]>;
}

function probes(m: Machine): Probes & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    platform: m.platform ?? "linux",
    arch: m.arch ?? "x64",
    cpus: m.cpus ?? 32,
    memBytes: m.memBytes ?? 128e9,
    env: {},
    cwd: "/home/me/thermite",
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      ran.push(line);
      const r = m.cmds?.[line];
      if (!r) return { code: null, stdout: "", stderr: "", missing: true };
      return { code: 0, stdout: "", stderr: "", missing: false, ...r };
    },
    exists: (path) => (m.files ?? []).includes(path),
    readText: (path) => m.texts?.[path],
    list: (dir) => m.dirs?.[dir] ?? [],
    freeBytes: () => undefined,
    portInUse: async () => false,
    get: async () => ({ error: "no network here" }),
    now: () => 0,
  };
}

const dockerInfo = (over: Record<string, unknown> = {}) => ({
  "docker info --format {{json .}}": {
    stdout: JSON.stringify({
      NCPU: 32,
      MemTotal: 134e9,
      OperatingSystem: "Ubuntu 24.04.1 LTS",
      Runtimes: { runc: { path: "runc" }, "io.containerd.runc.v2": { path: "runc" } },
      ...over,
    }),
  },
});
const withNvidiaRuntime = dockerInfo({
  Runtimes: { runc: { path: "runc" }, nvidia: { path: "nvidia-container-runtime" } },
});
const podmanInfo = (cpus: number, mem: number) => ({
  "podman info --format json": { stdout: JSON.stringify({ host: { cpus, memTotal: mem } }) },
});
const smi = (...names: string[]) => ({
  "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader": {
    stdout: names.map((n) => `${n}, 550.54.15\n`).join(""),
  },
});
const ctk = { "nvidia-ctk --version": { stdout: "NVIDIA Container Toolkit CLI version 1.17.3\n" } };
const nvidiaFiles = ["/dev/nvidia0", "/proc/driver/nvidia/gpus"];
const RTX = "NVIDIA GeForce RTX 4090";

const on = (m: Machine, engines: EngineName[], prefer?: EngineName) =>
  detectOnMachine(probes(m), engines, prefer);

/** The harness's settings in an override, as compose would give them to the container. */
function overrideEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of text.matchAll(/^ {6}(THERMITE_[A-Z_]+): "([^"]*)"$/gm))
    env[m[1] as string] = m[2] as string;
  return env;
}

describe("what the local rig gets", () => {
  test("Linux, Docker with NVIDIA's runtime: every CPU, all memory and both GPUs", async () => {
    const m = await on(
      { files: nvidiaFiles, cmds: { ...withNvidiaRuntime, ...smi(RTX, RTX), ...ctk } },
      ["docker"],
    );
    assert.deepEqual(m.pass, { ok: true, how: "NVIDIA's runtime" });
    const r = rigReport(m);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.gpus, { engine: "docker", names: [RTX, RTX] });
    assert.deepEqual(r.lines, [
      "Docker gives containers this machine's 32 CPUs and 134.0 GB of memory. The stack sets no limits, so the rig can use all of them.",
      `The rig can also have the 2 NVIDIA GPUs (${RTX} ×2): Docker gives them to containers through NVIDIA's runtime. The judge gets 1, the agents 1.`,
    ]);
  });

  test("one GPU reads as one: its GPU, given to containers as it, shared", async () => {
    const r = rigReport(
      await on({ files: nvidiaFiles, cmds: { ...withNvidiaRuntime, ...smi(RTX), ...ctk } }, [
        "docker",
      ]),
    );
    assert.equal(
      r.lines[1],
      `The rig can also have its NVIDIA GPU (${RTX}): Docker gives it to containers through NVIDIA's runtime. The judge and the agents share it.`,
    );
  });

  test("Docker without NVIDIA's runtime keeps the CPU rig, and says how to register it", async () => {
    const noRuntime = rigReport(
      await on({ files: nvidiaFiles, cmds: { ...dockerInfo(), ...smi(RTX), ...ctk } }, ["docker"]),
    );
    assert.equal(noRuntime.status, "warn");
    assert.equal(noRuntime.gpus, undefined);
    assert.equal(
      noRuntime.lines[1],
      `This machine has 1 NVIDIA GPU (${RTX}), but the rig can't have it yet: Docker has no NVIDIA runtime, which gives containers the GPUs. So it uses the CPU.`,
    );
    assert.equal(
      noRuntime.fix,
      "Register NVIDIA's runtime with Docker: sudo nvidia-ctk runtime configure --runtime=docker, then sudo systemctl restart docker. Then run thermite local init again.",
    );
    const noToolkit = rigReport(
      await on({ files: nvidiaFiles, cmds: { ...dockerInfo(), ...smi(RTX) } }, ["docker"]),
    );
    assert.match(noToolkit.lines[1] ?? "", /NVIDIA's container toolkit is not installed/);
    assert.match(noToolkit.fix ?? "", /^Install NVIDIA's container toolkit\. Then register/);
  });

  test("Podman: the GPUs through a CDI spec, found as a file or by nvidia-ctk; none without one", async () => {
    const podman = { ...podmanInfo(64, 256e9), ...smi(RTX, RTX, RTX, RTX), ...ctk };
    const spec = await on({ files: [...nvidiaFiles, "/etc/cdi/nvidia.yaml"], cmds: podman }, [
      "podman",
    ]);
    assert.deepEqual(spec.pass, { ok: true, how: "the CDI spec in /etc/cdi/nvidia.yaml" });
    assert.match(rigReport(spec).lines[1] ?? "", /The judge gets 1, the agents 3\.$/);
    const listed = await on(
      {
        files: nvidiaFiles,
        cmds: {
          ...podman,
          "nvidia-ctk cdi list": {
            stdout: "nvidia.com/gpu=0\nnvidia.com/gpu=1\nnvidia.com/gpu=all\n",
          },
        },
      },
      ["podman"],
    );
    assert.equal(listed.pass?.ok, true);
    const none = rigReport(await on({ files: nvidiaFiles, cmds: podman }, ["podman"]));
    assert.equal(none.status, "warn");
    assert.match(none.lines[1] ?? "", /has no CDI spec, which tells Podman which GPUs there are/);
    assert.equal(
      none.fix,
      `Make the CDI spec: ${CDI_GENERATE}. Make it again after each driver update. Then run thermite local init again.`,
    );
  });

  test("with both engines, the rig runs on the one that can pass the GPUs, unless one is named", async () => {
    const both = {
      files: [...nvidiaFiles, "/var/run/cdi/nvidia.yaml"],
      cmds: { ...dockerInfo(), ...podmanInfo(32, 128e9), ...smi(RTX), ...ctk },
    };
    const auto = await on(both, ["docker", "podman"]);
    assert.equal(auto.engine?.name, "podman");
    assert.equal(rigReport(auto).gpus?.engine, "podman");
    // The other engine's CPUs and memory are said too.
    assert.equal(
      rigReport(auto).lines[1],
      "With Docker instead, the rig gets 32 CPUs and 134.0 GB of memory.",
    );
    const named = await on(both, ["docker", "podman"], "docker");
    assert.equal(named.engine?.name, "docker");
    assert.equal(rigReport(named).status, "warn");
    // Without GPUs, Docker comes first.
    assert.equal(
      (await on({ cmds: { ...dockerInfo(), ...podmanInfo(8, 8e9) } }, ["docker", "podman"])).engine
        ?.name,
      "docker",
    );
  });

  test("an NVIDIA GPU that nvidia-smi does not list keeps the CPU rig", async () => {
    const r = rigReport(
      await on(
        {
          files: ["/dev/nvidia0"],
          cmds: {
            ...withNvidiaRuntime,
            "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader": {
              code: 9,
              stderr: "NVIDIA-SMI has failed\n",
            },
          },
        },
        ["docker"],
      ),
    );
    assert.equal(r.status, "warn");
    assert.equal(r.gpus, undefined);
    assert.match(r.lines[1] ?? "", /nvidia-smi does not list it, so the rig can't have it/);
    assert.match(r.fix ?? "", /GPU driver check of thermite doctor/);
  });

  test("AMD GPUs are found and named, and the rig does not get them yet", async () => {
    const m = await on(
      {
        cmds: {
          ...dockerInfo(),
          lspci: {
            stdout: [
              "00:02.0 Host bridge: Intel Corporation Device 1234",
              "03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX]",
              "04:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX]",
            ].join("\n"),
          },
        },
        dirs: { "/sys/class/drm": ["card0", "card0-DP-1", "card1", "renderD128", "version"] },
        texts: {
          "/sys/class/drm/card0/device/vendor": "0x1002\n",
          "/sys/class/drm/card1/device/vendor": "0x1002\n",
        },
        files: ["/dev/kfd"],
      },
      ["docker"],
    );
    assert.equal(m.nvidia.present, false);
    assert.equal(m.amd.count, 2);
    const r = rigReport(m);
    assert.equal(r.status, "ok");
    assert.equal(r.gpus, undefined);
    assert.equal(
      r.lines[1],
      "This machine has 2 AMD GPUs (Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX] ×2). The rig does not get them: Thermite's GPU images are built on CUDA, which runs on NVIDIA GPUs only, and AMD GPUs need a ROCm image, which Thermite does not have yet.",
    );
    // Only /dev/kfd, no lspci: one AMD GPU, without a name.
    const kfd = rigReport(await on({ cmds: dockerInfo(), files: ["/dev/kfd"] }, ["docker"]));
    assert.match(kfd.lines[1] ?? "", /^This machine has 1 AMD GPU\. The rig does not get it:/);
  });

  test("a Mac with Apple silicon: the virtual machine's CPUs and memory, and no Apple GPU", async () => {
    const mac: Machine = {
      platform: "darwin",
      arch: "arm64",
      cpus: 14,
      memBytes: 36 * 2 ** 30,
      cmds: podmanInfo(7, 8 * 2 ** 30),
    };
    const m = await on(mac, ["podman"]);
    assert.equal(m.nvidia.present, false);
    assert.equal(m.appleSilicon, true);
    const r = rigReport(m);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.lines, [
      "Podman's virtual machine has 7 CPUs and 8.6 GB of memory, and the rig can use all of them. This Mac has 14 CPUs and 38.7 GB. To give it more, stop it and set them: podman machine stop, then podman machine set --cpus 14 --memory 18432, then podman machine start.",
      "This Mac has Apple silicon. Containers on macOS run in a Linux virtual machine, which can't reach the Apple GPU (Metal), so MLX-style work can't run in a rig yet. The rig gets the virtual machine's CPUs and memory, not the GPU.",
    ]);
    // nvidia-smi, lspci and the toolkit are never asked on a Mac.
    const p = probes(mac);
    await detectOnMachine(p, ["podman"]);
    assert.deepEqual(p.ran, ["podman info --format json"]);
    const docker = rigReport(
      await on(
        {
          ...mac,
          cmds: dockerInfo({ NCPU: 14, MemTotal: 36 * 2 ** 30, OperatingSystem: "Docker Desktop" }),
        },
        ["docker"],
      ),
    );
    assert.match(docker.lines[0] ?? "", /^Docker's virtual machine has 14 CPUs and 38\.7 GB/);
    assert.doesNotMatch(docker.lines[0] ?? "", /To give it more/);
    const intel = rigReport(await on({ ...mac, arch: "x64" }, ["podman"]));
    assert.equal(intel.lines.length, 1);
  });

  test("Linux without a GPU, and a machine where no engine answers", async () => {
    const cpu = rigReport(await on({ cmds: podmanInfo(8, 16e9) }, ["podman"]));
    assert.deepEqual(cpu, {
      status: "ok",
      lines: [
        "Podman gives containers this machine's 8 CPUs and 16.0 GB of memory. The stack sets no limits, so the rig can use all of them.",
      ],
      fix: undefined,
      gpus: undefined,
    });
    const none = rigReport(await on({ files: nvidiaFiles, cmds: smi(RTX) }, []));
    assert.equal(none.status, "skip");
    assert.deepEqual(none.lines, [
      "No container engine answers, so what the rig gets was not checked.",
    ]);
    const silent = rigReport(
      await on({ cmds: { "docker info --format {{json .}}": { stdout: "{}" } } }, ["docker"]),
    );
    assert.match(silent.lines[0] ?? "", /^Docker did not say how many CPUs/);
  });

  test("inside the release's init container: the driver's GPUs, with the toolkit not checked", async () => {
    const box: Machine = {
      cpus: 24,
      memBytes: 96e9,
      files: ["/run/.containerenv"],
      dirs: { "/proc/driver/nvidia/gpus": ["0000:41:00.0", "0000:01:00.0"] },
      texts: {
        "/proc/driver/nvidia/gpus/0000:01:00.0/information": `Model: \t\t ${RTX}\nIRQ: 120\nDevice Minor: \t 0\n`,
        "/proc/driver/nvidia/gpus/0000:41:00.0/information":
          "Model: \t\t NVIDIA L4\nDevice Minor: 1\n",
      },
    };
    const m = await detectInContainer(probes(box), "podman");
    assert.deepEqual(m.nvidia.names, [RTX, "NVIDIA L4"]);
    const r = rigReport(m);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.gpus, { engine: "podman", names: [RTX, "NVIDIA L4"] });
    assert.deepEqual(r.lines, [
      "The containers have 24 CPUs and 96.0 GB of memory (on a Mac, the virtual machine's), and the stack sets no limits, so the rig can use all of them.",
      `The rig can also have the 2 NVIDIA GPUs (${RTX}, NVIDIA L4). The judge gets 1, the agents 1. That needs NVIDIA's container toolkit and its CDI spec, which can't be checked from inside a container: run thermite doctor on the machine to check it.`,
    ]);
    const cpu = rigReport(await detectInContainer(probes({}), "docker"));
    assert.equal(cpu.lines.length, 1);
    assert.equal(cpu.gpus, undefined);
  });
});

describe("compose.gpu.yaml", () => {
  test("the split: one GPU shared; then the judge one and the agents up to 8; at most 16", () => {
    const cases: [number, string, string | undefined][] = [
      [1, "0", undefined],
      [2, "0", "1"],
      [4, "0", "1,2,3"],
      [9, "0", "1,2,3,4,5,6,7,8"],
      [10, "0,1", "2,3,4,5,6,7,8,9"],
      [16, "0,1,2,3,4,5,6,7", "8,9,10,11,12,13,14,15"],
      [20, "0,1,2,3,4,5,6,7", "8,9,10,11,12,13,14,15"],
    ];
    for (const [n, judge, dev] of cases) {
      const plan = localGpuPlan(n);
      assert.equal(plan.env.THERMITE_TARGET, "cuda-gpu");
      // The broker reads the override's settings as it reads a rig's that control set up.
      const lists = effectiveGpuLists(plan.env);
      assert.equal(lists.judge, judge, `${n} GPUs: the judge's`);
      assert.equal(lists.dev, dev, `${n} GPUs: the agents'`);
    }
    assert.deepEqual(localGpuPlan(1).env, { THERMITE_TARGET: "cuda-gpu", THERMITE_GPU_INDEX: "0" });
  });

  test("for Docker: the release's CUDA harness, every GPU through NVIDIA's runtime", () => {
    const image = {
      kind: "image" as const,
      fallback: "ghcr.io/example/thermite-harness@sha256:abc",
    };
    assert.equal(
      gpuOverride("docker", [RTX, RTX], image),
      `# Written by thermite local init: the local rig's harness on this machine's NVIDIA GPUs.
# 2 NVIDIA GPUs (${RTX} ×2). The judge gets 1, the agents 1.
# For Docker, through NVIDIA's runtime. Start Thermite with it:
#   docker compose -f compose.yaml -f compose.gpu.yaml up -d
# local init writes this file again each time it runs. Leave it out of up to keep the rig on the CPU.
services:
  harness:
    image: "\${THERMITE_RIG_HARNESS_CUDA_IMAGE:-ghcr.io/example/thermite-harness@sha256:abc}"
    environment:
      THERMITE_TARGET: "cuda-gpu"
      THERMITE_GPUS: "0,1"
      THERMITE_JUDGE_GPUS: "1"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
`,
    );
  });

  test("for Podman: the CDI device for every GPU, with SELinux labels off", () => {
    const text = gpuOverride("podman", ["NVIDIA L4"], { kind: "unset" });
    assert.match(text, /^# For Podman, through the CDI spec of NVIDIA's container toolkit\./m);
    assert.match(text, /^# {3}podman compose -f compose\.yaml -f compose\.gpu\.yaml up -d$/m);
    assert.match(
      text,
      /\n {4}devices:\n {6}- nvidia\.com\/gpu=all\n {4}security_opt:\n {6}- label=disable\n$/,
    );
    assert.deepEqual(overrideEnv(text), { THERMITE_TARGET: "cuda-gpu", THERMITE_GPU_INDEX: "0" });
    // No image named anywhere: compose stops with a message that says which setting to set.
    assert.match(
      text,
      /image: "\$\{THERMITE_RIG_HARNESS_CUDA_IMAGE:\?put THERMITE_RIG_HARNESS_CUDA_IMAGE, the CUDA harness image, in \.env\}"/,
    );
    assert.doesNotMatch(text, /deploy:/);
  });

  test("more GPUs than a rig takes: the first 16, by number", () => {
    const names = Array.from({ length: 20 }, () => "NVIDIA H100 80GB HBM3");
    const docker = gpuOverride("docker", names, { kind: "unset" });
    assert.match(docker, /device_ids: \["0", "1", .*, "15"\]\n/);
    assert.doesNotMatch(docker, /count: all/);
    assert.match(docker, /A rig takes at most 16 GPUs, so it gets the first 16\./);
    const podman = gpuOverride("podman", names, { kind: "unset" });
    assert.equal((podman.match(/- nvidia\.com\/gpu=\d+$/gm) ?? []).length, 16);
    assert.doesNotMatch(podman, /gpu=all/);
    assert.deepEqual(overrideEnv(podman), {
      THERMITE_TARGET: "cuda-gpu",
      THERMITE_GPUS: "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15",
      THERMITE_JUDGE_GPUS: "8",
    });
  });

  test("the image: the release's CUDA harness, or a checkout's build on the CUDA base", () => {
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const release = render(
      read("containers/release/compose.template.yaml"),
      placeholders({
        version: "0.1.0",
        registry: "ghcr.io/example",
        repoUrl: "https://github.com/example/thermite",
        digests: {
          control: digest("a"),
          harness: digest("b"),
          "harness-cuda": digest("c"),
          "harness-cuda13": digest("f"),
          supervisor: digest("d"),
          "rig-cuda": digest("e"),
        },
      }),
      COMPOSE_NEEDS,
    );
    assert.deepEqual(harnessImageFrom(release), {
      kind: "image",
      fallback: `ghcr.io/example/thermite-harness@${digest("c")}`,
    });
    const checkout = harnessImageFrom(read("compose.yaml"));
    assert.deepEqual(checkout, { kind: "build" });
    assert.match(
      gpuOverride("docker", [RTX], checkout),
      new RegExp(
        `\n {4}image: ${LOCAL_CUDA_TAG}\n {4}build:\n {6}args:\n {8}BASE_IMAGE: ${CUDA_BASE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`,
      ),
    );
    assert.deepEqual(harnessImageFrom(undefined), { kind: "unset" });
    // The CUDA base a checkout builds on is the one the release workflow builds the image on.
    assert.match(
      read(".github/workflows/release.yml"),
      new RegExp(`CUDA_BASE_IMAGE: ${CUDA_BASE_IMAGE}\n`),
    );
  });

  test("a GPU's name stays on its comment line", () => {
    const text = gpuOverride("docker", ["NVIDIA\nservices:\n  evil: {}"], { kind: "unset" });
    assert.match(text, /^# 1 NVIDIA GPU \(NVIDIAservices: {2}evil: \{\}\)\. /m);
    assert.equal((text.match(/^services:$/gm) ?? []).length, 1);
  });
});

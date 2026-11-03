import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
  type DoctorOptions,
  doctor,
  doctorExit,
  type Finding,
  formatReport,
  type HttpResult,
  type Probes,
  type RunResult,
} from "../../src/cli/doctor/index.ts";

/**
 * Stand-ins for the machine: programs by their command line (a program not listed is not
 * installed), files that exist, free bytes by path, busy ports and HTTP answers by URL.
 */
interface Machine {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string>;
  cmds?: Record<string, Partial<RunResult>>;
  files?: string[];
  /** Files' text by path, and folders' entries by path. */
  texts?: Record<string, string>;
  dirs?: Record<string, string[]>;
  free?: Record<string, number>;
  busy?: number[];
  http?: Record<string, HttpResult>;
  now?: number;
}

function probes(m: Machine): Probes & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    platform: m.platform ?? "linux",
    arch: m.arch ?? "x64",
    cpus: 16,
    memBytes: 64e9,
    env: m.env ?? {},
    cwd: "/home/me/thermite",
    run: async (cmd, args) => {
      const r = m.cmds?.[[cmd, ...args].join(" ")];
      if (!r) return { code: null, stdout: "", stderr: "", missing: true };
      return { code: 0, stdout: "", stderr: "", missing: false, ...r };
    },
    exists: (path) => (m.files ?? []).includes(path),
    readText: (path) => m.texts?.[path],
    list: (dir) => m.dirs?.[dir] ?? [],
    freeBytes: (path) => m.free?.[path],
    portInUse: async (port) => (m.busy ?? []).includes(port),
    get: async (url) => {
      asked.push(url);
      return m.http?.[url] ?? { error: "connect ECONNREFUSED", code: "ECONNREFUSED" };
    },
    now: () => m.now ?? Date.parse("2026-10-20T12:00:00Z"),
  };
}

/** Podman 5 on a Mac, its compose tool, 80 GB free in its virtual machine. */
const podmanMac: Record<string, Partial<RunResult>> = {
  "podman --version": { stdout: "podman version 5.2.1\n" },
  "podman info --format {{.Version.Version}}": { stdout: "5.2.1\n" },
  "podman compose version": { stdout: "podman-compose version 1.2.0\n" },
  "podman info --format json": {
    stdout: JSON.stringify({
      host: { cpus: 16, memTotal: 64e9 },
      store: {
        graphRoot: "/var/home/core/.local/share/containers/storage",
        graphRootAllocated: 100e9,
        graphRootUsed: 20e9,
      },
    }),
  },
};

/** Docker on Linux with its compose plugin and 50 GB free where it keeps images. */
const dockerLinux: Record<string, Partial<RunResult>> = {
  "docker --version": { stdout: "Docker version 27.3.1, build ce12230\n" },
  "docker info --format {{.ServerVersion}}": { stdout: "27.3.1\n" },
  "docker compose version --short": { stdout: "2.29.7\n" },
  "docker info --format {{.DockerRootDir}}": { stdout: "/var/lib/docker\n" },
};

const one = (findings: Finding[], check: string) => {
  const f = findings.find((x) => x.check === check);
  assert.ok(f, `no ${check} finding`);
  return f;
};

async function check(m: Machine, id: string, opts: DoctorOptions = {}) {
  return one(await doctor(probes(m), opts), id);
}

describe("thermite doctor", () => {
  test("a Mac with Podman, its compose tool, a free port and room on disk passes", async () => {
    const findings = await doctor(
      probes({ platform: "darwin", cmds: podmanMac, free: { "/home/me/thermite": 200e9 } }),
    );
    assert.deepEqual(
      findings.map((f) => [f.check, f.status]),
      [
        ["engine", "ok"],
        ["compose", "ok"],
        ["port", "ok"],
        ["disk", "ok"],
        ["clock", "skip"],
        ["gpu-driver", "skip"],
        ["gpu-toolkit", "skip"],
        ["rig", "ok"],
        ["control", "skip"],
        ["model", "skip"],
      ],
    );
    assert.equal(doctorExit(findings), 0);
    const text = formatReport(findings);
    assert.match(text, /^ok {4}Container engine: Podman 5\.2\.1 answers\.$/m);
    assert.match(
      text,
      /^ok {4}Disk: 80\.0 GB is free for Podman's images in its virtual machine\./m,
    );
    assert.match(text, /^skip {2}Control: Give --control/m);
    assert.match(text, /\nNo check failed\. 0 warnings\.\n$/);
    assert.doesNotMatch(text, /Fix:/);
  });

  test("container engine: none installed, or installed and silent, says how to start it", async () => {
    const none = await doctor(probes({ free: { "/home/me/thermite": 200e9 } }));
    const engine = one(none, "engine");
    assert.equal(engine.status, "fail");
    assert.match(engine.said, /Neither docker nor podman is on the PATH/);
    assert.match(engine.fix ?? "", /^Install Docker with Docker Compose, or Podman/);
    assert.equal(one(none, "compose").status, "skip");
    assert.equal(doctorExit(none), 1);
    assert.match(formatReport(none), /^FAIL {2}Container engine: .*\n {6}Fix: Install Docker/m);
    assert.match(formatReport(none), /\n1 check failed, 0 warnings\. Fix the failures/);

    const desktopDown = {
      "docker --version": { stdout: "Docker version 27.3.1\n" },
      "docker info --format {{.ServerVersion}}": {
        code: 1,
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      },
    };
    const mac = await check({ platform: "darwin", cmds: desktopDown }, "engine");
    assert.equal(mac.status, "fail");
    assert.match(
      mac.said,
      /Docker is installed, but it does not answer: Cannot connect to the Docker daemon/,
    );
    assert.equal(mac.fix, "Start Docker Desktop. Then run thermite doctor again.");

    const linux = await check({ cmds: desktopDown }, "engine");
    assert.match(linux.fix ?? "", /^Start the Docker service: sudo systemctl start docker\./);
    const denied = await check(
      {
        cmds: {
          ...desktopDown,
          "docker info --format {{.ServerVersion}}": {
            code: 1,
            stderr: "permission denied while trying to connect to the Docker daemon socket\n",
          },
        },
      },
      "engine",
    );
    assert.match(
      denied.fix ?? "",
      /sudo usermod -aG docker \$USER\. Then log out and log in again\./,
    );

    const vmDown = await check(
      {
        platform: "darwin",
        cmds: {
          "podman --version": { stdout: "podman version 5.2.1\n" },
          "podman info --format {{.Version.Version}}": {
            code: 125,
            stderr: "Error: unable to connect to Podman socket: Cannot connect to Podman.\n",
          },
        },
      },
      "engine",
    );
    assert.equal(vmDown.status, "fail");
    assert.match(vmDown.fix ?? "", /^Start Podman's virtual machine: podman machine start\./);

    // One engine is enough: the silent one is named, and the check passes.
    const both = await check(
      { platform: "darwin", cmds: { ...desktopDown, ...podmanMac } },
      "engine",
    );
    assert.equal(both.status, "ok");
    assert.match(
      both.said,
      /^Podman 5\.2\.1 answers\. Docker is installed, but it does not answer/,
    );
    // A docker command that is Podman's stand-in is not a second engine.
    const shim = await check(
      { cmds: { ...podmanMac, "docker --version": { stdout: "podman version 5.2.1\n" } } },
      "engine",
    );
    assert.equal(shim.said, "Podman 5.2.1 answers.");
  });

  test("compose tool: the plugin, a standalone program, or what to install", async () => {
    const plugin = await check({ cmds: dockerLinux }, "compose");
    assert.deepEqual([plugin.status, plugin.said], ["ok", "docker compose 2.29.7 works."]);
    const standalone = await check(
      {
        cmds: {
          ...dockerLinux,
          "docker compose version --short": {
            code: 1,
            stderr: "docker: 'compose' is not a docker command.\n",
          },
          "docker-compose version --short": { stdout: "2.26.1\n" },
        },
      },
      "compose",
    );
    assert.equal(standalone.status, "ok");
    assert.match(
      standalone.said,
      /docker-compose 2\.26\.1 works\. Write docker-compose where the docs say docker compose\./,
    );
    const noProvider = {
      ...podmanMac,
      "podman compose version": {
        code: 125,
        stderr: "Error: looking up compose provider failed\n",
      },
    };
    const none = await check({ platform: "darwin", cmds: noProvider }, "compose");
    assert.equal(none.status, "fail");
    assert.equal(none.said, "No compose tool works with Podman.");
    assert.equal(
      none.fix,
      "Install podman-compose, for example with pipx install podman-compose, or Docker Compose 2 or later. podman compose hands its work to one of them.",
    );
    const pc = await check(
      {
        platform: "darwin",
        cmds: { ...noProvider, "podman-compose version": { stdout: "1.2.0\n" } },
      },
      "compose",
    );
    assert.equal(pc.status, "ok");
    assert.match(pc.said, /Write podman-compose where the docs say docker compose/);
  });

  test("compose tool: docker-compose 1.x can't read Thermite's compose file, so it doesn't count", async () => {
    // Podman on Linux, where podman compose finds the system's docker-compose 1.x first.
    const handedToV1 = {
      ...podmanMac,
      "podman compose version": {
        stdout:
          "docker-compose version 1.29.2, build unknown\ndocker-py version: 5.0.3\nCPython version: 3.12.3\n",
        stderr:
          '>>>> Executing external compose provider "/usr/bin/docker-compose". Please refer to the documentation for details. <<<<\n',
      },
    };
    const v1 = await check({ cmds: handedToV1 }, "compose");
    assert.equal(v1.status, "fail");
    assert.equal(
      v1.said,
      "No compose tool works with Podman. podman compose hands its work to /usr/bin/docker-compose, which is docker-compose 1.29.2. That is Compose v1. It can't read Thermite's compose file.",
    );
    assert.equal(
      v1.fix,
      "Remove docker-compose 1.x, for example with sudo apt remove docker-compose. Then install podman-compose, for example with pipx install podman-compose, or Docker Compose 2 or later. podman compose uses docker-compose first when it is installed.",
    );

    // podman-compose works when it is called by name, but podman compose still picks the 1.x.
    const both = await check(
      { cmds: { ...handedToV1, "podman-compose version": { stdout: "1.5.0\n" } } },
      "compose",
    );
    assert.equal(both.status, "warn");
    assert.match(
      both.said,
      /^podman-compose works\. Write podman-compose where the docs say docker compose\. podman compose hands its work to \/usr\/bin\/docker-compose, which is docker-compose 1\.29\.2\./,
    );
    assert.equal(
      both.fix,
      "Remove docker-compose 1.x, for example with sudo apt remove docker-compose. Then podman compose uses podman-compose. podman compose uses docker-compose first when it is installed.",
    );

    // Docker without its plugin, and only the old standalone program.
    const dockerV1 = await check(
      {
        cmds: {
          ...dockerLinux,
          "docker compose version --short": {
            code: 1,
            stderr: "docker: 'compose' is not a docker command.\n",
          },
          "docker-compose version --short": { stdout: "1.29.2\n" },
        },
      },
      "compose",
    );
    assert.equal(dockerV1.status, "fail");
    assert.equal(
      dockerV1.said,
      "No compose tool works with Docker. docker-compose 1.29.2 is installed. That is Compose v1. It can't read Thermite's compose file.",
    );
    assert.match(
      dockerV1.fix ?? "",
      /^Remove docker-compose 1\.x.*Then install the Docker Compose plugin\./,
    );

    // Docker Compose 2 or later behind podman compose is fine.
    const handedToV2 = await check(
      {
        cmds: {
          ...podmanMac,
          "podman compose version": { stdout: "Docker Compose version v5.1.0\n" },
        },
      },
      "compose",
    );
    assert.deepEqual([handedToV2.status, handedToV2.said], ["ok", "podman compose works."]);
  });

  test("control's port: free, held by control, or taken by another program", async () => {
    const free = await check({}, "port");
    assert.deepEqual(
      [free.status, free.said],
      ["ok", "Port 8800 on 127.0.0.1 is free for control's dashboard and API."],
    );
    const ours = probes({
      busy: [8800],
      http: { "http://127.0.0.1:8800/v1/health": { status: 200, body: '{"ok":true}' } },
    });
    const held = one(await doctor(ours), "port");
    assert.deepEqual([held.status, held.said], ["ok", "Control already answers on port 8800."]);
    const taken = await check(
      {
        busy: [8800],
        http: { "http://127.0.0.1:8800/v1/health": { status: 404, body: "Not Found" } },
      },
      "port",
    );
    assert.equal(taken.status, "fail");
    assert.match(taken.said, /^Port 8800 is in use by another program\./);
    assert.match(taken.fix ?? "", /lsof -nP -iTCP:8800 -sTCP:LISTEN/);
    assert.match(
      taken.fix ?? "",
      /THERMITE_CONTROL_PORT=8801 in a \.env file next to compose\.yaml\. Then run thermite doctor --port 8801\./,
    );
    // The port compose publishes: THERMITE_CONTROL_PORT, unless --port names another.
    const env = await check({ env: { THERMITE_CONTROL_PORT: "9100" }, busy: [8800] }, "port");
    assert.match(env.said, /^Port 9100 on 127\.0\.0\.1 is free/);
    const opt = await check({ env: { THERMITE_CONTROL_PORT: "9100" }, busy: [9200] }, "port", {
      port: 9200,
    });
    assert.equal(opt.status, "fail");
    assert.match(opt.fix ?? "", /THERMITE_CONTROL_PORT=9201/);
  });

  test("disk: too little for the images fails, little warns, each with how to free space", async () => {
    const store = (free: number) =>
      JSON.stringify({ store: { graphRootAllocated: 100e9, graphRootUsed: 100e9 - free } });
    const low = await check(
      {
        platform: "darwin",
        cmds: { ...podmanMac, "podman info --format json": { stdout: store(3e9) } },
        free: { "/home/me/thermite": 200e9 },
      },
      "disk",
    );
    assert.equal(low.status, "fail");
    assert.match(
      low.said,
      /^3\.0 GB is free for Podman's images in its virtual machine\. 200\.0 GB is free in this folder\./,
    );
    assert.match(
      low.fix ?? "",
      /podman image prune -f.*podman machine ssh sudo fstrim -a\. Never prune tagged images/,
    );
    const some = await check(
      {
        platform: "darwin",
        cmds: { ...podmanMac, "podman info --format json": { stdout: store(10e9) } },
        free: { "/home/me/thermite": 200e9 },
      },
      "disk",
    );
    assert.equal(some.status, "warn");
    assert.match(some.said, /Keep 15\.0 GB free for the images, and 5\.0 GB in this folder\./);
    // Docker on Linux: the file system of its root folder.
    const docker = await check(
      { cmds: dockerLinux, free: { "/var/lib/docker": 4e9, "/home/me/thermite": 4e9 } },
      "disk",
    );
    assert.equal(docker.status, "fail");
    assert.match(
      docker.said,
      /^4\.0 GB is free for Docker's images\. 4\.0 GB is free in this folder\./,
    );
    assert.match(docker.fix ?? "", /docker image prune -f/);
    assert.match(docker.fix ?? "", /Free some space on this disk/);
    // Docker Desktop's disk is out of sight: the check says where to look.
    const desktop = await check(
      {
        platform: "darwin",
        cmds: { ...dockerLinux },
        free: { "/home/me/thermite": 0.5e9 },
      },
      "disk",
    );
    assert.equal(desktop.status, "fail");
    assert.match(
      desktop.said,
      /0\.5 GB is free in this folder\. Docker Desktop keeps its images on a disk of its own: Settings › Resources shows its size\./,
    );
    const unread = await check({ platform: "darwin", cmds: podmanMac }, "disk");
    assert.equal(unread.status, "ok", "Podman's own numbers are enough");
  });

  test("clock: compared with control's, or the system's own sync on Linux", async () => {
    const health = (date: string): HttpResult => ({ status: 200, date, body: '{"ok":true}' });
    const at = (date: string) => ({
      now: Date.parse("2026-10-20T12:00:00Z"),
      http: { "https://control.example.com/v1/health": health(date) },
    });
    const opts = { control: "https://control.example.com" };
    const ahead = await check(at("Tue, 20 Oct 2026 11:50:00 GMT"), "clock", opts);
    assert.equal(ahead.status, "fail");
    assert.match(
      ahead.said,
      /^This clock is 600 s ahead of control's\. Control refuses a rig's reports from more than 5 minutes ahead/,
    );
    assert.match(ahead.fix ?? "", /sudo timedatectl set-ntp true/);
    const behind = await check(
      { ...at("Tue, 20 Oct 2026 12:01:00 GMT"), platform: "darwin" },
      "clock",
      opts,
    );
    assert.equal(behind.status, "warn");
    assert.match(behind.said, /^This clock is 60 s behind control's\. Keep them within 30 s\./);
    assert.match(behind.fix ?? "", /Set time and date automatically/);
    const close = await check(at("Tue, 20 Oct 2026 12:00:01 GMT"), "clock", opts);
    assert.deepEqual(
      [close.status, close.said],
      ["ok", "This clock and control's agree to within 1 s."],
    );
    const silent = await check({}, "clock", opts);
    assert.equal(silent.status, "skip");

    const sync = (value: string) => ({
      cmds: { "timedatectl show --property=NTPSynchronized --value": { stdout: `${value}\n` } },
    });
    assert.equal((await check(sync("yes"), "clock")).status, "ok");
    const off = await check(sync("no"), "clock");
    assert.deepEqual(
      [off.status, off.fix],
      ["warn", "Turn on time sync: sudo timedatectl set-ntp true."],
    );
    const mac = await check({ platform: "darwin" }, "clock");
    assert.deepEqual(
      [mac.status, mac.said],
      ["skip", "Give --control to compare this clock with control's clock."],
    );
  });

  test("GPU: the driver and NVIDIA's container toolkit, only where there is an NVIDIA GPU", async () => {
    const smi = "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader";
    const gpus = {
      [smi]: { stdout: "NVIDIA A100-SXM4-80GB, 550.54.15\nNVIDIA A100-SXM4-80GB, 550.54.15\n" },
    };
    const ctk = {
      "nvidia-ctk --version": { stdout: "NVIDIA Container Toolkit CLI version 1.17.3\n" },
    };
    const ready = await doctor(
      probes({ files: ["/dev/nvidia0", "/etc/cdi/nvidia.yaml"], cmds: { ...gpus, ...ctk } }),
    );
    assert.deepEqual(
      [one(ready, "gpu-driver").status, one(ready, "gpu-driver").said],
      [
        "ok",
        "nvidia-smi lists 2 GPUs: NVIDIA A100-SXM4-80GB, NVIDIA A100-SXM4-80GB. Driver 550.54.15.",
      ],
    );
    assert.equal(
      one(ready, "gpu-toolkit").said,
      "NVIDIA's container toolkit 1.17.3 is installed, with its CDI spec in /etc/cdi/nvidia.yaml.",
    );

    const noDriver = await doctor(probes({ files: ["/proc/driver/nvidia/gpus"] }));
    assert.equal(one(noDriver, "gpu-driver").status, "fail");
    assert.match(
      one(noDriver, "gpu-driver").said,
      /has an NVIDIA GPU, but nvidia-smi is not installed/,
    );
    assert.match(one(noDriver, "gpu-driver").fix ?? "", /^Install NVIDIA's driver/);
    const broken = await check(
      {
        files: ["/dev/nvidia0"],
        cmds: {
          [smi]: {
            code: 9,
            stderr:
              "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n",
          },
        },
      },
      "gpu-driver",
    );
    assert.match(broken.said, /^nvidia-smi fails: NVIDIA-SMI has failed/);

    const noToolkit = await check({ files: ["/dev/nvidia0"], cmds: gpus }, "gpu-toolkit");
    assert.equal(noToolkit.status, "fail");
    assert.match(
      noToolkit.fix ?? "",
      /sudo nvidia-ctk cdi generate --output=\/etc\/cdi\/nvidia\.yaml/,
    );
    const noSpec = await check(
      { files: ["/dev/nvidia0"], cmds: { ...gpus, ...ctk } },
      "gpu-toolkit",
    );
    assert.equal(noSpec.status, "fail");
    assert.match(noSpec.said, /installed, but it has no CDI spec/);

    // A GPU the driver does not know yet still shows on the PCI bus.
    const pci = await check(
      {
        cmds: {
          lspci: { stdout: "01:00.0 3D controller: NVIDIA Corporation GA100 [A100 SXM4 80GB]\n" },
        },
      },
      "gpu-driver",
    );
    assert.equal(pci.status, "fail");
    const cpu = await doctor(
      probes({
        cmds: {
          lspci: { stdout: "00:02.0 VGA compatible controller: Intel Corporation UHD 630\n" },
        },
      }),
    );
    assert.equal(one(cpu, "gpu-driver").status, "skip");
    assert.equal(one(cpu, "gpu-toolkit").status, "skip");
    assert.match(one(cpu, "gpu-driver").said, /no NVIDIA GPU\. A CPU rig needs no GPU driver/);
  });

  test("local rig: what it gets, and the toolkit check asks of the engine what it needs", async () => {
    const smi = {
      "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader": {
        stdout: "NVIDIA L4, 550.54.15\nNVIDIA L4, 550.54.15\n",
      },
    };
    const ctk = {
      "nvidia-ctk --version": { stdout: "NVIDIA Container Toolkit CLI version 1.17.3\n" },
    };
    const info = (runtimes: string[]) => ({
      "docker info --format {{json .}}": {
        stdout: JSON.stringify({
          NCPU: 32,
          MemTotal: 128e9,
          Runtimes: Object.fromEntries(runtimes.map((r) => [r, {}])),
        }),
      },
    });
    const ready = await doctor(
      probes({
        files: ["/dev/nvidia0"],
        cmds: { ...dockerLinux, ...info(["runc", "nvidia"]), ...smi, ...ctk },
      }),
    );
    assert.deepEqual(
      [one(ready, "gpu-toolkit").status, one(ready, "gpu-toolkit").said],
      [
        "ok",
        "NVIDIA's container toolkit 1.17.3 is installed, and Docker gives containers the GPUs through NVIDIA's runtime.",
      ],
    );
    const rig = one(ready, "rig");
    assert.equal(rig.status, "ok");
    assert.equal(
      rig.said,
      "Docker gives containers this machine's 32 CPUs and 128.0 GB of memory. The stack sets no limits, so the rig can use all of them. The rig can also have the 2 NVIDIA GPUs (NVIDIA L4 ×2): Docker gives them to containers through NVIDIA's runtime. The judge gets 1, the agents 1. thermite local init writes compose.gpu.yaml, which gives them to the rig. Then start Thermite with docker compose -f compose.yaml -f compose.gpu.yaml up -d.",
    );
    assert.match(formatReport(ready), /^ok {4}Local rig: Docker gives containers/m);

    const noRuntime = await doctor(
      probes({
        files: ["/dev/nvidia0"],
        cmds: { ...dockerLinux, ...info(["runc"]), ...smi, ...ctk },
      }),
    );
    assert.equal(one(noRuntime, "gpu-toolkit").status, "fail");
    assert.match(
      one(noRuntime, "gpu-toolkit").fix ?? "",
      /nvidia-ctk runtime configure --runtime=docker/,
    );
    assert.equal(one(noRuntime, "rig").status, "warn");
    assert.match(
      formatReport(noRuntime),
      /^WARN {2}Local rig: .* but the rig can't have them yet: Docker has no NVIDIA runtime.*\n {6}Fix: Register NVIDIA's runtime with Docker: .* Then run thermite local init again\.$/m,
    );

    // AMD's GPUs are found, and not used.
    const amd = await doctor(
      probes({
        cmds: { ...dockerLinux, ...info(["runc"]) },
        dirs: { "/sys/class/drm": ["card0"] },
        texts: { "/sys/class/drm/card0/device/vendor": "0x1002\n" },
      }),
    );
    assert.match(one(amd, "gpu-driver").said, /Its AMD GPUs are not used yet/);
    assert.match(one(amd, "rig").said, /This machine has 1 AMD GPU\. The rig does not get it/);
    assert.equal(one(amd, "rig").status, "ok");

    // A Mac with Apple silicon: no GPU in the containers.
    const mac = await doctor(probes({ platform: "darwin", arch: "arm64", cmds: podmanMac }));
    assert.match(one(mac, "gpu-driver").said, /can't reach its Apple GPU/);
    assert.match(one(mac, "rig").said, /MLX-style work can't run in a rig yet/);

    // No engine answers: the rig is not checked.
    assert.equal((await check({}, "rig")).status, "skip");
  });

  test("control: answers, nothing listens, the name does not resolve, or another server", async () => {
    const url = "https://control.example.com";
    const answer = (r: HttpResult) => ({ http: { [`${url}/v1/health`]: r } });
    const ok = await check(answer({ status: 200, body: '{"ok":true}' }), "control", {
      control: url,
    });
    assert.deepEqual(
      [ok.status, ok.said],
      ["ok", "Control answers at https://control.example.com."],
    );
    const refused = await check({}, "control", { control: url });
    assert.equal(refused.status, "fail");
    assert.equal(refused.said, "Nothing listens at control.example.com.");
    assert.equal(refused.fix, "Start control. Or check the address and its port.");
    const dns = await check(
      answer({ error: "getaddrinfo ENOTFOUND control.example.com", code: "ENOTFOUND" }),
      "control",
      { control: url },
    );
    assert.equal(dns.said, "The name control.example.com does not resolve.");
    const slow = await check(answer({ error: "aborted", code: "TimeoutError" }), "control", {
      control: url,
    });
    assert.match(slow.fix ?? "", /firewall/);
    const tls = await check(
      answer({ error: "self-signed certificate", code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      "control",
      { control: url },
    );
    assert.match(tls.said, /TLS certificate is not trusted here/);
    const other = await check(answer({ status: 404, body: "Not Found" }), "control", {
      control: url,
    });
    assert.equal(other.status, "fail");
    assert.match(other.said, /not Thermite's control: \/v1\/health answered HTTP 404/);
    // Control itself, not well: one of its loops is late, or it is still starting (goal 173).
    const late = await check(
      answer({
        status: 503,
        body: '{"ok":false,"loops":{"resets":{"late":true}},"bus":"connected"}',
      }),
      "control",
      { control: url },
    );
    assert.equal(late.status, "fail");
    assert.match(
      late.said,
      /answers at .*, but one of its loops is late: \/v1\/health answered HTTP 503/,
    );
    const starting = await check(
      answer({ status: 503, body: '{"ok":false,"bus":"connected","starting":true}' }),
      "control",
      { control: url },
    );
    assert.match(starting.said, /but it is still starting/);
    const inside = await check({}, "control", { control: "http://control:8800" });
    assert.match(inside.said, /control's name inside the compose stack/);
    const bad = await check({}, "control", { control: "control.example.com" });
    assert.match(bad.said, /is not an http or https address/);
  });

  test("model server: any answer is reachable; the containers' name for this machine is 127.0.0.1", async () => {
    const m = probes({ http: { "http://127.0.0.1:11434/v1": { status: 404, body: "" } } });
    const local = one(
      await doctor(m, { modelUrl: "http://host.docker.internal:11434/v1" }),
      "model",
    );
    assert.equal(local.status, "ok");
    assert.ok(m.asked.includes("http://127.0.0.1:11434/v1"));
    assert.match(
      local.said,
      /answers at http:\/\/host\.docker\.internal:11434\/v1 \(HTTP 404\)\. host\.docker\.internal is this machine as the containers see it/,
    );
    const down = await check({}, "model", { modelUrl: "http://127.0.0.1:8000/v1" });
    assert.equal(down.status, "fail");
    assert.equal(down.fix, "Start the model server. Or check the address and its port.");
    assert.equal((await check({}, "model")).status, "skip");
  });

  test("the command: its usage names it, and a bad port is refused before any check", async () => {
    const run = promisify(execFile);
    const cli = join(import.meta.dirname, "../../src/cli/thermite/main.ts");
    const node = (...args: string[]) =>
      run(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args]);
    assert.match(
      (await node("help")).stdout,
      /^ {2}doctor \[--control URL\] \[--model-url URL\] \[--port N\] \[--json\]$/m,
    );
    await assert.rejects(
      node("doctor", "--port", "70000"),
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr ?? "", /--port is a port number from 1 to 65535/);
        return true;
      },
    );
  });
});

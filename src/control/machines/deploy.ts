import { randomBytes } from "node:crypto";
import { redact } from "../../common/env.ts";
import { shellQuote } from "../../common/exec.ts";
import { gpuSplit, MAX_RIG_GPUS } from "../../core/hardware.ts";
import { HEALTH_URLS, healthProbe } from "../../core/health.ts";
import { RIG_ID, RIG_ID_WORDS } from "../../core/ids.ts";
import { HARNESS_INBOX_DIR, SUPERVISOR_INBOX_DIR } from "../../core/paths.ts";

/**
 * A rig on a machine control reaches over SSH, as files and Podman Quadlet units: the same two
 * containers, users, capabilities, networks and volumes as the compose rig, run as systemd
 * services of the machine's user (or the system's, when control logs in as root). Control
 * renders everything here and sends it in one script on standard input; the tokens are inside
 * that script, never on a command line.
 */

export interface RigPlan {
  rig: string;
  /** Control as the rig reaches it. */
  controlUrl: string;
  images: { harness: string; supervisor: string };
  /**
   * The machine's GPU indices the rig uses: none (CPU), one (shared by the judge and the agents)
   * or several: the first judgeGpus for the judge, the rest for the agents' dev runs.
   */
  gpus: number[];
  /** With two or more GPUs, how many are the judge's (default: half, rounded up). */
  judgeGpus?: number | undefined;
  /** Control logs in as root: system units and paths instead of the user's. */
  root: boolean;
  controlPublicKey: string;
  controlFingerprint: string;
  /** The message bus for its supervisor: the one way it reaches control but its registration. */
  bus: RigBus;
}

/**
 * The message bus as a rig control sets up reaches it: its address, and the certificate of
 * control's authority, which the rig trusts the bus's server through (control/bus/tls.ts).
 */
export interface RigBus {
  url: string;
  ca: string;
}

/** Where a rig's supervisor reads the authority's certificate, on a machine as in compose. */
export const SUPERVISOR_BUS_CA = "/keys/bus-ca.pem";

export interface RigSecrets {
  /** The rig's token for control, minted by control at enrollment. */
  controlToken: string;
  /** Shared by the rig's harness and supervisor. */
  harnessSupervisorToken: string;
}

// A rig's GPUs and their split, as control and the command line give them (core/hardware.ts).
export { gpuSplit, MAX_RIG_GPUS };

/** Where the rig's files and units live on the machine. */
export function rigPaths(p: Pick<RigPlan, "rig" | "root">) {
  return p.root
    ? {
        dir: `/var/lib/thermite/rigs/${p.rig}`,
        units: "/etc/containers/systemd",
        unitDir: `/var/lib/thermite/rigs/${p.rig}`,
        systemctl: "systemctl",
      }
    : {
        dir: `$HOME/.local/share/thermite/rigs/${p.rig}`,
        units: "$HOME/.config/containers/systemd",
        // Inside a user unit, %h is the user's home.
        unitDir: `%h/.local/share/thermite/rigs/${p.rig}`,
        systemctl: "systemctl --user",
      };
}

/** A user's systemd needs its runtime directory, which an SSH session may not have set. */
const userSession = (root: boolean) =>
  root
    ? []
    : [
        `if ! env | grep -q '^XDG_RUNTIME_DIR='; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi`,
      ];

export const unitName = (rig: string, part: "harness" | "supervisor") => `thermite-${rig}-${part}`;

/** What a rig's units are made of: the rest of a plan is for its first setup. */
export type UnitPlan = Pick<
  RigPlan,
  "rig" | "controlUrl" | "images" | "gpus" | "judgeGpus" | "root" | "bus"
>;

/** The Quadlet units, by file name. */
export function rigUnits(p: UnitPlan): Record<string, string> {
  const { unitDir } = rigPaths(p);
  const h = unitName(p.rig, "harness");
  const s = unitName(p.rig, "supervisor");
  const net = `thermite-${p.rig}`;
  const egress = `thermite-${p.rig}-egress`;
  const split = gpuSplit(p.gpus.length, p.judgeGpus);
  const gpu = p.gpus.length > 0;
  const env = (pairs: Record<string, string>) =>
    Object.entries(pairs)
      .map(([k, v]) => `Environment=${k}=${v}`)
      .join("\n");
  const secret = (file: string, mode = "ro") =>
    `Volume=${unitDir}/${file}:/run/secrets/${file.split("/").pop()}:${mode},Z`;
  // Each container's log goes to the journal (journalctl --user -u <unit>), within the journal's
  // own size limits and the unit's rate limit below; its health route is checked every 30 s, and
  // a part unhealthy three times running is killed, so that systemd starts it again (goal 173).
  const logAndHealth = (url: string) => `LogDriver=journald
HealthCmd=node -e "${healthProbe(url)}"
HealthInterval=30s
HealthTimeout=10s
HealthRetries=3
HealthStartPeriod=5m
HealthOnFailure=kill`;
  const service = `[Service]
Restart=always
LogRateLimitIntervalSec=30s
LogRateLimitBurst=10000`;
  return {
    [`${net}.network`]: `# Thermite rig ${p.rig}: harness and supervisor only.
[Network]
NetworkName=${net}
Internal=true
`,
    [`${egress}.network`]: `# Thermite rig ${p.rig}: the way out (DNS, the internet, control).
[Network]
NetworkName=${egress}
`,
    [`${h}.container`]: `# Thermite rig ${p.rig}: the harness (judge, agents, broker).
[Unit]
Description=Thermite rig ${p.rig}: harness

[Container]
Image=${p.images.harness}
ContainerName=${h}
${env({
  THERMITE_RIG_ID: p.rig,
  THERMITE_TARGET: gpu ? "cuda-gpu" : "cpu",
  ...split,
  THERMITE_CONTROL_PUBKEY_FILE: "/keys/control-signing.pub",
  THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
})}
Volume=thermite-${p.rig}-state:/var/lib/thermite
Volume=thermite-${p.rig}-scratch:/scratch
Volume=thermite-${p.rig}-inbox:${HARNESS_INBOX_DIR}:ro
Volume=thermite-${p.rig}-outbox:/outbox
Volume=${unitDir}/keys:/keys:ro,Z
${secret("secrets/harness-supervisor-token")}
Network=${net}.network
Network=${egress}.network
DropCapability=ALL
AddCapability=CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID
NoNewPrivileges=true
${p.gpus.map((_, i) => `AddDevice=nvidia.com/gpu=${p.gpus[i]}`).join("\n")}${gpu ? "\nSecurityLabelDisable=true" : ""}
${logAndHealth(HEALTH_URLS.harness)}

${service}

[Install]
WantedBy=default.target
`,
    [`${s}.container`]: `# Thermite rig ${p.rig}: the supervisor (relay to control, git, staging).
[Unit]
Description=Thermite rig ${p.rig}: supervisor
Requires=${h}.service
After=${h}.service

[Container]
Image=${p.images.supervisor}
ContainerName=${s}
${env({
  THERMITE_RIG_ID: p.rig,
  HARNESS_URL: `http://${h}:8700`,
  CONTROL_URL: p.controlUrl.replace(/\/$/, ""),
  THERMITE_HARNESS_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
  THERMITE_CONTROL_TOKEN_FILE: "/run/secrets/control-rig-token",
  THERMITE_NATS_URL: p.bus.url,
  THERMITE_NATS_CA_FILE: SUPERVISOR_BUS_CA,
})}
Volume=thermite-${p.rig}-supervisor:/var/lib/thermite-supervisor
Volume=thermite-${p.rig}-inbox:${SUPERVISOR_INBOX_DIR}
Volume=thermite-${p.rig}-outbox:/outbox:ro
${secret("secrets/harness-supervisor-token")}
${secret("secrets/control-rig-token")}\nVolume=${unitDir}/bus:/keys:ro,Z
Network=${net}.network
Network=${egress}.network
DropCapability=ALL
AddCapability=CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID
NoNewPrivileges=true
${logAndHealth(HEALTH_URLS.supervisor)}

${service}

[Install]
WantedBy=default.target
`,
  };
}

/** A heredoc that writes `content` to `path` (a shell word) with `mode`, unexpanded. */
function writeFile(path: string, content: string, mode: string): string {
  const end = `THERMITE_EOF_${randomBytes(8).toString("hex")}`;
  if (content.includes(end)) throw new Error("content collides with its heredoc marker");
  return `cat > ${path} <<'${end}'\n${content.endsWith("\n") ? content : `${content}\n`}${end}\nchmod ${mode} ${path}`;
}

/**
 * The bus's folder for the supervisor alone (its own, as the harness's keys folder is relabeled
 * for the harness), with the authority's certificate, which is no secret: written at each setup and
 * update, so that a rig gets control's authority again.
 */
const busFiles = (dir: string, bus: RigBus, q: (path: string) => string) => [
  `mkdir -p ${q(`${dir}/bus`)}`,
  `chmod 0755 ${q(`${dir}/bus`)}`,
  writeFile(q(`${dir}/bus/bus-ca.pem`), bus.ca, "0644"),
];

/** The deploy script: the rig's files and units, then images pulled and services started. */
export function deployScript(p: RigPlan, secrets: RigSecrets): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { dir, units, systemctl } = rigPaths(p);
  const q = (path: string) => `"${path}"`;
  const lines = [
    "set -eu",
    ...userSession(p.root),
    "umask 077",
    `if [ -e ${q(dir)} ]; then echo "rig ${p.rig} exists on this machine already" >&2; exit 3; fi`,
    `mkdir -p ${q(`${dir}/secrets`)} ${q(`${dir}/keys`)} ${q(units)}`,
    // The directory keeps the files to its owner; the containers read them as their own users.
    `chmod 0700 ${q(dir)}`,
    // Control's public key is no secret, and the harness's controller reads it as its own user
    // (not the container's root): under umask 077 that user could not enter the keys folder.
    `chmod 0755 ${q(`${dir}/keys`)}`,
    writeFile(q(`${dir}/secrets/control-rig-token`), secrets.controlToken, "0644"),
    writeFile(q(`${dir}/secrets/harness-supervisor-token`), secrets.harnessSupervisorToken, "0644"),
    writeFile(q(`${dir}/keys/control-signing.pub`), p.controlPublicKey, "0644"),
    writeFile(q(`${dir}/keys/control-signing.fingerprint`), p.controlFingerprint, "0644"),
    ...busFiles(dir, p.bus, q),
    ...Object.entries(rigUnits(p)).map(([name, text]) =>
      writeFile(q(`${units}/${name}`), text, "0644"),
    ),
    `${systemctl} daemon-reload`,
    `for image in ${shellQuote(p.images.harness)} ${shellQuote(p.images.supervisor)}; do podman image exists "$image" || podman pull -q "$image" >/dev/null; done`,
    `${systemctl} start ${unitName(p.rig, "harness")}.service ${unitName(p.rig, "supervisor")}.service`,
    `echo started`,
  ];
  return lines.join("\n");
}

/**
 * The update script: a rig control set up moves onto other images. The images are pulled first,
 * while the rig still runs; then its two container units are written again and both services
 * restart. Its secrets, keys, volumes and networks stay, so its ledger, runs, tokens and key do.
 * The bus's address and control's authority are written again, as control has them now. An image
 * the registry no longer serves but the machine holds is used as it is.
 */
export function updateScript(p: UnitPlan): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { dir, units, systemctl } = rigPaths(p);
  const q = (path: string) => `"${path}"`;
  const containers = Object.entries(rigUnits(p)).filter(([name]) => name.endsWith(".container"));
  return [
    "set -eu",
    ...userSession(p.root),
    "umask 077",
    `if [ ! -d ${q(dir)} ]; then echo "rig ${p.rig} is not on this machine" >&2; exit 3; fi`,
    `for image in ${shellQuote(p.images.harness)} ${shellQuote(p.images.supervisor)}; do podman pull -q "$image" >/dev/null || podman image exists "$image"; done`,
    ...busFiles(dir, p.bus, q),
    ...containers.map(([name, text]) => writeFile(q(`${units}/${name}`), text, "0644")),
    `${systemctl} daemon-reload`,
    `${systemctl} restart ${unitName(p.rig, "harness")}.service ${unitName(p.rig, "supervisor")}.service`,
    "echo updated",
  ].join("\n");
}

/**
 * The check script (read-only): whether the rig's two services are active, its containers' states,
 * and the supervisor's last log lines, which say why a rig that runs does not report.
 */
export function checkScript(p: Pick<RigPlan, "rig" | "root">): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { systemctl } = rigPaths(p);
  const h = unitName(p.rig, "harness");
  const s = unitName(p.rig, "supervisor");
  return [
    "set -u",
    ...userSession(p.root),
    `echo "harness=$(${systemctl} is-active ${h}.service 2>/dev/null || true)"`,
    `echo "supervisor=$(${systemctl} is-active ${s}.service 2>/dev/null || true)"`,
    `podman ps -a --filter name=${shellQuote(`^(${h}|${s})$`)} --format 'ps={{.Names}}|{{.Status}}' 2>/dev/null || true`,
    `podman logs --tail 3 ${s} 2>&1 | tail -n 3 | sed 's/^/log=/' || true`,
  ].join("\n");
}

/** What the check script found, in words: ok when both services are active. */
export function readCheck(rig: string, out: string): { ok: boolean; words: string } {
  const lines = out.split("\n").map((l) => l.trim());
  const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) || "";
  const states = {
    harness: val("harness") || "unknown",
    supervisor: val("supervisor") || "unknown",
  };
  const status = (part: "harness" | "supervisor") =>
    lines
      .find((l) => l.startsWith(`ps=${unitName(rig, part)}|`))
      ?.split("|")[1]
      ?.trim() ?? "";
  const ok = states.harness === "active" && states.supervisor === "active";
  const part = (name: "harness" | "supervisor") =>
    `the ${name} is ${states[name] === "active" ? "running" : states[name]}${status(name) ? ` (${status(name).toLowerCase()})` : ""}`;
  const said = ok
    ? `Both containers run: ${part("harness")}, ${part("supervisor")}.`
    : `Not both containers run: ${part("harness")}, ${part("supervisor")}.`;
  const log = lines
    .filter((l) => l.startsWith("log="))
    .map((l) => l.slice(4).trim())
    .filter(Boolean)
    .map((l) => l.slice(0, 200));
  return {
    ok,
    words: redact(
      log.length ? `${said} The supervisor's last log lines: ${log.join(" · ")}` : said,
    ).slice(0, 900),
  };
}

export type RigAction = "stop" | "start" | "restart" | "remove" | "status";

/** Managing a rig control set up: its services, and removing its units, files and volumes. */
export function manageScript(p: Pick<RigPlan, "rig" | "root">, action: RigAction): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { dir, units, systemctl } = rigPaths(p);
  const services = `${unitName(p.rig, "supervisor")}.service ${unitName(p.rig, "harness")}.service`;
  const body: Record<RigAction, string[]> = {
    stop: [`${systemctl} stop ${services}`],
    start: [`${systemctl} start ${services.split(" ").reverse().join(" ")}`],
    restart: [`${systemctl} restart ${services.split(" ").reverse().join(" ")}`],
    status: [`${systemctl} is-active ${services} || true`],
    remove: [
      `${systemctl} stop ${services} || true`,
      `rm -f "${units}/thermite-${p.rig}-harness.container" "${units}/thermite-${p.rig}-supervisor.container" "${units}/thermite-${p.rig}.network" "${units}/thermite-${p.rig}-egress.network"`,
      `${systemctl} daemon-reload`,
      `podman volume rm -f thermite-${p.rig}-state thermite-${p.rig}-scratch thermite-${p.rig}-inbox thermite-${p.rig}-outbox thermite-${p.rig}-supervisor >/dev/null 2>&1 || true`,
      `podman network rm -f thermite-${p.rig} thermite-${p.rig}-egress >/dev/null 2>&1 || true`,
      `rm -rf "${dir}"`,
      "echo removed",
    ],
  };
  return ["set -eu", ...userSession(p.root), ...body[action]].join("\n");
}

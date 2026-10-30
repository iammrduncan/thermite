import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ADVISOR_RUNS_ENV, ADVISOR_RUNS_SOCKET, advisorRunsDir } from "../../core/advisor-runs.ts";
import { SUPERVISOR_PASSWD_HOME } from "../../core/paths.ts";
import {
  ENROLLED_FILES,
  keySha256,
  POD_CONFIG_ENV,
  POD_CONFIG_VALUE,
  sameHex,
} from "../../core/tunnel.ts";
import { SNAPSHOT_KEY_VAR } from "./seal.ts";

/**
 * The one-container rig image (containers/rig/Containerfile): a rig's harness and supervisor in
 * one container, for hosts that run one container per machine, such as a RunPod pod. The broker
 * runs as root, as always, and also starts the supervisor under its own user, beside the
 * controller and the roles. These are the plain decisions behind that; broker.ts carries them
 * out and the isolation selftest checks them.
 */

type Env = Record<string, string | undefined>;

/** THERMITE_ONE_CONTAINER=1 (the one-container image sets it): the supervisor runs here too. */
export function oneContainer(env: Env): boolean {
  return env.THERMITE_ONE_CONTAINER === "1";
}

/**
 * RunPod's own variables (its API key, the pod's ID and the rest of RUNPOD_*). The image's entry
 * point removes them before anything starts (containers/rig/thermite-rig-start); the broker
 * never passes one on either, to the controller, the supervisor or a role.
 */
export const isRunpodVariable = (name: string): boolean => name.startsWith("RUNPOD_");

/**
 * What only root may hold: the state snapshot's key (seal.ts). The broker takes it out of its own
 * environment before it starts anything; no part and no role is ever given it either.
 */
export const isRootOnly = (name: string): boolean => name === SNAPSHOT_KEY_VAR;

/** An environment without RunPod's variables, root's own values and unset entries. */
export function withoutRunpod(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && !isRunpodVariable(k) && !isRootOnly(k)) out[k] = v;
  return out;
}

/** Where the broker records how it started the supervisor: next to its socket, for the selftest. */
export const SUPERVISOR_RECORD = "supervisor.json";

/** The broker's record of the supervisor it starts (SUPERVISOR_RECORD). */
export interface SupervisorRecord {
  uid: number;
  gid: number;
  /** "landlock": it runs in the GPU fence with no card; "none": the kernel has no Landlock. */
  fence: "landlock" | "none";
  /** What its user met opening the GPU's device nodes, started as it is: see supervisorGpu. */
  gpu: string;
  home: string;
  at: string;
}

export interface SupervisorPaths {
  /** Its state (THERMITE_SUPERVISOR_HOME), closed to every other user. */
  home: string;
  /** Its temporary directory: /tmp is closed to it, as to the roles. Emptied at every start. */
  tmp: string;
  /** The harness's inbox: the supervisor writes there, the controller reads. */
  inbox: string;
  /** Its copy of the token it uses on the harness API. Always in its home. */
  tokenFile: string;
  /** The advisors' runs' root (core/advisor-runs.ts), beside its state, out of it. */
  advisorRuns: string;
}

export function supervisorPaths(env: Env): SupervisorPaths {
  const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
  return {
    home,
    tmp: join(home, "tmp"),
    inbox: env.THERMITE_INBOX_DIR ?? "/inbox",
    tokenFile: join(home, "harness-token"),
    advisorRuns: advisorRunsDir(home),
  };
}

/**
 * The supervisor's files: its home and temporary directory (its own, closed to every other user),
 * the inbox it shares with the controller, and its copy of the token it uses on the harness API.
 * The broker makes them at start and again before each start of the supervisor (goal 165): a full
 * reset's wipe empties its home. Only while none of the supervisor's processes runs, so nothing
 * can swap a path in its home for a link meanwhile.
 */
export function makeSupervisorFiles(
  paths: SupervisorPaths,
  ids: { uid: number; gid: number; inboxGid: number },
  token: string,
): void {
  const { uid, gid, inboxGid } = ids;
  mkdirSync(paths.home, { recursive: true });
  if (statSync(paths.home).uid !== uid)
    execFileSync("chown", ["-R", "-P", `${uid}:${gid}`, paths.home], { stdio: "ignore" });
  chmodSync(paths.home, 0o700);
  rmSync(paths.tmp, { recursive: true, force: true });
  mkdirSync(paths.tmp, { mode: 0o700 });
  chownSync(paths.tmp, uid, gid);
  // The inbox: the supervisor writes, the controller's group reads (setgid keeps the group on
  // what is added); roles are in neither.
  mkdirSync(paths.inbox, { recursive: true });
  const inbox = statSync(paths.inbox);
  if (inbox.uid !== uid || inbox.gid !== inboxGid)
    execFileSync("chown", ["-R", "-P", `${uid}:${inboxGid}`, paths.inbox], { stdio: "ignore" });
  chmodSync(paths.inbox, 0o2750);
  // Its copy of the token: a new file (whatever was at the path goes), owned by it, 0600.
  rmSync(paths.tokenFile, { recursive: true, force: true });
  const fd = openSync(paths.tokenFile, "wx", 0o600);
  try {
    fchownSync(fd, uid, gid);
    fchmodSync(fd, 0o600);
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
}

/**
 * The supervisor's environment: the broker's own, without RunPod's variables, the snapshot key
 * and the harness's secret files (only root reads those), with its own places and user, and the
 * advisors' runner the broker serves for it.
 */
export function supervisorEnv(
  env: Env,
  paths: SupervisorPaths,
  harnessSecretVars: readonly string[],
): Record<string, string> {
  const out = withoutRunpod(env);
  for (const k of harnessSecretVars) delete out[k];
  return {
    ...out,
    HOME: SUPERVISOR_PASSWD_HOME,
    USER: "supervisor",
    TMPDIR: paths.tmp,
    THERMITE_SUPERVISOR_HOME: paths.home,
    THERMITE_INBOX_DIR: paths.inbox,
    THERMITE_HARNESS_TOKEN_FILE: paths.tokenFile,
    [ADVISOR_RUNS_ENV.socket]: ADVISOR_RUNS_SOCKET,
    [ADVISOR_RUNS_ENV.root]: paths.advisorRuns,
  };
}

/**
 * How the supervisor's command is started once it runs as its user: with no_new_privs (setpriv),
 * and in the GPU fence with no card (thermite-devfence) where the kernel has Landlock, so neither
 * it nor a program it starts (an advisor's) can open the GPU's device nodes.
 */
export function supervisorArgv(
  command: readonly string[],
  tools: { setpriv: string | undefined; fence: string | undefined },
): string[] {
  if (!tools.setpriv)
    throw new Error("starting the supervisor needs setpriv, which this image lacks");
  return [
    tools.setpriv,
    "--no-new-privs",
    "--",
    ...(tools.fence ? [tools.fence, "--"] : []),
    ...command,
  ];
}

/** Run as the supervisor's user: the device nodes it opened, as JSON. */
export const OPEN_NODES_JS = `const fs=require("node:fs");const opened=[];for(const p of JSON.parse(process.argv[1])){try{fs.closeSync(fs.openSync(p,"r+"));opened.push(p)}catch{}}process.stdout.write(JSON.stringify(opened))`;

/**
 * What the supervisor's user meets opening each GPU device node, started as the supervisor is
 * (`run` takes the probe's command and runs it that way): "refused", "no GPU node", or a failure
 * the selftest reports, "OPENED <nodes>" or "failed: ...".
 */
export function supervisorGpu(
  nodes: string[],
  node: string,
  run: (command: string[]) => { status: number | null; stdout: string; stderr: string },
): string {
  if (!nodes.length) return "no GPU node";
  const r = run([node, "-e", OPEN_NODES_JS, JSON.stringify(nodes)]);
  let opened: unknown;
  try {
    opened = JSON.parse(r.stdout);
  } catch {
    return `failed: exit ${r.status} ${r.stderr.trim().slice(-200)}`;
  }
  if (!Array.isArray(opened)) return `failed: ${r.stdout.slice(0, 200)}`;
  return opened.length ? `OPENED ${opened.join(", ")}` : "refused";
}

/**
 * Pull mode (THERMITE_TUNNEL_PORT; the one-container image sets it): control connects to the
 * supervisor, and the supervisor's enrollment brings control's key and the rig's settings. The
 * controller then starts only once the pod is enrolled (awaitEnrollment in broker.ts).
 */
export function pullMode(env: Env): boolean {
  return Boolean(env.THERMITE_TUNNEL_PORT);
}

/**
 * Pull mode's launch values reach the supervisor alone: the enrollment code above all. The
 * controller keeps two public ones, for its isolation check: the tunnel's folder (no role may
 * read the pod's keys) and the SHA-256 of control's key (the key it trusts must be that one).
 */
const CONTROLLER_TUNNEL_VARS = new Set([
  "THERMITE_TUNNEL_DIR",
  "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
]);
export const isSupervisorOnly = (name: string): boolean =>
  name.startsWith("THERMITE_TUNNEL_") && !CONTROLLER_TUNNEL_VARS.has(name);

/** The names rig.env may set: the rig's ID, and the settings control gives a rig at enrollment. */
export const ENROLLED_SETTINGS: readonly string[] = ["THERMITE_RIG_ID", ...POD_CONFIG_ENV];

/** The most a file enrollment leaves may hold: a public key, or a few settings. */
export const ENROLLED_MAX_BYTES = 16 * 1024;

type Read = { text: string } | { missing: true } | { refused: string };

/**
 * Reads a file the supervisor wrote, as data: a plain file of the supervisor's own (`owner`),
 * not a link, of at most ENROLLED_MAX_BYTES. A link, a FIFO or another user's file is refused, so
 * the supervisor can never make root read what it could not read itself.
 */
export function readSupervisorFile(path: string, owner: number): Read {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { refused: code === "ELOOP" ? "it is a link" : `it can't be opened (${code})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { refused: "it is not a plain file" };
    if (st.uid !== owner) return { refused: `it belongs to uid ${st.uid}, not the supervisor` };
    if (st.size > ENROLLED_MAX_BYTES)
      return { refused: `it is larger than ${ENROLLED_MAX_BYTES} bytes` };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    return { text: buf.subarray(0, n).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * The rig's settings in rig.env, as data: one `NAME=value` line each, only the names in
 * ENROLLED_SETTINGS, each once, with values a shell takes as they are; and the rig's ID must be
 * the launch's. Returns the settings without the rig's ID. Nothing is ever run or expanded.
 */
export function parseRigEnv(
  text: string,
  rig: string,
): { settings: Record<string, string> } | { refused: string } {
  const settings: Record<string, string> = {};
  for (const [i, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq) : "";
    if (!ENROLLED_SETTINGS.includes(name))
      return { refused: `rig.env line ${i + 1} is not a setting control gives a rig` };
    if (name in settings) return { refused: `rig.env sets ${name} twice` };
    const value = line.slice(eq + 1);
    if (!POD_CONFIG_VALUE.test(value))
      return { refused: `rig.env: ${name} is not letters, digits and . _ , : -` };
    settings[name] = value;
  }
  if (settings.THERMITE_RIG_ID !== rig) return { refused: `rig.env is not for this rig (${rig})` };
  const { THERMITE_RIG_ID: _rig, ...rest } = settings;
  return { settings: rest };
}

/** What the supervisor's enrollment left, as root reads it. */
export type Enrollment =
  | { state: "waiting" }
  | { state: "refused"; why: string }
  | { state: "ready"; controlKeyPem: string; settings: Record<string, string> };

/**
 * What enrollment left in `dir` (THERMITE_TUNNEL_ENROLLED_DIR), read by root before the
 * controller starts: control's key, which must be an Ed25519 key whose SHA-256 is the one the
 * launch named, and the rig's settings (parseRigEnv). Waiting while `control.pub` is not there:
 * the supervisor writes it last.
 */
export function readEnrollment(o: {
  dir: string;
  rig: string;
  controlKeySha256: string;
  /** The supervisor's uid: the files must be its own. */
  owner: number;
}): Enrollment {
  const refused = (why: string): Enrollment => ({ state: "refused", why });
  const key = readSupervisorFile(join(o.dir, ENROLLED_FILES.controlKey), o.owner);
  if ("missing" in key) return { state: "waiting" };
  if ("refused" in key) return refused(`${ENROLLED_FILES.controlKey}: ${key.refused}`);
  let pem: string;
  try {
    const k = createPublicKey(key.text);
    if (k.asymmetricKeyType !== "ed25519")
      return refused(`${ENROLLED_FILES.controlKey} is not an Ed25519 public key`);
    pem = k.export({ type: "spki", format: "pem" }).toString();
  } catch {
    return refused(`${ENROLLED_FILES.controlKey} is not a public key`);
  }
  if (!sameHex(keySha256(pem), o.controlKeySha256.toLowerCase()))
    return refused(`${ENROLLED_FILES.controlKey} is not the key the launch named by its SHA-256`);
  const env = readSupervisorFile(join(o.dir, ENROLLED_FILES.env), o.owner);
  if ("missing" in env) return refused(`${ENROLLED_FILES.env} is missing`);
  if ("refused" in env) return refused(`${ENROLLED_FILES.env}: ${env.refused}`);
  const parsed = parseRigEnv(env.text, o.rig);
  if ("refused" in parsed) return refused(parsed.refused);
  return { state: "ready", controlKeyPem: pem, settings: parsed.settings };
}

/**
 * Root's copy of control's key, the only one the harness reads (THERMITE_CONTROL_PUBKEY_FILE):
 * written whole to a new file in a folder of root's own that is not a link, mode 0644, then
 * renamed into place. Neither the supervisor nor a role can write the file or its folder. `uid`
 * is root's (tests give their own).
 */
export function writeControlKey(file: string, pem: string, uid = 0): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid)
    throw new Error(`${dir} is not a folder of root's own: control's key is not written there`);
  chmodSync(dir, 0o755);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, pem, { mode: 0o644, flag: "wx" });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
}

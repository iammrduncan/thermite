import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { LEAF_ENV } from "../../core/link/leaf.ts";
import { keySha256 } from "../../core/tunnel.ts";
import {
  IDS,
  inspectSnapshotFolder,
  lookWords,
  oneContainer,
  SNAPSHOT_KEY_VAR,
  SNAPSHOT_RECORD,
  type SnapshotRecord,
  SUPERVISOR_RECORD,
  type SupervisorRecord,
  supervisorPaths,
} from "../broker/index.ts";
import { fileCapsCheck } from "./capabilities.ts";
import { isFailure } from "./probes.ts";

/**
 * The one-container rig image: what the role probes aim at there (oneContainerTargets), and the
 * checks of the container as a whole (containerChecks): the supervisor's user and its GPU access,
 * set-id files, RunPod's variables and the enrollment code in the rig's processes, in pull mode
 * the key the harness trusts, and the state snapshot's folder and key.
 */

/** The processes running a script of Thermite's (`node <...>/<script>`), other than this one. */
export function pidsRunning(script: string, procDir = "/proc"): number[] {
  const pids: number[] = [];
  for (const name of existsSync(procDir) ? readdirSync(procDir) : []) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(join(procDir, name, "cmdline"), "utf8").split("\0");
      if (Number(name) !== process.pid && (argv[1] ?? "").endsWith(script)) pids.push(Number(name));
    } catch {
      // gone
    }
  }
  return pids;
}

export const SUPERVISOR_SCRIPT = "dist/supervisor/main.js";

/** The one-container rig image: the supervisor's places, which no role may reach. */
export interface OneContainerTargets {
  supervisorHome: string;
  /** Its copy of the token it uses on the harness API. */
  supervisorToken: string;
  /**
   * Pull mode: the harness's copy of control's key (root's), and the SHA-256 the launch named
   * (THERMITE_TUNNEL_CONTROL_KEY_SHA256, which the broker passes the controller).
   */
  controlKey?: { file: string; sha256: string } | undefined;
}

/** What the selftest probes of the supervisor in the one-container image; none elsewhere. */
export function oneContainerTargets(
  env: Record<string, string | undefined>,
): OneContainerTargets | undefined {
  if (!oneContainer(env)) return undefined;
  const p = supervisorPaths(env);
  const file = env.THERMITE_CONTROL_PUBKEY_FILE;
  const sha256 = env.THERMITE_TUNNEL_CONTROL_KEY_SHA256;
  return {
    supervisorHome: p.home,
    supervisorToken: p.tokenFile,
    ...(file && sha256 ? { controlKey: { file, sha256 } } : {}),
  };
}

/** A process's real, effective, saved and file ids, and no_new_privs (/proc/<pid>/status). */
function statusOf(
  procDir: string,
  pid: number,
): { uids: number[]; gids: number[]; nnp: boolean } | undefined {
  try {
    const text = readFileSync(join(procDir, String(pid), "status"), "utf8");
    const ids = (field: string) =>
      (new RegExp(`^${field}:\\s*(.*)$`, "m").exec(text)?.[1] ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    return { uids: ids("Uid"), gids: ids("Gid"), nnp: /^NoNewPrivs:\s*1\s*$/m.test(text) };
  } catch {
    return undefined;
  }
}

/**
 * The supervisor runs as its own user and group, with no_new_privs: "uid 10001, gid 10001,
 * no_new_privs", or a failure. It may still be starting: waits up to `waitMs` for it.
 */
export async function supervisorUserCheck(
  procDir = "/proc",
  waitMs = 10_000,
  expect = IDS.supervisor,
): Promise<string> {
  const deadline = Date.now() + waitMs;
  let pids = pidsRunning(SUPERVISOR_SCRIPT, procDir);
  while (!pids.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    pids = pidsRunning(SUPERVISOR_SCRIPT, procDir);
  }
  if (!pids.length) return "MISSING: no supervisor process";
  for (const pid of pids) {
    const st = statusOf(procDir, pid);
    if (!st) continue;
    const wrong =
      st.uids.length !== 4 ||
      st.uids.some((u) => u !== expect.uid) ||
      st.gids.length !== 4 ||
      st.gids.some((g) => g !== expect.gid);
    if (wrong)
      return `WRONG USER: pid ${pid} has uids ${st.uids.join(" ")}, gids ${st.gids.join(" ")}`;
    if (!st.nnp) return `WRONG: pid ${pid} may gain privileges (no_new_privs is off)`;
  }
  return `uid ${expect.uid}, gid ${expect.gid}, no_new_privs`;
}

/**
 * What the supervisor's user met opening the GPU's device nodes when the broker started it (the
 * broker's record next to its socket): "refused" or "no GPU node", with the fence; or a failure.
 */
export function supervisorGpuCheck(brokerDir: string): string {
  let r: SupervisorRecord;
  try {
    r = JSON.parse(readFileSync(join(brokerDir, SUPERVISOR_RECORD), "utf8")) as SupervisorRecord;
  } catch (err) {
    return `MISSING: no record from the broker (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
  return isFailure(r.gpu) ? r.gpu : `${r.gpu} (fence: ${r.fence})`;
}

/**
 * Set-id files on the container's own filesystem (from `root`, not crossing into other mounts):
 * the one-container image has none, since its host does not stop a process gaining privileges
 * through one. "none", or "FOUND <files>". Folders this process cannot read are counted. `skip`
 * leaves folders out: the scratch folder, where roles work (a role's own set-id file gives only
 * itself, and the broker clears set-id bits after every lane run).
 */
export function setIdCheck(root = "/", skip: string[] = []): string {
  const found: string[] = [];
  let unreadable = 0;
  const dev = lstatSync(root).dev;
  const skipped = new Set(skip);
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      unreadable++;
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.dev !== dev || skipped.has(p)) continue;
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && st.mode & 0o6000) found.push(p);
    }
  };
  visit(root);
  if (found.length)
    return `FOUND ${found.length} set-id files: ${found.slice(0, 10).join(", ")}${found.length > 10 ? ", ..." : ""}`;
  return unreadable ? `none (${unreadable} folders not readable)` : "none";
}

/**
 * The rig's processes, PID 1 and everything started under it, with their uid and their
 * environment's entries where this process may read it (all of them as root with ptrace's
 * capability, otherwise its own user's). A process started from outside (a shell opened with
 * `exec`) is not part of the rig and is left out.
 */
function rigProcesses(procDir: string): { pid: number; uid: number; environ?: string[] }[] {
  const parent = new Map<number, number>();
  const uid = new Map<number, number>();
  for (const name of existsSync(procDir) ? readdirSync(procDir) : []) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(join(procDir, name, "status"), "utf8");
      const ppid = /^PPid:\s*(\d+)/m.exec(status);
      if (ppid) parent.set(Number(name), Number(ppid[1]));
      uid.set(Number(name), Number(/^Uid:\s*(\d+)/m.exec(status)?.[1] ?? -1));
    } catch {
      // gone
    }
  }
  const underInit = (pid: number) => {
    for (let p = pid, hops = 0; hops < 4096; hops++) {
      if (p === 1) return true;
      const up = parent.get(p);
      if (up === undefined || up === 0) return false;
      p = up;
    }
    return false;
  };
  const pids = [...parent.keys()].filter(underInit).sort((a, b) => a - b);
  return pids.map((pid) => {
    try {
      const text = readFileSync(join(procDir, String(pid), "environ"), "latin1");
      return { pid, uid: uid.get(pid) ?? -1, environ: text.split("\0") };
    } catch {
      return { pid, uid: uid.get(pid) ?? -1 };
    }
  });
}

/** The image's own PID 1: tini, which the images' entry points run last. */
const OWN_INIT = "/usr/bin/tini";

/**
 * PID 1's program when it is not the image's own tini: an init the platform runs, which starts the
 * image's entry point as its child and keeps the environment the platform gave the container
 * (RunPod does this). Undefined when PID 1 is the image's tini, or when this process can't tell.
 */
export function platformInit(procDir = "/proc"): string | undefined {
  try {
    const exe = readlinkSync(join(procDir, "1", "exe"));
    return exe === OWN_INIT ? undefined : exe;
  } catch {
    return undefined;
  }
}

/**
 * RunPod's variables in the rig's processes (rigProcesses), as far as this process may read
 * their environments. "none (read N of M processes)" or "FOUND". A platform's own init at PID 1
 * (platformInit) is not the rig's: the entry point took the variables out of everything it
 * started, and the roles' pid1-environ probes show that no role can read PID 1's. The answer
 * then says so.
 */
export function runpodCheck(procDir = "/proc"): string {
  const init = platformInit(procDir);
  const procs = rigProcesses(procDir).filter((p) => !(init && p.pid === 1));
  const found = procs.flatMap((p) =>
    (p.environ ?? [])
      .filter((kv) => kv.startsWith("RUNPOD_"))
      .map((kv) => `${kv.split("=")[0]} (pid ${p.pid})`),
  );
  if (found.length) return `FOUND ${found.slice(0, 8).join(", ")}`;
  const read = `none (read ${procs.filter((p) => p.environ).length} of ${procs.length} processes)`;
  return init
    ? `${read}; PID 1 is the platform's own init (${init}), not the rig's, and keeps the container's first environment`
    : read;
}

/** The launch's secrets that only root and the supervisor's own first process may start with. */
const SUPERVISOR_SECRETS = ["THERMITE_TUNNEL_ENROLL_CODE", LEAF_ENV.key];

/**
 * Pull mode's enrollment code and the leaf node's key in the rig's processes: only root's and the
 * supervisor's own first process may have started with them (the supervisor takes them out of
 * its environment at start, so nothing it starts has them; the controller never gets them).
 * "none (read N of M processes)" or "FOUND".
 */
export function enrollCodeCheck(procDir = "/proc"): string {
  const procs = rigProcesses(procDir);
  const supervisor = new Set(pidsRunning(SUPERVISOR_SCRIPT, procDir));
  const found = procs.flatMap((p) => {
    if (p.uid === 0 || supervisor.has(p.pid)) return [];
    const has = SUPERVISOR_SECRETS.filter((v) =>
      (p.environ ?? []).some((kv) => kv.startsWith(`${v}=`)),
    );
    return has.length ? [`pid ${p.pid} (uid ${p.uid}): ${has.join(", ")}`] : [];
  });
  if (found.length) return `FOUND ${found.slice(0, 8).join("; ")}`;
  return `none (read ${procs.filter((p) => p.environ).length} of ${procs.length} processes)`;
}

/**
 * The key the harness trusts for control's commands, in pull mode: root's copy, which neither
 * the supervisor nor a role can change (the file and each folder above it, up to `top`, are
 * `rootUid`'s and writable by no one else), and the key the launch named by its SHA-256.
 */
export function controlKeyCheck(
  file: string,
  sha256: string,
  opts: { rootUid?: number; top?: string } = {},
): string {
  const rootUid = opts.rootUid ?? 0;
  const top = opts.top ?? "/";
  let pem: string;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return `WRONG: ${file} is not a plain file`;
    const wrong = (p: string, s: Stats) =>
      s.uid !== rootUid || s.mode & 0o022
        ? `WRONG: ${p} is uid ${s.uid}, mode ${(s.mode & 0o777).toString(8)}: another user could change it`
        : undefined;
    const bad = wrong(file, st);
    if (bad) return bad;
    for (let d = dirname(file); ; d = dirname(d)) {
      const s = lstatSync(d);
      if (!s.isDirectory()) return `WRONG: ${d} is not a folder`;
      const badDir = wrong(d, s);
      if (badDir) return badDir;
      if (d === top || d === dirname(d)) break;
    }
    pem = readFileSync(file, "utf8");
  } catch (err) {
    return `MISSING: ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
  try {
    if (keySha256(pem) !== sha256.toLowerCase())
      return "WRONG: it is not the key the launch named by its SHA-256";
  } catch {
    return "WRONG: it is not a public key";
  }
  return "root's, the key the launch named";
}

/**
 * The state snapshot (THERMITE_STATE_SNAPSHOT_DIR): the broker's record of its folder at start
 * (next to its socket), and the folder now, where this process may list it. The folder must hold
 * nothing but the sealed manifest and sealed files (inspectSnapshotFolder): a plaintext file, an
 * unsealed snapshot or any other name fails ("FOUND …"). Then, with the launch's key:
 *
 * - "sealed, closed to thermite, supervisor, agent-1 (owner 0:0, mode 700)", when each of those
 *   users was refused listing it and writing in it;
 * - "open, sealed: agent-1 lists it and writes in it; … (owner …, mode …)", where the volume lets
 *   them in, as RunPod's does: not a failure, since nothing there can be read or changed unseen.
 *
 * Without a key, "no snapshot: <why>" (not a failure: nothing is written there). Each ends with
 * what the folder holds, where this process could list it. "MISSING: …" without a record, and
 * "failed: …" when root could not make the folder.
 */
export function stateSnapshotCheck(brokerDir: string, dir?: string): string {
  let r: SnapshotRecord;
  try {
    r = JSON.parse(readFileSync(join(brokerDir, SNAPSHOT_RECORD), "utf8")) as SnapshotRecord;
  } catch (err) {
    return `MISSING: no record from the broker (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
  const users = Object.entries(r.users ?? {});
  if (!users.length || users.some(([, v]) => v.startsWith("failed")))
    return `failed: ${users.map(([u, v]) => `${u} ${v}`).join("; ") || "no user was probed"}`;
  let holds = "";
  try {
    const look = inspectSnapshotFolder(dir ?? r.dir);
    if (look.problem) return `FOUND ${look.problem}`;
    holds = `; holds ${lookWords(look)}`;
  } catch {
    // closed to this process: root alone writes there
  }
  const who = `(owner ${r.owner}, mode ${r.mode})`;
  if (r.sealed === false) return `no snapshot: ${r.off ?? "no snapshot key"} ${who}${holds}`;
  if (r.closed) return `sealed, closed to ${users.map(([u]) => u).join(", ")} ${who}${holds}`;
  const open = users
    .filter(([, v]) => v.startsWith("OPENED"))
    .map(([u, v]) => `${u} ${v.slice("OPENED: ".length)}`);
  return `open, sealed: ${open.join("; ")} ${who}${holds}`;
}

/**
 * The state snapshot's key (THERMITE_STATE_SNAPSHOT_KEY) in the rig's processes: root's alone.
 * The broker takes it out of its environment before it starts anything, so no part, no role and
 * nothing they start has it. "none (read N of M processes)" or "FOUND".
 */
export function snapshotKeyCheck(procDir = "/proc"): string {
  const procs = rigProcesses(procDir);
  const found = procs
    .filter(
      (p) => p.uid !== 0 && (p.environ ?? []).some((kv) => kv.startsWith(`${SNAPSHOT_KEY_VAR}=`)),
    )
    .map((p) => `pid ${p.pid} (uid ${p.uid})`);
  if (found.length) return `FOUND ${SNAPSHOT_KEY_VAR} in ${found.slice(0, 8).join(", ")}`;
  return `none (read ${procs.filter((p) => p.environ).length} of ${procs.length} processes)`;
}

/**
 * The one-container image's checks of the container as a whole: the supervisor's user, its GPU
 * access, set-id files and files with capabilities, RunPod's variables and the enrollment code;
 * in pull mode, also the key the harness trusts; with a state snapshot, its folder and its key.
 */
export async function containerChecks(opts: {
  brokerDir: string;
  /** Folders the set-id and capabilities checks leave out (setIdCheck, fileCapsCheck). */
  skip?: string[];
  procDir?: string;
  rootDir?: string;
  waitMs?: number;
  controlKey?: { file: string; sha256: string } | undefined;
  /** THERMITE_STATE_SNAPSHOT_DIR, when the rig keeps a snapshot of its state. */
  snapshotDir?: string | undefined;
}): Promise<Record<string, string>> {
  return {
    "supervisor-user": await supervisorUserCheck(opts.procDir, opts.waitMs),
    "supervisor-gpu": supervisorGpuCheck(opts.brokerDir),
    "setid-files": setIdCheck(opts.rootDir, opts.skip),
    "file-capabilities": fileCapsCheck(opts.rootDir, opts.skip),
    "runpod-variables": runpodCheck(opts.procDir),
    "enroll-code": enrollCodeCheck(opts.procDir),
    ...(opts.controlKey
      ? { "control-key": controlKeyCheck(opts.controlKey.file, opts.controlKey.sha256) }
      : {}),
    ...(opts.snapshotDir
      ? {
          "state-snapshot": stateSnapshotCheck(opts.brokerDir, opts.snapshotDir),
          "snapshot-key": snapshotKeyCheck(opts.procDir),
        }
      : {}),
  };
}

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Stream } from "node:stream";

/**
 * Supervised child processes: wall time measured here (outside the child), memory and disk
 * watchdogs, a hard timeout, and cleanup of everything the child left behind.
 *
 * With `uid` set (inside the harness container, where the broker is root) the child runs as that
 * user and cleanup kills every process of that user, which is safe because each role has a
 * dedicated user. With `scopeGid` too, only the user's processes holding that group: a lane's
 * plain commands and its dev runs on the device share a user but not a group. Without `uid`
 * (local development) cleanup kills the child's process group.
 */

export interface SupervisedRun {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Unset: no time limit; the run ends when its command does (or its role is killed). */
  timeoutMs?: number | undefined;
  uid?: number | undefined;
  gid?: number | undefined;
  /** Supplementary groups (with uid and gid; set by setpriv, since spawn drops them). */
  groups?: number[] | undefined;
  /**
   * The GPU fence the command runs in (thermite-devfence and its arguments, ending in "--"): a
   * Landlock rule set that keeps it off the device nodes it is not given.
   */
  fence?: readonly string[] | undefined;
  /** A CPU list the run is pinned to (taskset), for timing on a GPU's local CPUs. */
  cpus?: string | undefined;
  /** Kill when the role's resident memory exceeds this. */
  rssLimitBytes?: number | undefined;
  /**
   * Processes started as this program (the first word of their command line) are spared when
   * the memory limit is passed: the others are killed first (an agent's commands), and the run
   * ends only if the spared ones alone are over the limit. Needs /proc (Linux); elsewhere every
   * breach ends the run.
   */
  spareExe?: string | undefined;
  /**
   * The run's own first process is spared too (the terminal host, goal 169, which holds the
   * agent's program: it runs as `node`, as the agent's commands may, so its program's name can't
   * tell it apart). The kernel gives it its pid, which no other process can take.
   */
  spareRoot?: boolean | undefined;
  /** Kill when this directory grows beyond this many bytes or entries (inodes) on disk. */
  disk?: { path: string; limitBytes: number; maxEntries?: number | undefined } | undefined;
  /** RLIMIT_NPROC for the role (only with uid; needs prlimit). */
  nproc?: number | undefined;
  /** Written to the child's stdin, then closed. */
  stdin?: string | undefined;
  /**
   * One of a pair (pair.ts): "first", its standard input and output are pipes the second run
   * takes, so none of its output is kept here; or, for the second, those two pipes' other ends.
   */
  pair?: "first" | { stdin: Stream; stdout: Stream } | undefined;
  /** Told of the process as soon as it is started: a pair's first run hands its pipes on. */
  started?: ((child: ChildProcess) => void) | undefined;
  /** Bytes of stdout and stderr kept (the tail). */
  captureBytes?: number | undefined;
  /** With uid: the run is the user's processes holding this group (real, effective or extra). */
  scopeGid?: number | undefined;
  /**
   * What the command starts in the background outlives it, as in a shell: the run returns when
   * its main process exits, and the leftovers stay under the memory and disk limits until they
   * end or their role is killed (a lane's trial end).
   */
  leaveBackground?: boolean | undefined;
}

export type KilledFor = "timeout" | "memory" | "disk" | null;

export interface SupervisedResult {
  exitCode: number | null;
  signal: string | null;
  killedFor: KilledFor;
  /** From spawn to the child's exit, measured by this process. */
  wallMs: number;
  peakRssBytes: number;
  peakDiskBytes: number;
  peakEntries: number;
  /** Processes still alive when the main process exited (killed then, unless left running). */
  leftovers: number;
  /** Background processes an earlier run left were killed since, and why. */
  backgroundKilled?: "memory" | "disk" | undefined;
  /** With spareExe: how many times the limit was passed and the agent's commands were killed. */
  memoryKills?: number | undefined;
  /** Local development: the process group left running in the background. */
  pgid?: number | undefined;
  /** What the role left in shared places, removed after the run. */
  swept: string[];
  stdout: string;
  stderr: string;
}

/**
 * The program a process was started as: the first word of its command line (Linux). Readable for
 * any process, unlike /proc/<pid>/exe, which needs ptrace rights the broker does not have. A
 * process can set this itself, so it only ever decides which processes are killed first, never
 * whether a limit holds.
 */
export function procArgv0(pid: number): string | undefined {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.slice(0, cmdline.indexOf("\0") >>> 0) || undefined;
  } catch {
    return undefined;
  }
}

export interface Proc {
  pid: number;
  pgid: number;
  uid: number;
  /** Real, effective, saved and filesystem gids, then the supplementary groups (Linux only). */
  gids: number[];
  rssBytes: number;
}

/** All processes, from /proc on Linux or `ps` elsewhere (development machines). */
export function listProcesses(): Proc[] {
  if (existsSync("/proc/self/stat")) {
    const out: Proc[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // Fields after the command name, which is in parentheses and may contain spaces.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const status = readFileSync(`/proc/${name}/status`, "utf8");
        const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
        const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
        const gids = [
          ...(/^Gid:\s+(.*)$/m.exec(status)?.[1] ?? "").trim().split(/\s+/),
          ...(/^Groups:\s*(.*)$/m.exec(status)?.[1] ?? "").trim().split(/\s+/),
        ]
          .filter((g) => g !== "")
          .map(Number);
        out.push({ pid: Number(name), pgid: Number(rest[2]), uid, gids, rssBytes: rssKb * 1024 });
      } catch {
        // the process exited while we looked
      }
    }
    return out;
  }
  const text = execFileSync("ps", ["-A", "-o", "pid=,pgid=,uid=,rss="], { encoding: "utf8" });
  return text
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((f) => f.length === 4 && f.every(Number.isFinite))
    .map(([pid, pgid, uid, rss]) => ({
      pid: pid as number,
      pgid: pgid as number,
      uid: uid as number,
      gids: [],
      rssBytes: (rss as number) * 1024,
    }));
}

export interface DiskUsage {
  bytes: number;
  /** Files, directories and links counted (inodes). */
  entries: number;
  /** True when the walk stopped at its depth or entry cap: treat as over any budget. */
  truncated: boolean;
}

/**
 * What a directory tree occupies on disk. Symlinks are not followed. The walk is capped in
 * depth and entries, so a hostile tree (very deep, or millions of empty files) cannot stall it.
 */
export function diskUsage(path: string, maxEntries = 200_000, maxDepth = 128): DiskUsage {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const stack: [string, number][] = [[path, 0]];
  while (stack.length) {
    const [p, depth] = stack.pop() as [string, number];
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    entries++;
    bytes += Number(st.blocks ?? 0) * 512 || Number(st.size);
    if (entries >= maxEntries) return { bytes, entries, truncated: true };
    if (st.isDirectory()) {
      if (depth >= maxDepth) {
        truncated = true;
        continue;
      }
      try {
        for (const e of readdirSync(p)) stack.push([join(p, e), depth + 1]);
      } catch {
        // unreadable or vanished directory: counted as its own size only
      }
    }
  }
  return { bytes, entries, truncated };
}

/** A run's processes: a user's (holding a group, if one is given), or a process group's. */
export interface Scope {
  uid?: number | undefined;
  gid?: number | undefined;
  pgid?: number | undefined;
}

export function members(scope: Scope, procs: Proc[]): Proc[] {
  if (scope.uid !== undefined) {
    return procs.filter(
      (p) => p.uid === scope.uid && (scope.gid === undefined || p.gids.includes(scope.gid)),
    );
  }
  return procs.filter((p) => p.pgid === scope.pgid);
}

/**
 * Kills every process of a user (or a process group). For a user it runs kill(-1, SIGKILL) as
 * that user, which the kernel applies to all of the user's processes at once, so a fork bomb
 * cannot outrun it; it repeats until none are left. For a user's processes holding a group it
 * kills them one by one, round after round; any it cannot catch (a fork bomb, within the role's
 * process limit) take the whole user with them.
 */
export function killScope(scope: Scope): number {
  if (scope.uid !== undefined && scope.gid !== undefined) {
    let killed = 0;
    for (let round = 0; round < 20; round++) {
      const victims = members(scope, listProcesses());
      if (!victims.length) return killed;
      for (const v of victims) {
        try {
          process.kill(v.pid, "SIGKILL");
          killed++;
        } catch {
          // gone already
        }
      }
    }
    return killed + killScope({ uid: scope.uid });
  }
  if (scope.uid === undefined) {
    if (scope.pgid === undefined) return 0;
    let n = 0;
    for (let round = 0; round < 20; round++) {
      try {
        process.kill(-scope.pgid, "SIGKILL");
        n++;
      } catch {
        return n;
      }
    }
    return n;
  }
  let killed = 0;
  for (let round = 0; round < 10; round++) {
    const victims = listProcesses().filter((p) => p.uid === scope.uid);
    if (!victims.length) return killed;
    killed += victims.length;
    spawnSync(process.execPath, ["-e", "try { process.kill(-1, 'SIGKILL') } catch {}"], {
      uid: scope.uid,
      gid: scope.uid,
      stdio: "ignore",
      timeout: 5000,
    });
  }
  return killed;
}

/**
 * Removes what a role left in the shared places it could reach anyway: files it owns at the top
 * of /tmp, /var/tmp and /dev/shm, and its SysV shared memory, semaphores and message queues.
 * (The broker also closes those directories to roles; this is the second line.)
 */
export function sweepRole(uid: number): string[] {
  const swept: string[] = [];
  for (const dir of ["/tmp", "/var/tmp", "/dev/shm"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (lstatSync(p).uid === uid) {
          rmSync(p, { recursive: true, force: true });
          swept.push(p);
        }
      } catch {
        // gone already
      }
    }
  }
  for (const [kind, flag] of [
    ["shm", "-m"],
    ["sem", "-s"],
    ["msg", "-q"],
  ] as const) {
    const table = `/proc/sysvipc/${kind}`;
    if (!existsSync(table)) continue;
    const [header, ...rows] = readFileSync(table, "utf8").trim().split("\n");
    const cols = (header ?? "").trim().split(/\s+/);
    const idCol = cols.indexOf(kind === "shm" ? "shmid" : kind === "sem" ? "semid" : "msqid");
    const uidCol = cols.indexOf("uid");
    for (const row of rows) {
      const f = row.trim().split(/\s+/);
      if (Number(f[uidCol]) !== uid) continue;
      try {
        execFileSync("ipcrm", [flag, String(f[idCol])], { stdio: "ignore" });
        swept.push(`sysv ${kind} ${f[idCol]}`);
      } catch {
        // removed already
      }
    }
  }
  return swept;
}

const PRLIMIT = ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p));
export const SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"].find((p) => existsSync(p));
const TASKSET = ["/usr/bin/taskset", "/bin/taskset"].find((p) => existsSync(p));

/**
 * The argv and spawn identity for a run. Supplementary groups need setpriv, which drops from
 * root to the role's user, groups and all, before anything of the role runs.
 */
export function launch(
  spec: Pick<SupervisedRun, "argv" | "uid" | "gid" | "groups" | "nproc" | "cpus" | "fence">,
  setpriv = SETPRIV,
  prlimit = PRLIMIT,
  taskset = TASKSET,
): { argv: string[]; uid?: number; gid?: number } {
  if (spec.cpus && !taskset)
    throw new Error("pinning a run to CPUs needs taskset, which this image lacks");
  // The fence is the last step before the command, so nothing of the role runs outside it.
  const fenced = spec.fence?.length ? [...spec.fence, ...spec.argv] : [...spec.argv];
  const pinned = spec.cpus && taskset ? [taskset, "-c", spec.cpus, ...fenced] : fenced;
  // A process limit for the role (a fork bomb stays small), set by prlimit before exec.
  const argv =
    spec.uid !== undefined && spec.nproc !== undefined && prlimit
      ? [prlimit, `--nproc=${spec.nproc}`, "--", ...pinned]
      : pinned;
  if (!spec.groups?.length) {
    return {
      argv,
      ...(spec.uid !== undefined ? { uid: spec.uid } : {}),
      ...(spec.gid !== undefined ? { gid: spec.gid } : {}),
    };
  }
  if (spec.uid === undefined || spec.gid === undefined)
    throw new Error("supplementary groups need a uid and a gid");
  if (!setpriv) throw new Error("supplementary groups need setpriv, which this image lacks");
  return {
    argv: [
      setpriv,
      `--reuid=${spec.uid}`,
      `--regid=${spec.gid}`,
      `--groups=${spec.groups.join(",")}`,
      "--",
      ...argv,
    ],
  };
}

export function runSupervised(spec: SupervisedRun): Promise<SupervisedResult> {
  if (spec.uid === 0) throw new Error("refusing to run supervised work as root");
  const cap = spec.captureBytes ?? 64 * 1024;
  const { argv, uid, gid } = launch(spec);
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio:
        spec.pair === "first"
          ? ["pipe", "pipe", "pipe"]
          : spec.pair
            ? [spec.pair.stdin, spec.pair.stdout, "pipe"]
            : [spec.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      ...(uid !== undefined ? { uid } : {}),
      ...(gid !== undefined ? { gid } : {}),
    });
    const pgid = child.pid ?? -1;
    spec.started?.(child);
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined); // the child may exit without reading
      child.stdin.end(spec.stdin);
    }
    let stdout = "";
    let stderr = "";
    const keep = (prev: string, d: Buffer) => {
      const next = prev + d.toString("utf8");
      return next.length > cap ? next.slice(next.length - cap) : next;
    };
    if (spec.pair !== "first")
      child.stdout?.on("data", (d: Buffer) => {
        stdout = keep(stdout, d);
      });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = keep(stderr, d);
    });

    let killedFor: KilledFor = null;
    let peakRss = 0;
    let peakDisk = 0;
    let peakEntries = 0;
    let leftovers = 0;
    let exitWallMs: number | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const scope: Scope = spec.uid !== undefined ? { uid: spec.uid, gid: spec.scopeGid } : { pgid };
    const key = scopeKey(scope);
    const backgroundKilled = key ? lingerKilled.get(key) : undefined;
    if (key) lingerKilled.delete(key);
    const killAll = () => killScope(scope);
    const kill = (why: KilledFor) => {
      if (killedFor === null && exitWallMs === undefined) killedFor = why;
      // A command's own timeout ends the command, not what earlier ones left running; memory
      // and disk limits are the lane's whole, so a breach ends all of it.
      if (why === "timeout" && spec.leaveBackground) killScope({ pgid });
      else killAll();
    };
    const sampleDisk = () => {
      if (!spec.disk) return;
      const d = diskUsage(spec.disk.path, spec.disk.maxEntries ?? 50_000);
      peakDisk = Math.max(peakDisk, d.bytes);
      peakEntries = Math.max(peakEntries, d.entries);
      if (d.bytes > spec.disk.limitBytes || d.truncated) kill("disk");
    };

    const timer =
      spec.timeoutMs !== undefined ? setTimeout(() => kill("timeout"), spec.timeoutMs) : undefined;
    let ticks = 0;
    let memoryKills = 0;
    // The agent's program, as it may appear on a command line: as given, and its real path; and
    // the run's root, when it holds the program.
    const spareRoot = spec.spareRoot ? child.pid : undefined;
    const spareNames = new Set<string>();
    if (spec.spareExe) {
      spareNames.add(spec.spareExe);
      try {
        spareNames.add(realpathSync(spec.spareExe));
      } catch {
        // as given only
      }
    }
    // Over the memory limit with an agent to spare: kill its commands, keep it. Only when the
    // spared processes alone are over (or none can be told apart) does the run end.
    const overMemory = (procs: Proc[]) => {
      if ((spareNames.size || spareRoot !== undefined) && existsSync("/proc/self/cmdline")) {
        const spared = procs.filter(
          (p) => p.pid === spareRoot || spareNames.has(procArgv0(p.pid) ?? ""),
        );
        const others = procs.filter((p) => !spared.includes(p));
        const sparedRss = spared.reduce((s, p) => s + p.rssBytes, 0);
        if (spared.length && others.length && sparedRss <= (spec.rssLimitBytes ?? 0)) {
          for (const p of others) {
            try {
              process.kill(p.pid, "SIGKILL");
            } catch {
              // gone already
            }
          }
          memoryKills++;
          return;
        }
      }
      kill("memory");
    };
    const watch = setInterval(() => {
      ticks++;
      if (spec.rssLimitBytes !== undefined || ticks % 5 === 0) {
        try {
          const procs = members(scope, listProcesses());
          const rss = procs.reduce((s, p) => s + p.rssBytes, 0);
          peakRss = Math.max(peakRss, rss);
          if (spec.rssLimitBytes !== undefined && rss > spec.rssLimitBytes) overMemory(procs);
        } catch {
          // process listing failed this tick; try again on the next
        }
      }
      if (ticks % 5 === 0) sampleDisk();
    }, 100);

    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      clearTimeout(grace);
      clearInterval(watch);
      let swept: string[] = [];
      if (spec.leaveBackground) {
        // Left running, as in a shell; still under the memory and disk limits.
        if (leftovers) lingerUnder(scope, spec);
      } else {
        // Nothing a run started may outlive it.
        killAll();
        swept = spec.uid !== undefined ? sweepRole(spec.uid) : [];
      }
      sampleDisk();
      // A breach between two samples still counts, even if the child finished first (unless
      // the agent was spared: its commands' kills are counted instead).
      if (killedFor === null && spec.disk && peakDisk > spec.disk.limitBytes) killedFor = "disk";
      if (
        killedFor === null &&
        !memoryKills &&
        spec.rssLimitBytes !== undefined &&
        peakRss > spec.rssLimitBytes
      ) {
        killedFor = "memory";
      }
      resolve({
        exitCode,
        signal: exitSignal,
        killedFor,
        wallMs: exitWallMs ?? Number(process.hrtime.bigint() - started) / 1e6,
        peakRssBytes: peakRss,
        peakDiskBytes: peakDisk,
        peakEntries,
        leftovers,
        swept,
        stdout,
        stderr,
        ...(memoryKills ? { memoryKills } : {}),
        ...(backgroundKilled ? { backgroundKilled } : {}),
        ...(spec.leaveBackground && leftovers && spec.uid === undefined ? { pgid } : {}),
      });
    };
    // Even if the pipes never close (a process stuck in a driver, a survivor holding them), the
    // run ends: timeout plus a grace period.
    const deadline =
      spec.timeoutMs !== undefined
        ? setTimeout(() => {
            if (killedFor === null) killedFor = "timeout";
            finish();
          }, spec.timeoutMs + 15_000)
        : undefined;
    child.on("exit", (code, signal) => {
      exitWallMs = Number(process.hrtime.bigint() - started) / 1e6;
      exitCode = code;
      exitSignal = signal;
      leftovers = members(scope, listProcesses()).length;
      if (spec.leaveBackground) {
        // Background processes may hold the pipes open: the run is over all the same. Their
        // output is still read (and dropped), so they never block on a full pipe.
        grace = setTimeout(finish, 1000);
      } else {
        // Background children may hold the pipes open; kill them so "close" follows promptly.
        killAll();
        grace = setTimeout(finish, 15_000);
      }
    });
    child.on("error", (err) => {
      stderr += String(err);
      exitWallMs ??= Number(process.hrtime.bigint() - started) / 1e6;
      finish();
    });
    child.on("close", finish);
  });
}

/** Why a scope's background processes were killed since its last run (told to the next). */
const lingerKilled = new Map<string, "memory" | "disk">();
const lingering = new Map<string, ReturnType<typeof setInterval>>();

function scopeKey(scope: Scope): string | undefined {
  return scope.uid !== undefined ? `${scope.uid}:${scope.gid ?? "*"}` : undefined;
}

/**
 * Watches what a run left in the background: killed if, together, it exceeds the run's memory
 * limit or its directory exceeds the disk limit. The watch ends when nothing is left.
 */
function lingerUnder(scope: Scope, spec: Pick<SupervisedRun, "rssLimitBytes" | "disk">): void {
  if (spec.rssLimitBytes === undefined && !spec.disk) return;
  const key = scopeKey(scope) ?? `pgid:${scope.pgid}`;
  clearInterval(lingering.get(key));
  let ticks = 0;
  const stop = (why?: "memory" | "disk") => {
    clearInterval(t);
    lingering.delete(key);
    if (why) {
      killScope(scope);
      if (scopeKey(scope)) lingerKilled.set(key, why);
    }
  };
  const t = setInterval(() => {
    ticks++;
    let procs: Proc[];
    try {
      procs = members(scope, listProcesses());
    } catch {
      return;
    }
    if (!procs.length) return stop();
    const rss = procs.reduce((s, p) => s + p.rssBytes, 0);
    if (spec.rssLimitBytes !== undefined && rss > spec.rssLimitBytes) return stop("memory");
    if (spec.disk && ticks % 5 === 0) {
      const d = diskUsage(spec.disk.path, spec.disk.maxEntries ?? 50_000);
      if (d.bytes > spec.disk.limitBytes || d.truncated) return stop("disk");
    }
  }, 1000);
  t.unref();
  lingering.set(key, t);
}

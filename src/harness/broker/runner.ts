import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_LANES } from "../../core/contract.ts";
import { MAX_RUN_MS } from "../../core/kit.ts";
import { type PairOutcome, runPairSupervised } from "./pair.ts";
import { killScope, runSupervised, type SupervisedResult } from "./process.ts";

/**
 * Roles and the runner interface. Inside the harness container the broker (root) runs each
 * role as its own Unix user; in local development the same interface runs everything as the
 * current user, without separation. Callers never pass uids: they name a role.
 */

/** Fixed ids, created in the harness image (containers/harness/Containerfile). */
export const IDS = {
  thermite: { uid: 10010, gid: 10010 },
  /**
   * The rig's supervisor (containers/supervisor/Containerfile). In the one-container rig image
   * (containers/rig/Containerfile) the broker starts it under this user, beside the roles.
   */
  supervisor: { uid: 10001, gid: 10001 },
  /** Judge card 0's builds; card i's build as builder-i (uid and gid 10020 + i, goal 135). */
  builder: { uid: 10020, gid: 10020 },
  /** Candidate execution: primary group `gpu`, the group that owns the device nodes. */
  run: { uid: 10030, gid: 10500 },
  /** The device nodes (shared mode), or the judge's card (dedicated mode). */
  gpuGroup: 10500,
  /** Dedicated mode: the development card. */
  gpuDevGroup: 10501,
  /** Dedicated mode: the nodes every CUDA process needs (nvidiactl, nvidia-uvm, ...). */
  gpuCtlGroup: 10502,
  /** Judge card i (from 1): group 10510 + i, timed by user run-i (uid 10030 + i). */
  gpuJudgeBase: 10510,
  /** Development card k (from 1): group 10520 + k. */
  gpuDevBase: 10520,
  /** Cards of each kind a rig may have: judge cards and development cards, 8 each. */
  maxCards: 8,
  laneBase: 10100,
  laneDevBase: 10200,
  /** Each lane's worker agent process: its own user, with no access to the lane's files. */
  agentBase: 10300,
  /**
   * Planner calls through OpenCode or Claude Code. A user of their own: every run ends by killing
   * its user's processes, so no lane, and no model check, may share it.
   */
  planner: { uid: 10040, gid: 10040 },
  /** Model checks through OpenCode or Claude Code, apart from the lanes and the planner. */
  modelCheck: { uid: 10041, gid: 10041 },
  /** The kit's check on judge card 0's jobs; card i's runs as checker-i (uid and gid 10050 + i). */
  checker: { uid: 10050, gid: 10050 },
  /** A kit's driver (run.driver) on judge card 0; card i's runs as driver-i (uid and gid 10060 + i). */
  driver: { uid: 10060, gid: 10060 },
  /**
   * The checkers' group, which every checker's runs hold and the controller too: through it they
   * read the kits and the baselines the controller keeps, which no other role may enter.
   */
  checkersGroup: 10049,
  /** Lanes with users in the image: the most a contract or a rig's settings may ask for. */
  maxLanes: MAX_LANES,
} as const;

/** The lane numbers below stop at IDS.maxLanes (tests/system/lanes.test.ts checks it). */
export const RoleSchema = z
  .string()
  .regex(
    /^(builder|builder-[1-7]|run|run-[1-7]|checker|checker-[1-7]|driver|driver-[1-7]|planner|model-check|lane-([1-9]|1[0-6])|lane-([1-9]|1[0-6])-dev|agent-([1-9]|1[0-6]))$/,
    "unknown role",
  );
export type Role = z.infer<typeof RoleSchema>;

export function roleIds(role: Role): { uid: number; gid: number } {
  if (role === "builder") return IDS.builder;
  const build = /^builder-([1-7])$/.exec(role);
  if (build)
    return { uid: IDS.builder.uid + Number(build[1]), gid: IDS.builder.gid + Number(build[1]) };
  if (role === "run") return IDS.run;
  if (role === "planner") return IDS.planner;
  if (role === "model-check") return IDS.modelCheck;
  const kitRole = /^(checker|driver)(?:-([1-7]))?$/.exec(role);
  if (kitRole) {
    const base = IDS[kitRole[1] as "checker" | "driver"].uid + Number(kitRole[2] ?? 0);
    return { uid: base, gid: base };
  }
  const judge = /^run-([1-7])$/.exec(role);
  if (judge) {
    const i = Number(judge[1]);
    return { uid: IDS.run.uid + i, gid: IDS.gpuJudgeBase + i };
  }
  const agent = /^agent-(\d+)$/.exec(role);
  if (agent) {
    const n = Number(agent[1]);
    return { uid: IDS.agentBase + n, gid: IDS.agentBase + n };
  }
  const m = /^lane-(\d+)(-dev)?$/.exec(role);
  if (!m) throw new Error(`unknown role ${role}`);
  const n = Number(m[1]);
  // Development runs on the device get the gpu group; plain lane work gets its own group.
  return m[2]
    ? { uid: IDS.laneDevBase + n, gid: IDS.gpuGroup }
    : { uid: IDS.laneBase + n, gid: IDS.laneBase + n };
}

export const RunRequest = z.object({
  role: RoleSchema,
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  /** Unset: no time limit (the run ends with its command, or when its role is killed). */
  timeoutMs: z.number().int().positive().max(MAX_RUN_MS).optional(),
  rssLimitBytes: z.number().int().positive().optional(),
  /**
   * The executable of an agent that runs its commands itself (OpenCode): when the memory limit
   * is passed, its commands are killed and it is spared, as a shell's command would be; only if
   * it alone is over the limit does the run end.
   */
  spareExe: z.string().min(1).startsWith("/").optional(),
  /** The run's own first process is spared too: the terminal host, which holds the program. */
  spareRoot: z.boolean().optional(),
  disk: z.object({ path: z.string().min(1), limitBytes: z.number().int().positive() }).optional(),
  /**
   * The role's processes and threads at once (RLIMIT_NPROC): a contract's lanes.limits.processes
   * for a lane's users. Unset: the broker's default for the role.
   */
  nproc: z.number().int().min(16).max(65_536).optional(),
  /** Written to the child's stdin (file contents for workers' file tools). */
  stdin: z
    .string()
    .max(8 * 1024 * 1024)
    .optional(),
  /** Bytes of stdout and stderr kept (the tail); default 64 KiB. */
  captureBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .optional(),
  /**
   * Run a lane's command with the gpu group (an agent's development run on the device).
   * Only lane roles may ask; the broker refuses it for any other role.
   */
  gpu: z.boolean().optional(),
  /**
   * With `gpu` on a rig with several development cards: which one (0 is the first). The
   * controller hands out free cards; the run's groups reach that card only.
   */
  devCard: z.number().int().min(0).max(7).optional(),
  /**
   * A lane's plain command: what it starts in the background keeps running after it, as in a
   * shell, until the lane's trial ends (killRole). The broker allows it for nothing else.
   */
  keepBackground: z.boolean().optional(),
});
export type RunRequest = z.input<typeof RunRequest>;

export type RunOutcome = SupervisedResult;

export interface Runner {
  /** True when roles really run as separate users. */
  readonly separated: boolean;
  run(req: RunRequest): Promise<RunOutcome>;
  /**
   * Gives a directory under scratch to a role (it may then write there). With `harnessReads`, the
   * controller may still read it (it follows a trial's output there); no other role may.
   */
  handOver(path: string, role: Role, opts?: { harnessReads?: boolean }): Promise<void>;
  /** Takes a directory back for the controller (so it can read and move results). */
  reclaim(path: string): Promise<void>;
  /** Removes a directory under scratch, whoever owns its files. */
  remove(path: string): Promise<void>;
  /**
   * Kills every process of a role; with `gpu`, only a lane's processes on the device (its dev
   * runs), leaving its plain commands running.
   */
  killRole(role: Role, opts?: { gpu?: boolean }): Promise<number>;
  /**
   * Runs a kit's driver and the candidate's command at once, each as its role's user (pair.ts):
   * the driver's output is the candidate's input, and the candidate's output the driver's input.
   * The pair ends when the driver does, and the candidate's processes with it.
   */
  runPair(driver: RunRequest, candidate: RunRequest): Promise<PairOutcome>;
}

/** Resolves `path` and checks it lies strictly inside `root` (symlinks resolved). */
export function insideRoot(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const full = realpathSync(resolve(path));
  if (!full.startsWith(realRoot + sep)) throw new Error(`path outside scratch: ${path}`);
  return full;
}

/** Walks a tree without following symlinks. */
export function walk(path: string, visit: (p: string, isDir: boolean) => void): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    visit(path, false);
    return;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(path)) walk(join(path, e), visit);
  }
  visit(path, st.isDirectory());
}

/** Local development runner: no user separation, same limits and timing. */
export class LocalRunner implements Runner {
  readonly separated = false;
  private readonly scratchDir: string;
  /** Each role's process groups left running in the background. */
  private readonly background = new Map<string, Set<number>>();

  constructor(scratchDir: string) {
    this.scratchDir = scratchDir;
  }

  /** A run's supervision here: the request's command and limits, as the current user. */
  private spec(input: RunRequest) {
    const req = RunRequest.parse(input);
    insideRoot(this.scratchDir, req.cwd);
    const keep = req.keepBackground === true && /^lane-\d+$/.test(req.role) && !req.gpu;
    return {
      argv: req.argv,
      cwd: req.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: req.cwd, ...req.env },
      timeoutMs: req.timeoutMs,
      rssLimitBytes: req.rssLimitBytes,
      spareExe: req.spareExe,
      spareRoot: req.spareRoot,
      disk: req.disk,
      stdin: req.stdin,
      captureBytes: req.captureBytes,
      leaveBackground: keep,
    };
  }

  async runPair(driver: RunRequest, candidate: RunRequest): Promise<PairOutcome> {
    return runPairSupervised(this.spec(driver), this.spec(candidate));
  }

  async run(input: RunRequest): Promise<RunOutcome> {
    const req = RunRequest.parse(input);
    const r = await runSupervised(this.spec(req));
    // Without users, a role's background work is known by its process groups.
    if (r.pgid !== undefined) {
      const groups = this.background.get(req.role) ?? new Set<number>();
      groups.add(r.pgid);
      this.background.set(req.role, groups);
    }
    return r;
  }

  async handOver(path: string): Promise<void> {
    insideRoot(this.scratchDir, path);
  }

  async reclaim(path: string): Promise<void> {
    const full = insideRoot(this.scratchDir, path);
    // A run may have left read-only directories; the controller must be able to clean up.
    walk(full, (p, isDir) => {
      if (isDir) chmodSync(p, 0o755);
    });
  }

  async remove(path: string): Promise<void> {
    const full = insideRoot(this.scratchDir, path);
    await this.reclaim(full);
    rmSync(full, { recursive: true, force: true });
  }

  async killRole(role: Role, opts: { gpu?: boolean } = {}): Promise<number> {
    if (opts.gpu) return 0; // dev runs leave nothing behind
    let killed = 0;
    for (const pgid of this.background.get(role) ?? []) killed += killScope({ pgid });
    this.background.delete(role);
    return killed;
  }
}

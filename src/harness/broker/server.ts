import { execFileSync } from "node:child_process";
import { chmodSync, chownSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { cardsOf, fenceArgs, type GpuLayout, identityFor } from "./devices.ts";
import { runPairSupervised } from "./pair.ts";
import { killScope, runSupervised, type SupervisedRun, sweepRole } from "./process.ts";
import { BrokerRequest, type BrokerResponse, type BrokerRequest as Req } from "./protocol.ts";
import { IDS, insideRoot, type Role, RunRequest, roleIds } from "./runner.ts";

/**
 * The privileged side of the broker (root, inside the harness container). It runs work as the
 * named role's user, hands scratch directories to roles and takes them back. It runs no
 * research code of its own and accepts paths only under the scratch directory.
 */

export interface BrokerServerOptions {
  socketPath: string;
  scratchDir: string;
  /** Extra environment every role gets (for example PATH). Never secrets. */
  baseEnv: Record<string, string>;
  /** A rig with a dedicated development card: who may open which card. */
  gpuLayout?: GpuLayout | undefined;
  /** Puts the device nodes' groups and modes back if anything changed them (before each run). */
  assertDevices?: (() => void) | undefined;
  /** The CPUs each timing user's processes (run, run-1, ...) are pinned to; none when unset. */
  runCpus?: Record<string, string> | undefined;
  /** The GPU fence's program (thermite-devfence), where the kernel has Landlock; none: no fence. */
  fence?: string | undefined;
}

const LANE_ROLES: Role[] = Array.from({ length: IDS.maxLanes }, (_, i) => [
  `lane-${i + 1}`,
  `lane-${i + 1}-dev`,
  `agent-${i + 1}`,
]).flat();
const RUN_ROLES: Role[] = ["run", ...Array.from({ length: 7 }, (_, i) => `run-${i + 1}` as Role)];
const BUILDER_ROLES: Role[] = [
  "builder",
  ...Array.from({ length: 7 }, (_, i) => `builder-${i + 1}` as Role),
];
/** The kit's own programs: its check, and its driver where it has one, for each judge card. */
const KIT_ROLES: Role[] = ["checker", "driver"].flatMap((r) => [
  r as Role,
  ...Array.from({ length: 7 }, (_, i) => `${r}-${i + 1}` as Role),
]);
export const ALL_ROLES: Role[] = [
  ...BUILDER_ROLES,
  ...RUN_ROLES,
  ...KIT_ROLES,
  "planner",
  "model-check",
  ...LANE_ROLES,
];

/** Runs of the timing users (run, run-1, ...) at work now: the judge may be timing one. */
let timedAtWork = 0;
export const timedRunsAtWork = (): number => timedAtWork;

/**
 * Changes a tree's owner with coreutils: `chown -R -P` never follows symlinks and walks trees of
 * any depth (a candidate can make paths far longer than PATH_MAX). The top becomes 0700.
 */
function chownTree(path: string, uid: number, gid: number): void {
  execFileSync("chown", ["-R", "-P", `${uid}:${gid}`, path], { stdio: "ignore" });
  // The new owner must be able to read, enter and remove everything it now owns.
  execFileSync("chmod", ["-R", "u+rwX", path], { stdio: "ignore" });
  chmodSync(path, 0o700);
}

function clearSetIdBits(dir: string): void {
  try {
    execFileSync(
      "find",
      [dir, "-xdev", "-type", "f", "-perm", "/6000", "-exec", "chmod", "ug-s", "{}", "+"],
      { stdio: "ignore" },
    );
  } catch (err) {
    log("broker", "could not clear set-id bits", { dir, error: String(err) }, "warn");
  }
}

/** Per-role process limits (RLIMIT_NPROC): builds may run parallel compilers. */
const NPROC: Record<string, number> = Object.fromEntries(BUILDER_ROLES.map((r) => [r, 512]));

/**
 * A run's process limit: what the controller asked for (a lane's, from its contract), else the
 * role's default, 512 for builds and 256 for every other role.
 */
export function nprocFor(r: Pick<RunRequest, "role" | "nproc">): number {
  return r.nproc ?? NPROC[r.role] ?? 256;
}

/** A request checked, as the supervised run that does it: its user, groups, fence and limits. */
function supervised(
  r: ReturnType<typeof RunRequest.parse>,
  opts: BrokerServerOptions,
): SupervisedRun {
  insideRoot(opts.scratchDir, r.cwd);
  if (r.disk) insideRoot(opts.scratchDir, r.disk.path);
  if (r.gpu && !/^lane-\d+$/.test(r.role))
    throw new Error(`role ${r.role} may not ask for the gpu group`);
  if (r.devCard !== undefined && !r.gpu) throw new Error("devCard comes only with gpu");
  const identity = identityFor(r.role, r.gpu === true, opts.gpuLayout, r.devCard ?? 0);
  const { uid, gid, groups, cuda } = identity;
  const fence = opts.fence ? fenceArgs(identity) : undefined;
  const lane = /^lane-\d+$/.test(r.role);
  return {
    argv: r.argv,
    cwd: r.cwd,
    // The role's own directory is its home and its TMPDIR (/tmp is closed to roles), unless
    // the harness gives the run others in the role's own area (OpenCode's home and temp
    // directory, outside the workspace). Only the harness's controller makes requests here.
    // With a dedicated development card, CUDA is pointed at the role's own card (its groups
    // are what keep it off the other).
    env: {
      ...opts.baseEnv,
      ...r.env,
      HOME: r.env.HOME ?? r.cwd,
      TMPDIR: r.env.TMPDIR ?? r.cwd,
      USER: r.role,
      ...(cuda ? { CUDA_VISIBLE_DEVICES: cuda } : {}),
    },
    timeoutMs: r.timeoutMs,
    uid,
    gid,
    groups,
    cpus: opts.runCpus?.[r.role],
    fence: fence && opts.fence ? [opts.fence, ...fence, "--"] : undefined,
    rssLimitBytes: r.rssLimitBytes,
    spareExe: r.spareExe,
    spareRoot: r.spareRoot,
    disk: r.disk,
    nproc: nprocFor(r),
    stdin: r.stdin,
    captureBytes: r.captureBytes,
    // A lane's user runs both its plain commands and its dev runs: each is supervised and
    // cleaned up within its own group, and only plain commands may leave work running.
    ...(lane ? { scopeGid: gid, leaveBackground: !r.gpu && r.keepBackground === true } : {}),
  };
}

export async function handle(req: Req, opts: BrokerServerOptions): Promise<unknown> {
  switch (req.op) {
    case "run": {
      const r = RunRequest.parse(req.req);
      const spec = supervised(r, opts);
      // A root process using CUDA (an operator's exec, say) can reset a node to 0666.
      opts.assertDevices?.();
      // The state snapshot waits while one runs (snapshot.ts), so its copying stays out of timing.
      const timed = RUN_ROLES.includes(r.role);
      if (timed) timedAtWork++;
      const outcome = await runSupervised(spec).finally(() => {
        if (timed) timedAtWork--;
      });
      // A lane's dev runs have the gpu group: a setgid file left behind would let its plain
      // runs reach the device outside the judge's gate. Such bits are cleared after every lane
      // run (no_new_privs also makes the kernel ignore them; this does not rely on it).
      if (/^lane-\d+(-dev)?$/.test(r.role)) clearSetIdBits(r.disk?.path ?? r.cwd);
      return outcome;
    }
    case "runPair": {
      // A kit's driver and the candidate it measures, on one judge card: driver-i and run-i.
      const driver = RunRequest.parse(req.driver);
      const candidate = RunRequest.parse(req.candidate);
      const card = (role: string, kind: string) =>
        new RegExp(`^${kind}(?:-([1-7]))?$`).exec(role)?.[1] ?? (role === kind ? "0" : undefined);
      const at = card(driver.role, "driver");
      if (at === undefined || card(candidate.role, "run") !== at || candidate.gpu || driver.gpu)
        throw new Error(
          `a pair is a judge card's driver and timing user, not ${driver.role} and ${candidate.role}`,
        );
      const specs = [supervised(driver, opts), supervised(candidate, opts)] as const;
      opts.assertDevices?.();
      timedAtWork++;
      return await runPairSupervised(...specs).finally(() => {
        timedAtWork--;
      });
    }
    case "handOver": {
      const { uid, gid } = roleIds(req.role);
      const path = insideRoot(opts.scratchDir, req.path);
      chownTree(path, uid, gid);
      // The controller's group, which no role is in, may enter and read; other roles may not.
      if (req.harnessReads) {
        chownSync(path, uid, IDS.thermite.gid);
        chmodSync(path, 0o750);
      }
      return null;
    }
    case "reclaim":
      chownTree(insideRoot(opts.scratchDir, req.path), IDS.thermite.uid, IDS.thermite.gid);
      return null;
    case "remove": {
      execFileSync("rm", ["-rf", "--one-file-system", insideRoot(opts.scratchDir, req.path)], {
        stdio: "ignore",
      });
      return null;
    }
    case "killRole": {
      const { uid } = roleIds(req.role);
      if (req.gpu) {
        if (!/^lane-\d+$/.test(req.role)) throw new Error(`role ${req.role} has no dev runs`);
        // Its dev runs on any development card.
        const cards = opts.gpuLayout ? cardsOf(opts.gpuLayout).devs.length : 1;
        let killed = 0;
        for (let k = 0; k < cards; k++)
          killed += killScope({ uid, gid: identityFor(req.role, true, opts.gpuLayout, k).gid });
        return killed;
      }
      const killed = killScope({ uid });
      // What its background work left in shared places goes with it.
      sweepRole(uid);
      return killed;
    }
  }
}

export function startBrokerServer(opts: BrokerServerOptions): Server {
  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let id = -1;
        void (async () => {
          let res: BrokerResponse;
          try {
            const raw: unknown = JSON.parse(line);
            // A refused request is still answered under its own id, when it has one, so the
            // caller hears the refusal instead of waiting for an answer that never comes.
            const own = (raw as { id?: unknown } | null)?.id;
            if (Number.isSafeInteger(own)) id = own as number;
            const req = BrokerRequest.parse(raw);
            id = req.id;
            res = { id, ok: true, result: await handle(req, opts) };
          } catch (err) {
            res = { id, ok: false, error: errorText(err) };
            log("broker", "request refused", { error: res.error }, "warn");
          }
          if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
        })();
      }
    });
    sock.on("error", () => undefined);
  });
  server.listen(opts.socketPath);
  return server;
}

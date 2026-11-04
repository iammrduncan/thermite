import { resolve } from "node:path";
import type { LaneLimitValues } from "../../core/contract.ts";
import { type Role, type Runner, type RunOutcome, RunRequest } from "../broker/index.ts";
import { laneCacheEnv } from "./workspace.ts";

/**
 * A worker's lane work (`/v1/lane/run`): only in its own trial's workspace, as its lane's user,
 * with the lane tool or a shell command, within the limits of a lane's run. The harness that holds
 * the workspace runs it: the leader's for a lane of its own, a follower's for a lane on it (goal
 * 205).
 */
export interface LaneRunner {
  runner: Runner;
  /** How the broker runs the lane's file tool: node and lanetool's entry. */
  laneTool: string[];
  scratchDir: string;
}

export function laneRun(
  o: LaneRunner,
  trial: { lane: string; root: string; limits: LaneLimitValues },
  body: unknown,
  refuse: (why: string) => Error,
): Promise<RunOutcome> {
  const req = RunRequest.parse(body);
  const inside = (p: string) => {
    const full = resolve(p);
    return full === trial.root || full.startsWith(`${trial.root}/`);
  };
  if (req.role !== trial.lane) throw refuse("not this trial's lane");
  if (req.gpu) throw refuse("device runs go through dev_run");
  if (!inside(req.cwd) || (req.disk && !inside(req.disk.path)))
    throw refuse("outside the trial's workspace");
  // The contract's lane limits bound every lane command: memory and disk always (defaults when it
  // sets none), time only when it sets one.
  const limits = trial.limits;
  const rssCap = limits.runRssMib * 1024 ** 2;
  const diskCap = limits.workspaceMib * 1024 ** 2;
  let argv: string[];
  if (req.argv[0] === "lanetool") argv = [...o.laneTool, ...req.argv.slice(1)];
  else if (req.argv.length === 3 && req.argv[0] === "sh" && req.argv[1] === "-c") argv = req.argv;
  else throw refuse("only the lane tool or a shell command");
  return o.runner.run({
    role: trial.lane as Role,
    argv,
    cwd: req.cwd,
    env: laneCacheEnv(o.scratchDir, trial.lane),
    ...timeLimit(req.timeoutMs, limits.runTimeoutS),
    rssLimitBytes: Math.min(req.rssLimitBytes ?? rssCap, rssCap),
    ...(req.disk
      ? { disk: { path: req.disk.path, limitBytes: Math.min(req.disk.limitBytes, diskCap) } }
      : {}),
    ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    // From the contract, never from the request.
    nproc: limits.processes,
    captureBytes: Math.min(req.captureBytes ?? 64 * 1024, 32 * 1024 * 1024),
    // As in a shell: what a command starts in the background runs on until the trial ends.
    keepBackground: true,
  });
}

/** A command's time limit: what it asked for, within the contract's limit if there is one. */
function timeLimit(
  askedMs: number | undefined,
  limitS: number | undefined,
): { timeoutMs?: number } {
  const capMs = limitS !== undefined ? limitS * 1000 : undefined;
  const ms =
    askedMs === undefined ? capMs : capMs === undefined ? askedMs : Math.min(askedMs, capMs);
  return ms !== undefined ? { timeoutMs: ms } : {};
}

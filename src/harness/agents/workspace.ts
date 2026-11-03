import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Role, Runner } from "../broker/index.ts";
import { exportTree } from "../git.ts";

const run = promisify(execFile);

/**
 * A lane's workspace for one trial: the parent commit's tree as a fresh git repository (one
 * commit, so `git diff` gives exactly the candidate's change), owned by the lane's user. The
 * lane never sees the harness's mirror, other lanes or the parent's history.
 */
/**
 * A lane's cache directory: owned by the lane's user and kept across its trials (compiler caches
 * such as ccache), so a fresh workspace need not rebuild a large project from nothing. Only the
 * lane itself uses it; the judge builds without it.
 */
export function laneCacheDir(scratchDir: string, lane: string): string {
  return join(scratchDir, "lanes", lane, "cache");
}

/**
 * The environment that points a lane's commands at its cache. Each trial's workspace is a new
 * folder in the lane's, so ccache rewrites the paths under the lane's folder relative to the
 * build folder and leaves that folder out of its hash: a build in the same place of the checkout
 * then hits what an earlier trial compiled (goal 144).
 */
export function laneCacheEnv(scratchDir: string, lane: string): Record<string, string> {
  const dir = laneCacheDir(scratchDir, lane);
  return {
    THERMITE_LANE_CACHE: dir,
    CCACHE_DIR: dir,
    CCACHE_MAXSIZE: "8G",
    CCACHE_BASEDIR: join(scratchDir, "lanes", lane),
    CCACHE_NOHASHDIR: "1",
  };
}

export async function prepareWorkspace(input: {
  runner: Runner;
  scratchDir: string;
  mirror: string;
  commit: string;
  lane: Role;
}): Promise<{ dir: string; repo: string }> {
  const dir = join(input.scratchDir, "lanes", input.lane, randomUUID());
  const repo = join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  const cache = laneCacheDir(input.scratchDir, input.lane);
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true });
    // Handed over without the controller's read: the broker leaves it 0700, its lane's alone (the
    // isolation selftest's lane-cache probe).
    await input.runner.handOver(cache, input.lane);
  }
  await exportTree(input.mirror, input.commit, repo);
  const git = (...args: string[]) =>
    run(
      "git",
      [
        "-c",
        "user.name=thermite",
        "-c",
        "user.email=thermite@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
  await git("init", "--quiet", "-b", "work");
  await git("add", "-A");
  await git("commit", "--quiet", "--allow-empty", "-m", `parent ${input.commit}`);
  // The controller follows a trial's output in its area (OpenCode writes its events there).
  await input.runner.handOver(dir, input.lane, { harnessReads: true });
  return { dir, repo };
}

/**
 * A research trial's own area in its lane, for OpenCode's home, temporary files and events: owned
 * by the lane's user and removed when the trial ends. (The agent works in its lane's working
 * area of the research folder, research/folder.ts, which outlives the trial.)
 */
export async function prepareResearchArea(input: {
  runner: Runner;
  scratchDir: string;
  lane: Role;
}): Promise<{ dir: string }> {
  const dir = join(input.scratchDir, "lanes", input.lane, randomUUID());
  mkdirSync(dir, { recursive: true });
  // The controller follows the trial's output in its area (OpenCode writes its events there).
  await input.runner.handOver(dir, input.lane, { harnessReads: true });
  return { dir };
}

/**
 * Who runs a role's processes as the role's own user, as the agent runtimes see it (goal 169): the
 * harness's broker (src/harness/broker/), for the lanes, the planner and the model check. A
 * caller names a role; which user that is, and the limits it runs under, are the runner's.
 */

/** One run of a command as a role's user, in the role's folder. */
export interface RoleRunRequest {
  role: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string> | undefined;
  /** Unset: no time limit (the run ends with its command, or when its role is killed). */
  timeoutMs?: number | undefined;
  /** Its memory, disk and process limits, where the runner keeps them (a lane's). */
  rssLimitBytes?: number | undefined;
  /** An agent's own executable, spared when its commands pass the memory limit (OpenCode). */
  spareExe?: string | undefined;
  /** The run's own first process is spared too: the terminal host, which holds the program. */
  spareRoot?: boolean | undefined;
  disk?: { path: string; limitBytes: number } | undefined;
  nproc?: number | undefined;
  /** Written to the command's stdin. */
  stdin?: string | undefined;
  /** Bytes of stdout and stderr kept (the tail). */
  captureBytes?: number | undefined;
}

/** How a run ended: its exit, the limit it was ended for, and the tails of its output. */
export interface RoleRunOutcome {
  exitCode: number | null;
  signal: string | null;
  killedFor: "timeout" | "memory" | "disk" | null;
  stdout: string;
  stderr: string;
  /** Where the runner measures them (the broker). */
  peakRssBytes?: number | undefined;
  peakDiskBytes?: number | undefined;
  peakEntries?: number | undefined;
}

/** What the agent runtimes ask of a runner. */
export interface RoleRunner {
  run(req: RoleRunRequest): Promise<RoleRunOutcome>;
  /**
   * Gives a folder to a role, which may then write there. With `harnessReads`, its caller may
   * still enter and read it; no other role may.
   */
  handOver(path: string, role: string, opts?: { harnessReads?: boolean }): Promise<void>;
  /** Removes a folder, whoever owns its files. */
  remove(path: string): Promise<void>;
  /** Ends every process of a role; how many it ended. */
  killRole(role: string): Promise<number>;
}

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Thermite's git (goal 125, T3): one runner, with a named time limit and output limit. Every call
 * reads no system configuration and never asks for a password. A caller adds its identity or
 * other variables in `env`; with `only`, the call's environment is PATH and `env` alone, as
 * control's own repositories keep theirs.
 */

/** The longest one git call may take: a fetch or a push of a large repository fits. */
export const GIT_TIMEOUT_MS = 30 * 60_000;
/** The most output one git call returns: a large patch or bundle fits. */
export const GIT_MAX_BYTES = 512 * 1024 * 1024;

export interface GitOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /** The environment is PATH and `env` alone, nothing else of the caller's. */
  only?: boolean | undefined;
  input?: string | Buffer | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

/** Git refused something, or a git call failed: then with its subcommand and git's own words. */
export class GitError extends Error {
  /** Git's standard error, as it wrote it, when a call failed. */
  readonly stderr: string;
  readonly subcommand: string;
  constructor(message: string, stderr = "", subcommand = "") {
    super(message);
    this.stderr = stderr;
    this.subcommand = subcommand;
  }
}

/** The subcommand of git's arguments: the first word that is not an option or an option's value. */
function subcommandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") i++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

function settings(o: GitOptions) {
  const base = o.only ? { PATH: process.env.PATH ?? "/usr/bin:/bin" } : process.env;
  return {
    cwd: o.cwd,
    env: { ...base, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...o.env },
    timeout: o.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: o.maxBytes ?? GIT_MAX_BYTES,
  };
}

function failure(args: readonly string[], o: GitOptions, err: unknown): GitError {
  const e = err as {
    stderr?: Buffer | string;
    message?: string;
    killed?: boolean;
    signal?: string;
  };
  const stderr = e.stderr === undefined ? "" : e.stderr.toString().trim();
  const why =
    e.killed && e.signal === "SIGTERM"
      ? `no answer within ${Math.round((o.timeoutMs ?? GIT_TIMEOUT_MS) / 1000)} s`
      : stderr || String(e.message ?? err);
  const sub = subcommandOf(args);
  return new GitError(`git ${sub} failed: ${why}`, stderr, sub);
}

/** Runs git with `args`; its standard output. Throws GitError with git's own words. */
export async function git(args: string[], o: GitOptions = {}): Promise<Buffer> {
  try {
    const child = run("git", args, { ...settings(o), encoding: "buffer" });
    if (o.input !== undefined) child.child.stdin?.end(o.input);
    return (await child).stdout;
  } catch (err) {
    throw failure(args, o, err);
  }
}

/** git, its standard output as text. */
export async function gitText(args: string[], o: GitOptions = {}): Promise<string> {
  return (await git(args, o)).toString("utf8");
}

/** git, synchronously: for code that can't wait, such as control's own repositories. */
export function gitSync(args: string[], o: GitOptions = {}): Buffer {
  try {
    // Its standard error is captured, never written to the caller's own.
    const stdio: "pipe"[] = ["pipe", "pipe", "pipe"];
    // Input as bytes: a string would be read with the call's encoding, which is none here.
    const input = typeof o.input === "string" ? Buffer.from(o.input) : o.input;
    return execFileSync("git", args, { ...settings(o), input, stdio, encoding: "buffer" });
  } catch (err) {
    throw failure(args, o, err);
  }
}

import { type StdioOptions, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, write } from "node:fs";
import { createRequire } from "node:module";
import type { Writable } from "node:stream";
import { ReadStream } from "node:tty";
import { errorText } from "../../common/errors.ts";

/**
 * A program on a pseudo-terminal of its own. The pair comes from node-pty's `open`, and the host
 * starts the program on it itself, through util-linux's `setsid -c`, which makes the program a new
 * session's leader with the terminal as its controlling one. node-pty's own spawn would do that
 * too, but it passes the program no other file descriptor, and Claude Code reads its sign-in from
 * file descriptor 3 (decision 51): here it is a pipe the host writes the token to, then closes.
 *
 * The program holds only the terminal's own end of the pair. node-pty opens the host's end without
 * close-on-exec, so the program gets /dev/null in that end's place: neither it nor a command it
 * runs holds the end the host types into it with.
 */

/** util-linux's setsid, which the harness image has (the build checks it); none on macOS. */
export const SETSID = ["/usr/bin/setsid", "/bin/setsid"].find((p) => existsSync(p));

/** node-pty's native part: `open` gives a pair at a size, its ends as file descriptors. */
interface PtyNative {
  open(cols: number, rows: number): { master: number; slave: number; pty: string };
}

/**
 * node-pty's native part, through its `native` export. node-pty is an optional dependency: npm
 * leaves it out where it cannot build it, and the harness image builds it.
 */
function ptyNative(): PtyNative {
  try {
    const pty = createRequire(import.meta.url)("node-pty") as { native: PtyNative | null };
    if (pty.native) return pty.native;
    throw new Error("it has no native part on this platform");
  } catch (err) {
    throw new Error(`the terminal host needs node-pty, which is not built here: ${errorText(err)}`);
  }
}

export interface PtyExit {
  code: number | null;
  signal: string | null;
  /** It could not start: why. */
  error?: string | undefined;
}

export interface PtyProgram {
  pid: number | undefined;
  /** Queued and written in order, as the terminal takes them. */
  write(data: string): void;
  signal(sig: NodeJS.Signals): void;
  readonly exited: Promise<PtyExit>;
}

/**
 * The program's file descriptors: the terminal's end as 0, 1 and 2, the token's pipe as 3, and
 * `nul` (/dev/null) as the host's end's number, which takes that end's place in the program.
 */
export function programStdio(
  pair: { master: number; slave: number },
  token: boolean,
  nul: number,
): StdioOptions {
  const fds: StdioOptions = [pair.slave, pair.slave, pair.slave, token ? "pipe" : "ignore"];
  for (let fd = fds.length; fd <= pair.master; fd++) fds.push(fd === pair.master ? nul : "ignore");
  return fds;
}

/** A write the terminal would not take yet is tried again after this. */
const RETRY_MS = 10;
/** After the program exits, what it wrote last is still read for this long. */
const DRAIN_MS = 200;

/**
 * Starts `argv` (from its absolute path) on a new pseudo-terminal of `cols` by `rows`, in `cwd`
 * with `env`. What it writes goes to `output`, as text. `token`, when given, is written to its
 * file descriptor 3, which is then closed.
 */
export function startOnPty(o: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  token?: string | undefined;
  output: (data: string) => void;
}): PtyProgram {
  if (!SETSID) throw new Error("the terminal host needs util-linux's setsid, which is not here");
  const pair = ptyNative().open(o.cols, o.rows);
  const nul = openSync("/dev/null", "r");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(SETSID, ["-c", ...o.argv], {
      cwd: o.cwd,
      env: o.env,
      stdio: programStdio(pair, o.token !== undefined, nul),
    });
  } finally {
    closeSync(nul);
  }
  closeSync(pair.slave);
  if (o.token !== undefined) {
    const fd3 = child.stdio[3] as Writable | null;
    // The program may exit before it reads the token.
    fd3?.on("error", () => undefined);
    fd3?.end(o.token);
  }
  const out = new ReadStream(pair.master);
  out.setEncoding("utf8");
  out.on("data", (d: string) => o.output(d));
  // EIO once the program and all it started have closed their end: the end of its output.
  out.on("error", () => undefined);

  const queue: Buffer[] = [];
  let writing = false;
  let closed = false;
  const next = (): void => {
    const head = queue[0];
    if (writing || closed || !head) return;
    writing = true;
    write(pair.master, head, 0, head.length, null, (err, n) => {
      writing = false;
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") setTimeout(next, RETRY_MS);
        else queue.length = 0;
        return;
      }
      if (n < head.length) queue[0] = head.subarray(n);
      else queue.shift();
      next();
    });
  };

  const exited = new Promise<PtyExit>((resolve) => {
    child.on("error", (err) => resolve({ code: null, signal: null, error: errorText(err) }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  }).then(async (e) => {
    await new Promise((r) => setTimeout(r, DRAIN_MS));
    closed = true;
    out.destroy();
    return e;
  });

  return {
    pid: child.pid,
    write(data) {
      if (closed || !data) return;
      queue.push(Buffer.from(data, "utf8"));
      next();
    },
    signal(sig) {
      try {
        child.kill(sig);
      } catch {
        // gone already
      }
    },
    exited,
  };
}

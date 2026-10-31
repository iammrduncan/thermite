import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lchownSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import {
  ADVISOR_RUN_LIMITS,
  ADVISOR_USERS,
  type AdvisorRunAnswer,
  type AdvisorRunOutcome,
  AdvisorRunRequest,
} from "../../core/advisor-runs.ts";
import { errorText } from "../errors.ts";
import { log } from "../log.ts";

/**
 * The root side of the advisors' runner (core/advisor-runs.ts): it runs each advisor program as
 * an advisor user, in a folder the caller made under `root`, and does nothing else as root. It
 * changes the owner only of a run's folder, and only of what the caller's own user made there; it
 * kills only its advisor users' processes; it removes only its root's children.
 *
 * The broker does the same for the harness's roles (src/harness/broker/): this helper keeps its
 * own small copy of the broker's kill of every process of a user, since the supervisor may not
 * import the harness.
 */

export interface RunAsServerOptions {
  socketPath: string;
  /** Where the caller makes each run's folder: a run's folder is one of its children. */
  root: string;
  /** The caller's group: it reads a run's folder while the run's user owns it. */
  callerGid: number;
  /**
   * Whether each run is an advisor user of its own: root's helper (the default when root). Not
   * root (development, tests), every run is the helper's own user, in its own process group.
   */
  separate?: boolean | undefined;
  /**
   * A command each run's program starts under, its argv after it: in the one-container rig image,
   * no_new_privs and the GPU fence, as the supervisor's own (src/harness/broker/one-container.ts).
   */
  wrap?: readonly string[] | undefined;
}

/** The processes of a user, from /proc (Linux). */
function processesOf(uid: number): number[] {
  if (!existsSync("/proc/self/status")) return [];
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) === uid) pids.push(Number(name));
    } catch {
      // the process ended while it was read
    }
  }
  return pids;
}

/**
 * Kills every process of a user, as the broker does: a process of the user's own signals all it
 * may (kill(-1)), so a process that forks as it is killed is still the user's, and none other is.
 */
function killUser(uid: number): number {
  let killed = 0;
  for (let round = 0; round < 10; round++) {
    const left = processesOf(uid);
    if (!left.length) return killed;
    killed += left.length;
    spawnSync(process.execPath, ["-e", "try { process.kill(-1, 'SIGKILL') } catch {}"], {
      uid,
      gid: uid,
      stdio: "ignore",
      timeout: 5000,
    });
  }
  return killed;
}

/** Kills a process group, if any of it is left. */
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // gone already
  }
}

/** The tail of what a stream printed, at most `max` characters. */
function tail(stream: NodeJS.ReadableStream | null, max: number): () => string {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (d: string) => {
    text = (text + d).slice(-max);
  });
  return () => text;
}

export class RunAsServer {
  private readonly o: Required<RunAsServerOptions>;
  /** The folders of the runs at work now, and each one's advisor user (n of ADVISOR_USERS). */
  private readonly busy = new Map<string, number>();
  readonly server: Server;

  constructor(o: RunAsServerOptions) {
    this.o = { ...o, separate: o.separate ?? process.getuid?.() === 0, wrap: o.wrap ?? [] };
    this.server = createServer((sock) => this.serve(sock));
  }

  listen(): Server {
    return this.server.listen(this.o.socketPath);
  }

  /**
   * A run's folder: a folder (not a link) whose parent is the root. Returns its real path, and the
   * uid of the root's owner, the caller's user.
   */
  private folder(dir: string): { path: string; caller: number } {
    const root = realpathSync(this.o.root);
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`not a folder: ${dir}`);
    const path = realpathSync(dir);
    if (dirname(path) !== root) throw new Error(`a run's folder is one of ${root}'s: not ${dir}`);
    return { path, caller: lstatSync(root).uid };
  }

  /**
   * Gives a run's folder to its user, with the caller's group, which may read it: only what the
   * caller's own user made there, with no file linked from elsewhere. Links are never followed.
   */
  private handOver(path: string, caller: number, uid: number): void {
    const entries: string[] = [];
    const walk = (p: string) => {
      const st = lstatSync(p);
      if (st.uid !== caller) throw new Error(`${p} is not the caller's own`);
      if (st.isFile() && st.nlink > 1) throw new Error(`${p} is linked from elsewhere`);
      if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
      entries.push(p);
    };
    walk(path);
    for (const p of entries) {
      lchownSync(p, uid, this.o.callerGid);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      // Its user may read and change what it now owns; the caller's group may read it.
      chmodSync(p, st.isDirectory() ? 0o2750 : (st.mode & 0o700) | 0o040);
    }
  }

  /**
   * Gives a run's folder back to the caller once every process of its user has ended, so that it
   * reads what the run left, a folder the program made private among it: what the run's user owns
   * there, at most ADVISOR_RUN_LIMITS.handBackEntries entries, with no set-id bit kept. A file
   * with a second hard link, or anything else, stays as it is until the folder is removed. Links
   * are never followed.
   */
  private handBack(path: string, uid: number, caller: number): void {
    let left = ADVISOR_RUN_LIMITS.handBackEntries;
    const walk = (p: string) => {
      if (left-- <= 0) return;
      const st = lstatSync(p);
      if (st.uid !== uid || (st.isFile() && st.nlink > 1)) return;
      if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
      lchownSync(p, caller, this.o.callerGid);
      if (st.isDirectory()) chmodSync(p, 0o2750);
      else if (st.isFile()) chmodSync(p, (st.mode & 0o700) | 0o640);
    };
    walk(path);
  }

  /** One run, as a free advisor user, from its folder's hand-over to every process's end. */
  private run(req: Extract<AdvisorRunRequest, { op: "run" }>, sock: Socket) {
    const { path, caller } = this.folder(req.dir);
    if (this.busy.has(path)) throw new Error(`a run uses ${req.dir} now`);
    const separate = this.o.separate;
    const taken = new Set(this.busy.values());
    const n = separate
      ? Array.from({ length: ADVISOR_USERS.count }, (_, i) => i + 1).find((k) => !taken.has(k))
      : 0;
    if (n === undefined)
      throw new Error(`every advisor user is busy: ${ADVISOR_USERS.count} advisor calls run now`);
    const uid = ADVISOR_USERS.base + n;
    this.busy.set(path, n);
    const release = () => this.busy.delete(path);
    try {
      if (separate) this.handOver(path, caller, uid);
    } catch (err) {
      release();
      throw err;
    }
    return new Promise<AdvisorRunOutcome>((resolve) => {
      let child: ChildProcess | undefined;
      let timedOut = false;
      let done = false;
      let out = () => "";
      let err = () => "";
      const cleanUp = () => {
        if (separate) killUser(uid);
        else killGroup(child?.pid);
      };
      // The caller gone (the supervisor stopped): its run goes too.
      const abandoned = () => cleanUp();
      const timer =
        req.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              cleanUp();
            }, req.timeoutMs)
          : undefined;
      const finish = (exitCode: number | null, signal: string | null, error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanUp();
        let back: string | undefined;
        try {
          if (separate) this.handBack(path, uid, caller);
        } catch (e) {
          back = `the run's folder was not given back: ${errorText(e)}`;
          log(
            "advisor-runs",
            "a run's folder was not given back",
            { dir: path, error: back },
            "warn",
          );
        }
        release();
        sock.off("close", abandoned);
        const more = [error, back].filter(Boolean).join("\n");
        const stderr = more ? `${err()}${more}`.slice(-ADVISOR_RUN_LIMITS.stderrChars) : err();
        resolve({ user: n, exitCode, signal, timedOut, stdout: out(), stderr });
      };
      sock.on("close", abandoned);
      const stdio: "pipe"[] = ["pipe", "pipe", "pipe"];
      if (req.token !== undefined) stdio[3] = "pipe";
      const argv = [...this.o.wrap, ...req.argv];
      try {
        child = spawn(argv[0] as string, argv.slice(1), {
          cwd: path,
          // Only what the request gives, in its own folder: nothing of the helper's.
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            HOME: path,
            TMPDIR: path,
            ...req.env,
          },
          stdio,
          detached: true,
          ...(separate ? { uid, gid: uid } : {}),
        });
      } catch (e) {
        finish(null, null, errorText(e));
        return;
      }
      out = tail(child.stdout, ADVISOR_RUN_LIMITS.stdoutChars);
      err = tail(child.stderr, ADVISOR_RUN_LIMITS.stderrChars);
      if (req.token !== undefined) {
        const tokenPipe = child.stdio[3] as Writable | null | undefined;
        // A program that ends without reading it fails in its own words.
        tokenPipe?.on("error", () => undefined);
        tokenPipe?.end(req.token);
      }
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(req.stdin);
      // Its main process gone, nothing of its user stays: the pipes close with the last of it.
      child.on("exit", () => cleanUp());
      child.on("error", (e) => finish(null, null, e.message));
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  /** Removes a run's folder, once no run uses it. */
  private remove(dir: string): null {
    const { path } = this.folder(dir);
    if (this.busy.has(path)) throw new Error(`a run uses ${dir} now`);
    rmSync(path, { recursive: true, force: true });
    return null;
  }

  private serve(sock: Socket): void {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > ADVISOR_RUN_LIMITS.requestBytes && !buf.includes("\n")) {
        log("advisor-runs", "request refused", { error: "the request is too large" }, "warn");
        sock.destroy();
        return;
      }
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void this.answer(line, sock);
      }
    });
  }

  /** One request, answered under its id (a refused one too, when it has one). */
  private async answer(line: string, sock: Socket): Promise<void> {
    let id = -1;
    let res: AdvisorRunAnswer;
    try {
      const raw: unknown = JSON.parse(line);
      const own = (raw as { id?: unknown } | null)?.id;
      if (Number.isSafeInteger(own)) id = own as number;
      const req = AdvisorRunRequest.parse(raw);
      const result = req.op === "run" ? await this.run(req, sock) : this.remove(req.dir);
      res = { id, ok: true, result };
    } catch (err) {
      res = { id, ok: false, error: errorText(err) };
      log("advisor-runs", "request refused", { error: res.error }, "warn");
    }
    if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
  }
}

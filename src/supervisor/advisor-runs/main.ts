import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, chownSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { errorText } from "../../common/errors.ts";
import { log, logError, startLogging } from "../../common/log.ts";
import { restartAfter } from "../../common/restart.ts";
import { RunAsServer } from "../../common/run-as/index.ts";
import { ADVISOR_RUNS_ENV, ADVISOR_RUNS_SOCKET, advisorRunsDir } from "../../core/advisor-runs.ts";
import { SUPERVISOR_INBOX_DIR, SUPERVISOR_PASSWD_HOME } from "../../core/paths.ts";
import { prepareSupervisorFolders } from "./folders.ts";

/**
 * The supervisor image's entry: its container's long-running root process (under tini as PID 1),
 * as the broker is the harness's. As root, it
 *
 * - closes what the advisor users must not reach (folders.ts): the secret files' folder and
 *   /etc/thermite to root and the supervisor's group, the folder the inbox is mounted in, and the
 *   supervisor's state and results to the supervisor alone;
 * - serves the advisors' runner (src/common/run-as/) on a socket only root and the supervisor's
 *   group may open, which runs each advisor's program as an advisor user of its own;
 * - starts the supervisor as its own user (10001), with no capability, in its own process group,
 *   and starts it again whenever it exits, as the broker starts the controller: after a second if
 *   it ran for more than a minute, else twice as long as the last time, up to 30 s. A run the
 *   supervisor had under way ends with it (its connection to the runner closes).
 *
 * On SIGTERM or SIGINT it passes the signal on and exits with the supervisor's code once it has
 * ended; a second signal ends it at once. SIGUSR2 goes on to the supervisor too. Run as another
 * user, it starts only the supervisor, without the runner, and only with
 * THERMITE_ALLOW_UNSEPARATED=1 (development); otherwise it stops.
 */

/** The supervisor's user and group in the image (containers/supervisor/Containerfile). */
const SUPERVISOR = { uid: 10001, gid: 10001 };

const env = process.env;
const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
const runsDir = advisorRunsDir(home);
const supervisorMain = fileURLToPath(new URL("../main.js", import.meta.url));
const isRoot = process.getuid?.() === 0;
let child: ChildProcess | undefined;
let stopping = false;
let restarts = 0;
startLogging("advisor-runs", env, () => [child]);

function fatal(msg: string, fields: Record<string, unknown>): never {
  logError("advisor-runs", `fatal: ${msg}`, fields);
  process.exit(1);
}

function startSupervisor(extraEnv: Record<string, string>): void {
  if (stopping) process.exit(0);
  const startedAt = Date.now();
  const proc = spawn(process.execPath, [...process.execArgv, supervisorMain], {
    stdio: "inherit",
    env: { ...env, ...extraEnv },
    ...(isRoot ? SUPERVISOR : {}),
    detached: true,
  });
  child = proc;
  let ended = false;
  const end = (code: number | null, signal: string | null, error?: string) => {
    if (ended) return;
    ended = true;
    child = undefined;
    // Whatever it started ends with it.
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
    if (stopping) {
      log("advisor-runs", "stopped", { code });
      process.exit(code ?? 0);
    }
    const next = restartAfter(Date.now() - startedAt, restarts);
    restarts = next.restarts;
    log(
      "advisor-runs",
      "supervisor exited; restarting",
      { code, signal, ...(error ? { error } : {}), delay_ms: next.delayMs },
      "warn",
    );
    setTimeout(() => startSupervisor(extraEnv), next.delayMs);
  };
  proc.on("exit", (code, signal) => end(code, signal));
  proc.on("error", (err) => end(null, null, err.message));
}

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    const again = stopping;
    stopping = true;
    log("advisor-runs", "stopping", { signal: sig });
    if (!child) process.exit(0);
    if (again && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
      process.exit(1);
    }
    child.kill(sig);
  });

if (!isRoot) {
  if (env.THERMITE_ALLOW_UNSEPARATED !== "1")
    fatal("not root, so advisor programs cannot run as users of their own", {
      hint: "run the supervisor's container as root (it starts the supervisor as its own user), or set THERMITE_ALLOW_UNSEPARATED=1 for development only",
    });
  log(
    "advisor-runs",
    "not root: starting the supervisor WITHOUT advisor users of its own (explicitly allowed)",
    {},
    "warn",
  );
  startSupervisor({});
} else {
  const inbox = env.THERMITE_INBOX_DIR ?? SUPERVISOR_INBOX_DIR;
  try {
    const done = prepareSupervisorFolders(
      {
        closed: ["/run/secrets", "/etc/thermite"],
        inboxParent: dirname(SUPERVISOR_INBOX_DIR),
        inbox,
        own: [home, "/results"],
        runs: runsDir,
        socketDir: dirname(ADVISOR_RUNS_SOCKET),
      },
      { root: 0, ...SUPERVISOR },
    );
    log("advisor-runs", "the supervisor's folders", { done });
  } catch (err) {
    fatal("could not close the supervisor's folders", {
      error: errorText(err),
      hint: "the container needs CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID and SETUID (compose.yaml gives them) and a disk it may change",
    });
  }
  rmSync(ADVISOR_RUNS_SOCKET, { force: true });
  const server = new RunAsServer({
    socketPath: ADVISOR_RUNS_SOCKET,
    root: runsDir,
    callerGid: SUPERVISOR.gid,
  }).listen();
  server.on("error", (err) =>
    fatal("the advisors' runner stopped", { socket: ADVISOR_RUNS_SOCKET, error: errorText(err) }),
  );
  server.on("listening", () => {
    chownSync(ADVISOR_RUNS_SOCKET, 0, SUPERVISOR.gid);
    chmodSync(ADVISOR_RUNS_SOCKET, 0o660);
    log("advisor-runs", "serving", { socket: ADVISOR_RUNS_SOCKET, runs: runsDir });
    startSupervisor({
      HOME: SUPERVISOR_PASSWD_HOME,
      USER: "supervisor",
      [ADVISOR_RUNS_ENV.socket]: ADVISOR_RUNS_SOCKET,
      [ADVISOR_RUNS_ENV.root]: runsDir,
    });
  });
}

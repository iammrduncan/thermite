import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { log, logError, logWarn } from "../../common/log.ts";
import { restartAfter } from "../../common/restart.ts";
import { RunAsServer } from "../../common/run-as/index.ts";
import { ADVISOR_RUNS_SOCKET } from "../../core/advisor-runs.ts";
import { podTunnelDirs } from "../../core/tunnel.ts";
import { type Broker, FENCE, fatalExit, SECRET_VARS, SG, SU, TG } from "./context.ts";
import { finishIfStopped } from "./controller.ts";
import { deviceNodes } from "./gpu.ts";
import {
  makeSupervisorFiles,
  pullMode,
  readEnrollment,
  SUPERVISOR_RECORD,
  type SupervisorPaths,
  type SupervisorRecord,
  supervisorArgv,
  supervisorEnv,
  supervisorGpu,
  supervisorPaths,
  writeControlKey,
} from "./one-container.ts";
import { killScope, SETPRIV } from "./process.ts";
import { WATCHED, watchHealth } from "./watch.ts";

/**
 * The supervisor in the one-container rig image (one-container.ts holds the rules): its folders and
 * the token it uses on the harness API, made at start; its start as its own user, again whenever it
 * exits; how it runs, recorded for the isolation selftest; and in pull mode, the wait for its
 * enrollment before the controller starts.
 */

/**
 * The one-container rig image: the supervisor's state and temporary directory (its own, closed
 * to every other user), the inbox it shares with the controller, and the token it uses on the
 * harness API (made once and kept by root; the supervisor gets a copy in its home at every
 * start). In pull mode, the harness's copy of control's key from an earlier start goes: it is
 * made again from this start's enrollment. Runs at start, before the secrets are read and before
 * anything else runs, so nothing can swap a path in the supervisor's home for a link meanwhile.
 */
export function prepareOneContainer(broker: Broker): SupervisorPaths {
  const paths = supervisorPaths(broker.env);
  if (pullMode(broker.env)) {
    const missing = [
      "THERMITE_RIG_ID",
      "THERMITE_CONTROL_PUBKEY_FILE",
      "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
    ].filter((k) => !broker.env[k]);
    if (
      missing.length ||
      !/^[0-9a-fA-F]{64}$/.test(broker.env.THERMITE_TUNNEL_CONTROL_KEY_SHA256 ?? "")
    ) {
      logError("broker", "fatal: pull mode needs the launch's values", {
        missing,
        hint: "THERMITE_TUNNEL_CONTROL_KEY_SHA256 is 64 hexadecimal characters",
      });
      fatalExit(broker);
    }
    rmSync(broker.env.THERMITE_CONTROL_PUBKEY_FILE as string, { force: true });
  }
  // The token the supervisor uses on the harness API: root's copy is the harness's secret file.
  const rootToken = broker.env.THERMITE_SUPERVISOR_TOKEN_FILE;
  if (!rootToken) {
    logError("broker", "fatal: the one-container image needs THERMITE_SUPERVISOR_TOKEN_FILE");
    fatalExit(broker);
  }
  if (!existsSync(rootToken)) {
    mkdirSync(dirname(rootToken), { recursive: true, mode: 0o700 });
    chmodSync(dirname(rootToken), 0o700);
    writeFileSync(rootToken, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    log("broker", "made the token between the supervisor and the harness", { file: rootToken });
  }
  supervisorFiles(broker, paths);
  return paths;
}

/** The supervisor's files, with its copy of root's harness token (one-container image only). */
function supervisorFiles(broker: Broker, paths: SupervisorPaths): void {
  const token = readFileSync(broker.env.THERMITE_SUPERVISOR_TOKEN_FILE as string, "utf8").trim();
  makeSupervisorFiles(paths, { uid: SU, gid: SG, inboxGid: TG }, token);
}

/** While the controller waits for enrollment, the broker says so at once and this often. */
const SAY_EVERY_MS = 10 * 60_000;

/**
 * Pull mode in the one-container image: the controller starts once the pod is enrolled. Root
 * reads what the supervisor's enrollment left (one-container.ts: readEnrollment), checks
 * control's key against the SHA-256 the launch named, and gives the harness a copy of its own,
 * so the supervisor never chooses the key the harness trusts. It takes the rig's settings from
 * control by name, as data, into the environment the controller starts with. Resolves false
 * when the broker is stopped first.
 */
export async function awaitEnrollment(broker: Broker, paths: SupervisorPaths): Promise<boolean> {
  const dir = podTunnelDirs(broker.env, paths.home).enrolledDir;
  const keyFile = broker.env.THERMITE_CONTROL_PUBKEY_FILE as string;
  const started = Date.now();
  let said = -Infinity;
  let lastWhy = "";
  while (!broker.stopping) {
    const e = readEnrollment({
      dir,
      rig: broker.env.THERMITE_RIG_ID as string,
      controlKeySha256: broker.env.THERMITE_TUNNEL_CONTROL_KEY_SHA256 as string,
      owner: SU,
    });
    if (e.state === "ready") {
      writeControlKey(keyFile, e.controlKeyPem);
      for (const [k, v] of Object.entries(e.settings)) broker.env[k] = v;
      log("broker", "enrolled: the harness starts with control's key from enrollment", {
        file: keyFile,
        settings: Object.keys(e.settings),
      });
      // The pod's keys and its enrollment, kept at once: a stop no longer loses them.
      broker.snapshots?.request("after enrollment");
      return true;
    }
    const waited = Date.now() - started;
    const why = e.state === "refused" ? e.why : "";
    if (why !== lastWhy || waited - said >= SAY_EVERY_MS) {
      said = waited;
      lastWhy = why;
      if (why)
        logWarn("broker", "refused what enrollment left: the harness waits", {
          why,
          waited_s: Math.round(waited / 1000),
        });
      else
        log(
          "broker",
          "waiting for enrollment: the harness starts once control has enrolled the pod",
          {
            dir,
            waited_s: Math.round(waited / 1000),
          },
        );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * The advisors' runner (src/common/run-as/) for the supervisor in one container: each advisor's
 * program runs as an advisor user of its own, under no_new_privs and in the GPU fence with no card
 * as the supervisor does, in a folder of the runs' root (beside the supervisor's state, which root
 * made at this start: the advisor users pass through it, listing nothing). Its socket is in a
 * folder only root and the supervisor's group may enter. Resolves once it serves.
 */
export async function startAdvisorRuns(broker: Broker, paths: SupervisorPaths): Promise<void> {
  rmSync(paths.advisorRuns, { recursive: true, force: true });
  mkdirSync(paths.advisorRuns, { recursive: true });
  chownSync(paths.advisorRuns, SU, SG);
  chmodSync(paths.advisorRuns, 0o711);
  const socketDir = dirname(ADVISOR_RUNS_SOCKET);
  mkdirSync(socketDir, { recursive: true });
  chownSync(socketDir, 0, SG);
  chmodSync(socketDir, 0o750);
  rmSync(ADVISOR_RUNS_SOCKET, { force: true });
  const server = new RunAsServer({
    socketPath: ADVISOR_RUNS_SOCKET,
    root: paths.advisorRuns,
    callerGid: SG,
    wrap: supervisorCommand(broker, []),
  }).listen();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      chownSync(ADVISOR_RUNS_SOCKET, 0, SG);
      chmodSync(ADVISOR_RUNS_SOCKET, 0o660);
      log("broker", "serving the advisors' runner", {
        socket: ADVISOR_RUNS_SOCKET,
        runs: paths.advisorRuns,
      });
      resolve();
    });
  });
}

/** The supervisor's command, once it runs as its user (one-container.ts: supervisorArgv). */
const supervisorCommand = (broker: Broker, command: string[]): string[] =>
  supervisorArgv(command, { setpriv: SETPRIV, fence: broker.fenceAbi ? FENCE : undefined });

/**
 * Records how the supervisor runs, for the isolation selftest: its user, the fence, and what its
 * user meets opening the GPU's device nodes, tried now as it is started. Again after the cards
 * are regrouped.
 */
export function recordSupervisor(broker: Broker, paths: SupervisorPaths): void {
  const gpu = supervisorGpu(deviceNodes(), process.execPath, (command) => {
    const argv = supervisorCommand(broker, command);
    const r = spawnSync(argv[0] as string, argv.slice(1), {
      uid: SU,
      gid: SG,
      cwd: paths.tmp,
      env: { PATH: broker.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || String(r.error ?? "") };
  });
  const record: SupervisorRecord = {
    uid: SU,
    gid: SG,
    fence: broker.fenceAbi ? "landlock" : "none",
    gpu,
    home: paths.home,
    at: new Date().toISOString(),
  };
  const path = join(broker.socketDir, SUPERVISOR_RECORD);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
  log("broker", "the supervisor's user and the GPU", { fence: record.fence, gpu });
}

/**
 * The supervisor, as its own user (one-container image only), in its own process group. When it
 * exits, whatever it started (an advisor's program) ends too, and it starts again. The broker
 * watches its health route too, and ends it when that fails (watch.ts).
 */
export function startSupervisor(broker: Broker, paths: SupervisorPaths): void {
  if (broker.stopping) {
    finishIfStopped(broker);
    return;
  }
  // Made again before each start: a full reset's wipe empties its home (goal 165). None of its
  // processes runs now, so nothing of its can swap a path in its home for a link meanwhile.
  try {
    supervisorFiles(broker, paths);
  } catch (e) {
    logWarn("broker", "could not make the supervisor's files: trying again", { error: String(e) });
    setTimeout(() => startSupervisor(broker, paths), 10_000);
    return;
  }
  const startedAt = Date.now();
  const argv = supervisorCommand(broker, [process.execPath, broker.supervisorMain]);
  const proc = spawn(argv[0] as string, argv.slice(1), {
    stdio: "inherit",
    cwd: paths.home,
    env: supervisorEnv(broker.env, paths, Object.keys(SECRET_VARS)),
    uid: SU,
    gid: SG,
    detached: true,
  });
  broker.supervisor = proc;
  watchHealth(proc, { part: "supervisor", ...WATCHED.supervisor, stopping: () => broker.stopping });
  let ended = false;
  const end = (code: number | null, signal: string | null, error?: string) => {
    if (ended) return;
    ended = true;
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
    killScope({ uid: SU });
    if (broker.stopping) {
      finishIfStopped(broker);
      return;
    }
    const next = restartAfter(Date.now() - startedAt, broker.supervisorRestarts);
    broker.supervisorRestarts = next.restarts;
    log("broker", "supervisor exited; restarting", {
      code,
      signal,
      ...(error ? { error } : {}),
      delay_ms: next.delayMs,
    });
    setTimeout(() => startSupervisor(broker, paths), next.delayMs);
  };
  proc.on("exit", (code, signal) => end(code, signal));
  proc.on("error", (err) => end(null, null, err.message));
}

import { spawn } from "node:child_process";
import { join } from "node:path";
import { log, logWarn } from "../../common/log.ts";
import { restartAfter } from "../../common/restart.ts";
import { type Broker, running, SECRET_VARS, TG, TU } from "./context.ts";
import { prepareDirectories, wipeIfMarked } from "./folders.ts";
import { isRootOnly, isRunpodVariable, isSupervisorOnly } from "./one-container.ts";
import { killScope } from "./process.ts";
import { roleIds } from "./runner.ts";
import { ALL_ROLES } from "./server.ts";
import { WATCHED, watchHealth } from "./watch.ts";

/**
 * The controller, as the `thermite` user in its own process group: started with the environment
 * it may have (no secret file's variable, none of RunPod's and none of the supervisor's or root's
 * own), started again when it exits (in the one-container image also when its health route fails,
 * watch.ts), and the broker's exit at a stop once every part has ended.
 */

export function killRoles(): number {
  let n = 0;
  for (const role of ALL_ROLES) n += killScope({ uid: roleIds(role).uid });
  return n;
}

/** On a stop: exit once every part has ended, leaving no role process behind. */
export function finishIfStopped(broker: Broker): void {
  if (broker.holdExit || running(broker.child) || running(broker.supervisor)) return;
  if (broker.isRoot) killRoles();
  log("broker", "stopped", { code: broker.stopCode });
  process.exit(broker.stopCode);
}

export function startController(broker: Broker, extraEnv: Record<string, string>): void {
  // A restart that falls due during a stop does not happen.
  if (broker.stopping) {
    finishIfStopped(broker);
    return;
  }
  if (broker.isRoot) {
    try {
      // Directories are prepared again only after a wipe (never the socket: it is in use).
      if (wipeIfMarked(broker)) prepareDirectories(broker);
    } catch (err) {
      logWarn("broker", "wipe failed; will retry at the next start", { error: String(err) });
    }
  }
  const startedAt = Date.now();
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(broker.env)) {
    if (
      v !== undefined &&
      !(k in SECRET_VARS) &&
      !isRunpodVariable(k) &&
      !isSupervisorOnly(k) &&
      !isRootOnly(k)
    )
      childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(broker.beforeStart?.() ?? {})) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  broker.child = spawn(process.execPath, [...process.execArgv, broker.controller], {
    stdio: "inherit",
    env: {
      ...childEnv,
      ...(broker.isRoot ? { TMPDIR: join(broker.scratchDir, "thermite", "tmp") } : {}),
      ...extraEnv,
    },
    ...(broker.isRoot ? { uid: TU, gid: TG } : {}),
    // Its own process group: worker processes it starts join it, so they end with it.
    detached: true,
  });
  const proc = broker.child;
  // In the one-container image nothing outside checks the controller: the broker does.
  if (broker.withSupervisor)
    watchHealth(proc, {
      part: "controller",
      ...WATCHED.controller,
      stopping: () => broker.stopping,
    });
  proc.on("exit", (code, signal) => {
    // Worker processes of a dead controller must not live on (they would keep calling the model
    // and the API while new trials run): kill the controller's whole process group.
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
    if (broker.stopping) {
      broker.stopCode = code ?? 0;
      finishIfStopped(broker);
      return;
    }
    if (broker.isRoot) {
      const killed = killRoles();
      if (killed) log("broker", "killed role processes left by the controller", { killed });
    }
    const next = restartAfter(Date.now() - startedAt, broker.restarts);
    broker.restarts = next.restarts;
    log("broker", "controller exited; restarting", { code, signal, delay_ms: next.delayMs });
    setTimeout(() => startController(broker, extraEnv), next.delayMs);
  });
}

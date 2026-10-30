import { chmodSync, chownSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorText } from "../../common/errors.ts";
import { log, logError } from "../../common/log.ts";
import { brokerContext, FENCE, fatalExit, running, TG } from "./context.ts";
import { finishIfStopped, killRoles, startController } from "./controller.ts";
import { prepareDirectories, prepareOutbox, prepareSocket, readSecrets } from "./folders.ts";
import { assertDevices, chooseRunCpus, currentLists, prepareDevices } from "./gpu.ts";
import { pullMode } from "./one-container.ts";
import { startBrokerServer } from "./server.ts";
import { prepareSnapshots, startSnapshots, writeSnapshotRecord } from "./snapshot/index.ts";
import {
  awaitEnrollment,
  prepareOneContainer,
  recordSupervisor,
  startAdvisorRuns,
  startSupervisor,
} from "./supervisor.ts";

/**
 * The harness broker: the container's long-running root process (under tini as PID 1). It
 *
 * - prepares the state, scratch and outbox directories for the `thermite` user;
 * - reads the harness's secret files and passes their values only to the controller, then
 *   closes the secrets directory to every other user;
 * - gives the device nodes to the `gpu` group (mode 0660), so only roles in that group reach
 *   the device; with dedicated cards (THERMITE_GPU_INDEX and THERMITE_DEV_GPU_INDEX, each a
 *   card or a list), gives each card and the shared nodes their own groups instead
 *   (broker/devices.ts);
 * - serves the broker socket, through which the controller runs work as separate users;
 * - runs the controller as `thermite` and restarts it if it exits, after killing anything a
 *   role left running;
 * - in the one-container rig image (THERMITE_ONE_CONTAINER=1, broker/one-container.ts), also
 *   prepares the supervisor's places and its token, serves the advisors' runner, which runs each
 *   advisor's program as an advisor user of its own (src/common/run-as/), and runs the supervisor
 *   as its own user, restarting it if it exits. In pull mode it starts the controller only once the supervisor's
 *   enrollment has brought control's key: it checks the key against the launch's SHA-256 and
 *   gives the harness a copy of its own, and takes the rig's settings from control as data;
 * - with THERMITE_STATE_SNAPSHOT_DIR (the one-container rig image sets it) and the launch's
 *   snapshot key, keeps the rig's state over a stop that empties the container's disk: the live
 *   state stays on that disk, and a sealed snapshot of it on the host's volume is restored at a
 *   start on an empty disk, and taken every few minutes, after each export, after enrollment and
 *   at a stop (broker/snapshot.ts, broker/seal.ts).
 *
 * No process it starts gets RunPod's variables (RUNPOD_*), and only the supervisor gets pull
 * mode's launch values. On SIGTERM or SIGINT it passes the signal on and exits when every part
 * it started has ended.
 *
 * Run as a non-root user (local development), it only starts the controller.
 *
 * Its parts are in broker/: what they share is context.ts (built once here), then folders.ts, gpu.ts,
 * controller.ts, supervisor.ts and snapshot/start.ts. This file starts them in order and handles
 * the stop signals.
 */

const broker = brokerContext({
  controller: fileURLToPath(new URL("../main.js", import.meta.url)),
  supervisorMain: fileURLToPath(new URL("../../supervisor/main.js", import.meta.url)),
  snapshotMain: fileURLToPath(new URL("./snapshot-main.js", import.meta.url)),
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    const again = broker.stopping;
    broker.stopping = true;
    log("broker", "stopping", { signal: sig });
    const stopParts = () => {
      broker.holdExit = false;
      const parts = [broker.child, broker.supervisor].filter(running);
      for (const part of parts) part.kill(sig);
      if (!parts.length) finishIfStopped(broker);
    };
    // The state snapshot first, while both parts still run, within the time a stop allows. A
    // second signal ends it at once.
    if (broker.snapshots && broker.holdExit) {
      broker.snapshots.abort();
      return;
    }
    if (broker.snapshots && !again) {
      broker.holdExit = true;
      const budget = broker.snapshotStopMs;
      broker.snapshots.stop(budget).then(
        (r) => {
          if (r !== "taken")
            log("broker", "no snapshot at the stop: the last complete one stays", {
              why: r === "out of time" ? `not done within ${budget / 1000} s` : "it failed",
            });
          stopParts();
        },
        () => stopParts(),
      );
      return;
    }
    stopParts();
  });
}

if (broker.withSupervisor && !broker.isRoot) {
  logError("broker", "fatal: the one-container image must run as root", {
    hint: "the broker starts the supervisor and each role as users of their own",
  });
  fatalExit(broker);
}

if (broker.isRoot) {
  // Before anything is made in the live folders: on a fresh disk they are restored first.
  const snapshotRecord = prepareSnapshots(broker);
  prepareDirectories(broker);
  prepareSocket(broker);
  if (snapshotRecord) writeSnapshotRecord(broker, snapshotRecord);
  // Before the secrets are read: a token it makes is read with them. A throw here (a volume that
  // refuses ownership, say) is logged as fatal and held, as the other start errors are.
  let pod: ReturnType<typeof prepareOneContainer> | undefined;
  try {
    pod = broker.withSupervisor ? prepareOneContainer(broker) : undefined;
  } catch (err) {
    logError("broker", "fatal: could not prepare the rig's folders", {
      error: errorText(err),
    });
    fatalExit(broker);
  }
  setInterval(() => prepareOutbox(broker), 60_000).unref();
  const secrets = readSecrets(broker);
  let lists = currentLists(broker);
  let gpuLayout = prepareDevices(broker, lists);
  // The server reads the layout and the CPU sets from here, so a new split reaches it.
  const serverOpts = {
    socketPath: broker.socketPath,
    scratchDir: broker.scratchDir,
    baseEnv: { PATH: broker.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    gpuLayout,
    assertDevices: () => assertDevices(broker, gpuLayout),
    runCpus: chooseRunCpus(broker, gpuLayout, lists),
    fence: broker.fenceAbi ? FENCE : undefined,
  };
  log("broker", "GPU fence", { landlock_abi: broker.fenceAbi, used: broker.fenceAbi > 0 });
  // nvidia-smi as root (the bus query above) resets nvidia-uvm to 0666: put it back now.
  assertDevices(broker, gpuLayout);
  setInterval(() => assertDevices(broker, gpuLayout), 60_000).unref();
  const killed = killRoles();
  if (killed) log("broker", "killed leftover role processes at start", { killed });
  if (pod) recordSupervisor(broker, pod);
  // The advisors' runner, before the supervisor starts: it runs each advisor's program.
  const runs = pod ? startAdvisorRuns(broker, pod) : undefined;
  let target = broker.env.THERMITE_TARGET;
  broker.beforeStart = () => {
    const next = currentLists(broker);
    const regroup = next.judge !== lists.judge || next.dev !== lists.dev;
    if (regroup) {
      log("broker", "the rig's GPU split changed: regrouping the cards", {
        judge: next.judge,
        dev: next.dev ?? null,
      });
      lists = next;
      gpuLayout = prepareDevices(broker, lists);
      serverOpts.gpuLayout = gpuLayout;
      assertDevices(broker, gpuLayout);
      if (pod) recordSupervisor(broker, pod);
    }
    // A target from enrollment's settings (pull mode) may pin timed runs where none were.
    if (regroup || broker.env.THERMITE_TARGET !== target) {
      target = broker.env.THERMITE_TARGET;
      serverOpts.runCpus = chooseRunCpus(broker, gpuLayout, lists);
    }
    // The controller reads the lists as if configured so.
    return { THERMITE_GPU_INDEX: lists.judge, THERMITE_DEV_GPU_INDEX: lists.dev };
  };
  const server = startBrokerServer(serverOpts);
  server.on("listening", () => {
    chownSync(broker.socketPath, 0, TG);
    chmodSync(broker.socketPath, 0o660);
    log("broker", "serving", { socket: broker.socketPath, separated: true });
    const start = () =>
      startController(broker, { ...secrets, THERMITE_BROKER_SOCKET: broker.socketPath });
    startSnapshots(broker, snapshotRecord);
    // The supervisor first: in pull mode its enrollment brings control's key; and the
    // controller's isolation check at start looks for it.
    if (pod)
      runs?.then(
        () => startSupervisor(broker, pod),
        (err) => {
          logError("broker", "fatal: could not serve the advisors' runner", {
            error: errorText(err),
          });
          fatalExit(broker);
        },
      );
    if (pod && pullMode(broker.env))
      awaitEnrollment(broker, pod).then(
        (enrolled) => {
          if (enrolled) start();
        },
        (err) => {
          logError("broker", "fatal: could not give the harness control's key from enrollment", {
            error: errorText(err),
          });
          fatalExit(broker);
        },
      );
    else start();
  });
} else if (broker.env.THERMITE_ALLOW_UNSEPARATED === "1") {
  log("broker", "not root: starting the controller WITHOUT user separation (explicitly allowed)");
  if (broker.snapDir)
    log("broker", "not root: no state snapshot is taken or restored", { dir: broker.snapDir });
  startController(broker, {});
} else {
  logError("broker", "fatal: not root, so roles cannot be separated", {
    hint: "run the harness container as root (the broker drops to role users), or set THERMITE_ALLOW_UNSEPARATED=1 for development only",
  });
  fatalExit(broker);
}

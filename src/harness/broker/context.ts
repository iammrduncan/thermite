import { type ChildProcess, execFileSync } from "node:child_process";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { log, startLogging } from "../../common/log.ts";
import { oneContainer } from "./one-container.ts";
import { IDS } from "./runner.ts";
import { takeSnapshotKey } from "./seal.ts";
import { brokerNumbers } from "./settings.ts";
import { type Snapshotter, snapshotDir } from "./snapshot/index.ts";

/**
 * What the broker's parts share. broker.ts builds it once, at its start (brokerContext), and gives
 * it to its parts in this folder: folders.ts, gpu.ts, controller.ts, supervisor.ts and
 * snapshot/start.ts. It holds the broker's settings and places, read from its environment, and
 * its state: the parts it runs, whether it is stopping, and the snapshots' schedule.
 */

export const { uid: TU, gid: TG } = IDS.thermite;
export const { uid: SU, gid: SG } = IDS.supervisor;

/** Secret files whose values the controller needs. The *_FILE variables never reach it. */
export const SECRET_VARS: Record<string, string> = {
  THERMITE_SUPERVISOR_TOKEN_FILE: "THERMITE_SUPERVISOR_TOKEN",
  THERMITE_PROPOSER_TOKEN_FILE: "THERMITE_PROPOSER_TOKEN",
  THERMITE_MODEL_API_KEY_FILE: "THERMITE_MODEL_API_KEY",
};

export function tryDo(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log("broker", `could not ${what}`, { error: errorText(err) });
  }
}

/**
 * The GPU fence (containers/harness/devfence.c): every role's command runs in a Landlock rule set
 * that leaves out the device nodes the role may not open. Used wherever the kernel has Landlock;
 * where the nodes keep the owner and mode they came with (a user namespace), it is the only fence.
 */
export const FENCE = "/usr/local/bin/thermite-devfence";

/** The fence's Landlock ABI, or 0 where the kernel has none (or there is no fence). */
function fenceAbiOf(): number {
  try {
    return Number(execFileSync(FENCE, ["--abi"], { encoding: "utf8" }).trim()) || 0;
  } catch {
    return 0;
  }
}

/** The programs the broker starts, by their paths (broker.ts names them beside itself). */
export interface BrokerPrograms {
  controller: string;
  supervisorMain: string;
  snapshotMain: string;
}

export interface Broker extends BrokerPrograms {
  env: NodeJS.ProcessEnv;
  /** The supervisor's group: it reads exports from the shared outbox; roles may not. */
  outboxGid: number;
  /** How long a fatal error at start holds the broker before it exits (fatalExit). */
  fatalHoldMs: number;
  /**
   * The state snapshot's key (THERMITE_STATE_SNAPSHOT_KEY, a launch value), taken out of the
   * broker's own environment before it starts anything: no part, no role and no program the broker
   * runs ever has it. Only root's snapshot helper gets it, on its standard input.
   */
  snapshotKey: ReturnType<typeof takeSnapshotKey>;
  stateDir: string;
  scratchDir: string;
  outboxDir: string;
  socketDir: string;
  socketPath: string;
  isRoot: boolean;
  /** The one-container rig image (THERMITE_ONE_CONTAINER=1): the broker runs the supervisor too. */
  withSupervisor: boolean;
  /** THERMITE_STATE_SNAPSHOT_DIR: the state is kept on the host's volume as a snapshot. */
  snapDir: string | undefined;
  /** The GPU fence's Landlock ABI (FENCE); 0: no fence. */
  fenceAbi: number;
  /** False when the device nodes kept another owner or mode: then only the fence holds. */
  groupsHold: boolean;
  child: ChildProcess | undefined;
  supervisor: ChildProcess | undefined;
  stopping: boolean;
  restarts: number;
  supervisorRestarts: number;
  /** The controller's exit code when it ended on a stop: the broker exits with it. */
  stopCode: number;
  /** The state snapshot's schedule, once it runs (THERMITE_STATE_SNAPSHOT_DIR). */
  snapshots: Snapshotter | undefined;
  /** A stop's snapshot is being taken: the broker does not exit before it ends. */
  holdExit: boolean;
  /**
   * Before each start of the controller: the cards it uses. A rig configured with its GPU set may
   * have a new split in its settings (Edit rig, or a campaign's deployment); the controller exited
   * to apply it, its role processes are gone, and the cards are regrouped here.
   */
  beforeStart: (() => Record<string, string | undefined>) | undefined;
  /** How often a snapshot is taken, and how long a stop waits for its own (prepareSnapshots). */
  snapshotEvery: number;
  snapshotStopMs: number;
  /** The free space a snapshot leaves on the host's volume, in bytes (goal 173). */
  snapshotFloor: number;
}

/**
 * The broker's context, read from its environment at its start, in this order: its number
 * settings (a bad one stops it here), its logging, the snapshot key taken out of the environment,
 * its places, and the fence.
 */
export function brokerContext(programs: BrokerPrograms): Broker {
  const env = process.env;
  const { outboxGid, fatalHoldMs } = brokerNumbers(env);
  startLogging("broker", env, () => [broker.child, broker.supervisor]);
  const snapshotKey = takeSnapshotKey(env);
  const socketDir = env.THERMITE_BROKER_DIR ?? "/run/thermite";
  const broker: Broker = {
    ...programs,
    env,
    outboxGid,
    fatalHoldMs,
    snapshotKey,
    stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
    scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
    socketDir,
    socketPath: join(socketDir, "broker.sock"),
    isRoot: process.getuid?.() === 0,
    withSupervisor: oneContainer(env),
    snapDir: snapshotDir(env),
    fenceAbi: fenceAbiOf(),
    groupsHold: true,
    child: undefined,
    supervisor: undefined,
    stopping: false,
    restarts: 0,
    supervisorRestarts: 0,
    stopCode: 0,
    snapshots: undefined,
    holdExit: false,
    beforeStart: undefined,
    snapshotEvery: 0,
    snapshotStopMs: 0,
    snapshotFloor: 0,
  };
  return broker;
}

/**
 * A fatal error at start: the broker exits, after THERMITE_FATAL_HOLD_SECONDS when it is set (the
 * rig image sets 60). A host that starts a stopped container again at once, such as RunPod, then
 * keeps the error in the pod's log, and the container does not restart every few seconds.
 */
export function fatalExit(broker: Broker): never {
  if (broker.fatalHoldMs > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, broker.fatalHoldMs);
  process.exit(1);
}

export const running = (c: ChildProcess | undefined): c is ChildProcess =>
  c !== undefined && c.exitCode === null && c.signalCode === null;

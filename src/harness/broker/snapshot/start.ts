import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FreeSpace, freeSpace, gib } from "../../../common/disk.ts";
import { errorText } from "../../../common/errors.ts";
import { log, logError, logWarn } from "../../../common/log.ts";
import { type Broker, fatalExit } from "../context.ts";
import { IDS, roleIds } from "../runner.ts";
import { deriveKeys, SnapshotRefused } from "../seal.ts";
import { timedRunsAtWork } from "../server.ts";
import { snapshotEveryMs, snapshotFloorBytes, stopBudgetMs } from "../settings.ts";
import {
  CLOSED_PROBE_JS,
  closedTo,
  prepareSnapshotDir,
  removeUnsealed,
  type SnapshotRecord,
} from "./folder.ts";
import { layoutProblem, SNAPSHOT_RECORD, snapshotAreas } from "./layout.ts";
import { liveHolds, restoreSnapshot } from "./restore.ts";
import { type SnapshotJob, Snapshotter } from "./snapshotter.ts";
import type { TakeJob } from "./take.ts";

/**
 * The broker's side of the state snapshot: at its start, before anything else, the snapshot folder
 * made and checked and the newest snapshot restored (prepareSnapshots), with its record for the
 * isolation selftest; then snapshots taken by root's helper (snapshot-main.ts) on their schedule
 * (startSnapshots).
 */

const rigId = (broker: Broker): string | null => broker.env.THERMITE_RIG_ID || null;

/**
 * THERMITE_STATE_SNAPSHOT_DIR (the one-container rig image sets it; broker/snapshot.ts): the live
 * state stays on the container's disk, and a sealed snapshot of it on the host's volume outlives
 * a stop that empties that disk. At a start, before anything else: root makes the snapshot
 * folder, its own with mode 0700, and records whether the controller's user, the supervisor's and
 * a role can open it (a volume may ignore the mode: RunPod's does). Without the launch's snapshot
 * key no snapshot is taken or restored. With it, when the live state is empty (a fresh disk), the
 * newest snapshot is restored, with the owners and modes the live folders need, once its manifest
 * and every file verify; one that does not is refused whole and the rig starts empty. Returns the
 * record the isolation selftest reads, or nothing without the setting.
 */
export function prepareSnapshots(broker: Broker): SnapshotRecord | undefined {
  const snapDir = broker.snapDir;
  if (!snapDir) return undefined;
  const areas = snapshotAreas(broker.env);
  const at = new Date().toISOString();
  const keyWhy = "why" in broker.snapshotKey ? broker.snapshotKey.why : undefined;
  try {
    broker.snapshotEvery = snapshotEveryMs(broker.env);
    broker.snapshotStopMs = stopBudgetMs(broker.env);
    broker.snapshotFloor = snapshotFloorBytes(broker.env);
  } catch (err) {
    logError("broker", "fatal: a snapshot setting is not valid", { error: String(err) });
    fatalExit(broker);
  }
  const problem = layoutProblem(snapDir, areas);
  if (problem) {
    logError("broker", "fatal: the state snapshot can't be set up", { problem });
    fatalExit(broker);
  }
  let shown: ReturnType<typeof prepareSnapshotDir>;
  try {
    shown = prepareSnapshotDir(snapDir);
  } catch (err) {
    const error = errorText(err);
    logWarn("broker", "could not make the snapshot folder: no snapshot is taken or restored", {
      dir: snapDir,
      error,
    });
    return {
      dir: snapDir,
      owner: "",
      mode: "",
      users: { root: `failed: ${error}` },
      closed: false,
      sealed: false,
      off: `could not make the snapshot folder: ${error}`,
      at,
    };
  }
  // Whatever owner the volume gives root's files, no part and no role may open the folder.
  const users: Record<string, { uid: number; gid: number }> = {
    thermite: IDS.thermite,
    ...(broker.withSupervisor ? { supervisor: IDS.supervisor } : {}),
    "agent-1": roleIds("agent-1"),
  };
  const seen = closedTo(Object.keys(users), (name) => {
    const u = users[name] as { uid: number; gid: number };
    const r = spawnSync(process.execPath, ["-e", CLOSED_PROBE_JS, snapDir], {
      uid: u.uid,
      gid: u.gid,
      cwd: "/",
      env: { PATH: broker.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || String(r.error ?? "") };
  });
  const closed = Object.values(seen).every((v) => v.startsWith("refused"));
  const record: SnapshotRecord = {
    dir: snapDir,
    owner: `${shown.uid}:${shown.gid}`,
    mode: shown.mode.toString(8),
    users: seen,
    closed,
    sealed: !keyWhy,
    ...(keyWhy ? { off: keyWhy } : {}),
    at,
  };
  // An image before sealing kept its snapshot unsealed: it is never restored.
  try {
    const old = removeUnsealed(snapDir, closed);
    if (old.removed.length)
      log("broker", "removed an unsealed snapshot an older image left: it is not restored", {
        dir: snapDir,
        removed: old.removed,
      });
    if (old.left.length)
      log(
        "broker",
        "an unsealed snapshot an older image left is in the snapshot folder, which other users may open: it is not restored, and it stays for the owner to remove",
        { dir: snapDir, left: old.left },
      );
  } catch (err) {
    logWarn("broker", "could not remove an unsealed snapshot an older image left", {
      dir: snapDir,
      error: errorText(err),
    });
  }
  if ("why" in broker.snapshotKey) {
    log("broker", "no snapshot key: no snapshot is taken or restored", {
      dir: snapDir,
      why: broker.snapshotKey.why,
      hint: "control gives a pod its key at launch; a pod launched by an older control has none, and its state does not outlive a stop",
    });
    return record;
  }
  log(
    "broker",
    closed
      ? "the snapshot folder is closed to the parts and the roles"
      : "the snapshot folder is open to other users: its snapshot is sealed",
    {
      dir: snapDir,
      owner: record.owner,
      mode: record.mode,
      ...(closed ? {} : { users: seen }),
      every_minutes: broker.snapshotEvery / 60_000,
    },
  );
  const holds = liveHolds(areas);
  if (holds.length) {
    log("broker", "the live state is on this disk: nothing is restored", { holds });
    return record;
  }
  try {
    const r = restoreSnapshot({
      dir: snapDir,
      areas,
      keys: deriveKeys(broker.snapshotKey.key),
      rig: rigId(broker),
    });
    if (!r) log("broker", "no snapshot yet: the rig starts with a fresh state", { dir: snapDir });
    else
      log("broker", "restored the rig's state from its snapshot", {
        dir: snapDir,
        snapshot: r.from,
        seq: r.seq,
        taken_at: r.taken_at,
        taken: r.reason,
        parts: r.areas,
        ...(r.refused.length
          ? { refused: r.refused.length, refused_first: r.refused.slice(0, 10) }
          : {}),
      });
  } catch (err) {
    if (err instanceof SnapshotRefused) {
      // Refused whole: nothing of it is restored, and the rig starts with an empty state. The
      // next snapshot takes its place.
      log("broker", `the snapshot did not verify: ${err.message}`, {
        dir: snapDir,
        restored: "nothing: the rig starts with an empty state",
      });
      return record;
    }
    logError("broker", "fatal: could not restore the rig's state from its snapshot", {
      dir: snapDir,
      error: errorText(err),
    });
    fatalExit(broker);
  }
  return record;
}

/** The broker's record of the snapshot folder, next to its socket, for the isolation selftest. */
export function writeSnapshotRecord(broker: Broker, record: SnapshotRecord): void {
  const path = join(broker.socketDir, SNAPSHOT_RECORD);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
}

/**
 * Why a snapshot waits for room (goal 173): its folder's free space below the rig's disk floor, in
 * words; undefined when there is room, or no floor. A folder it can't read is no reason to wait:
 * the snapshot then says what failed.
 */
export function snapshotWaits(
  dir: string,
  floor: number,
  free: FreeSpace = freeSpace,
): string | undefined {
  if (floor <= 0) return undefined;
  let left: number;
  try {
    left = free(dir).free;
  } catch {
    return undefined;
  }
  return left < floor
    ? `the snapshot's folder has ${gib(left)} GiB free, below the rig's disk floor of ${gib(floor)} GiB (THERMITE_DISK_FLOOR_GIB)`
    : undefined;
}

/** Whether the last snapshot waited for room: said once when it starts and once when it ends. */
let waited = false;

/** A snapshot taken by the broker's helper, at a low priority but at a stop. */
const NICE = existsSync("/usr/bin/nice") ? ["/usr/bin/nice", "-n", "19"] : [];
const IONICE = existsSync("/usr/bin/ionice") ? ["/usr/bin/ionice", "-t", "-c", "2", "-n", "7"] : [];
function snapshotJob(broker: Broker, reason: string): SnapshotJob {
  // At the disk floor a snapshot waits, the last complete one stays, and the snapshotter asks
  // again later (after a minute): nothing is spawned, and it is said once.
  const why = snapshotWaits(broker.snapDir as string, broker.snapshotFloor);
  if (why && !waited) logWarn("broker", "a snapshot waits for room: the last one stays", { why });
  if (!why && waited) log("broker", "the snapshot's folder has room again");
  waited = why !== undefined;
  if (why) return { done: Promise.resolve(false), abort: () => undefined };
  const job: TakeJob = {
    dir: broker.snapDir as string,
    reason,
    areas: snapshotAreas(broker.env),
    stage: join(broker.scratchDir, ".snapshot-ledger"),
    owner: IDS.thermite,
    rig: rigId(broker),
    key: "key" in broker.snapshotKey ? broker.snapshotKey.key.toString("base64url") : "",
  };
  const gentle = reason === "at the stop" ? [] : [...IONICE, ...NICE];
  const argv = [...gentle, process.execPath, ...process.execArgv, broker.snapshotMain, "take"];
  // The job, with the key, on its standard input: a process's arguments are any user's to read.
  const proc = spawn(argv[0] as string, argv.slice(1), {
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      PATH: broker.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(broker.env.NODE_OPTIONS ? { NODE_OPTIONS: broker.env.NODE_OPTIONS } : {}),
    },
    detached: true,
  });
  proc.stdin?.on("error", () => {
    // it ended before it read its job: its exit says so
  });
  proc.stdin?.end(JSON.stringify(job));
  const done = new Promise<boolean>((resolve) => {
    proc.on("exit", (code, signal) => {
      if (code !== 0)
        logWarn("broker", "the snapshot failed: the last one stays, and it is tried again", {
          reason,
          code,
          signal,
        });
      resolve(code === 0);
    });
    proc.on("error", (err) => {
      logWarn("broker", "could not start the snapshot", { reason, error: err.message });
      resolve(false);
    });
  });
  return {
    done,
    abort: () => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        // it has ended
      }
    },
  };
}

/** A snapshot after each export the harness writes: a new name in the outbox, looked for often. */
function watchOutbox(broker: Broker, onNew: () => void): void {
  let seen: Set<string> | undefined;
  const look = () => {
    let names: string[];
    try {
      names = readdirSync(broker.outboxDir).filter((n) => !n.startsWith("."));
    } catch {
      return;
    }
    const fresh = seen !== undefined && names.some((n) => !seen?.has(n));
    seen = new Set(names);
    if (fresh) onNew();
  };
  look();
  setInterval(look, 10_000).unref();
}

/** Snapshots from now on: every few minutes, after each export, after enrollment and at a stop. */
export function startSnapshots(broker: Broker, record: SnapshotRecord | undefined): void {
  if (!record?.sealed) return;
  broker.snapshots = new Snapshotter({
    take: (reason) => snapshotJob(broker, reason),
    everyMs: broker.snapshotEvery,
    busy: () => timedRunsAtWork() > 0,
  });
  broker.snapshots.start();
  watchOutbox(broker, () => broker.snapshots?.request("after an export"));
}

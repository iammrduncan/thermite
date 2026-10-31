/**
 * The rig's state over a stop of a host that empties the container's own disk, such as a RunPod
 * pod (THERMITE_STATE_SNAPSHOT_DIR; the one-container rig image sets it). The live state stays
 * on the container's disk, where each part and each role keeps the owners it has everywhere else.
 * Root copies it into a snapshot on the host's volume every few minutes, after each export and at
 * a stop, and puts the newest snapshot back at a start on an empty disk.
 *
 * - The snapshot is sealed (seal.ts): RunPod's volume ignores file permissions, so any user may
 *   read the folder or write in it. Each file is encrypted and authenticated under the pod's
 *   snapshot key, and named by a keyed hash of its content; the manifest (each file's part, path,
 *   owner, mode, time, size, sealed name and SHA-256) is sealed too. A restore takes a snapshot
 *   only when its manifest and every file in it verify, and refuses it whole otherwise.
 * - The folder holds the manifest, `manifest.new` while one is written, and the sealed files, all
 *   side by side. A file whose content is sealed there already is not sealed again; one that has
 *   not changed since the last snapshot (the same size and time) is not even read. A take writes
 *   `manifest.new` last and renames it onto `manifest`; then the sealed files no manifest names go.
 * - Root works in the folder from inside it (its working folder), by bare names: another user
 *   who renames the folder or swaps it for a link can never send root's writes, reads or removals
 *   elsewhere. Nothing under it is ever given another owner (RunPod's volume refuses even root
 *   that), so the owners and modes the live folders need are in the manifest, and a restore sets
 *   them on the container's disk.
 * - The ledger is copied with SQLite's backup, as the controller's user, never as a raw file, and
 *   first: an export the ledger records is then in the outbox's copy too.
 * - Only plain files and folders of the expected owner are taken, and only plain files and
 *   folders under the expected names are restored: never a link, a device, a pipe or a socket.
 *
 * Its parts are in snapshot/: layout.ts (the parts a snapshot holds and the names in its folder),
 * files.ts (reading and writing in that folder), manifest.ts, take.ts, restore.ts, folder.ts (the
 * folder itself, as root makes it and the isolation check looks at it) and snapshotter.ts (when
 * snapshots are taken). The broker's side, at its start and after, is snapshot/start.ts.
 */

export { inSnapshotFolder } from "./files.ts";
export {
  CLOSED_PROBE_JS,
  closedTo,
  type FolderLook,
  inspectSnapshotFolder,
  lookWords,
  prepareSnapshotDir,
  removeUnsealed,
  type SnapshotRecord,
} from "./folder.ts";
export {
  AREA_NAMES,
  type AreaName,
  LEDGER_FILE,
  layoutProblem,
  leftOut,
  PROBE_FILE,
  SEALED,
  SEALED_FILE,
  SEALING_FILE,
  SNAPSHOT_RECORD,
  type SnapshotArea,
  safeRel,
  snapshotAreas,
  snapshotDir,
  UNSEALED_DIRS,
} from "./layout.ts";
export type { SnapshotEntry, SnapshotManifest } from "./manifest.ts";
export {
  liveHolds,
  RESTORING,
  type RestoreResult,
  restoreSnapshot,
} from "./restore.ts";
export {
  type SnapshotJob,
  Snapshotter,
  type SnapshotterOptions,
} from "./snapshotter.ts";
export {
  prepareSnapshots,
  snapshotWaits,
  startSnapshots,
  writeSnapshotRecord,
} from "./start.ts";
export { backupLedger, TakeJob, type TakeResult, takeSnapshot } from "./take.ts";

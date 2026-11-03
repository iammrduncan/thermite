/**
 * Backup and restore of control (goal 173): `thermite backup` writes control's state and the
 * streams kept for good into a dated folder with a manifest (make.ts); `thermite restore` checks a
 * backup and puts it back, the streams first, each checked after, then control's state, keeping
 * what it replaces (restore.ts). The streams go through the server's snapshot and restore API, as
 * the backup's own user (streams.ts); the files are copied with their SHA-256 (files.ts). What a
 * backup holds is core/backup.ts.
 */

export { ownerFor } from "./files.ts";
export { backupControl, readManifest } from "./make.ts";
export { checkBackup, RestoreRefused, restoreControl, setBusStoreAside } from "./restore.ts";
export {
  type BackupBus,
  messageDigest,
  natsBackupBus,
  StreamApiError,
  type StreamEnd,
  type StreamSnapshot,
} from "./streams.ts";

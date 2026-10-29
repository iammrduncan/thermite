import { z } from "zod";
import { COMMAND_STREAM } from "./link/commands.ts";
import { CONFIG_STREAM } from "./link/config.ts";
import { LIVE_STREAM } from "./link/live.ts";
import { REPORT_STREAM } from "./link/report.ts";
import { STREAMS_KEPT_FOR_GOOD } from "./link/users.ts";

/**
 * A backup of control (goal 173): the folder `thermite backup` writes and `thermite restore` reads
 * back. It is named for when it was made, and holds control's state folder (its store, copied
 * whole while control runs, its keys, its kits and its exports), a snapshot of each stream of the
 * message bus that is kept for good, as the server's snapshot API gives it, and a manifest: each
 * file's size and SHA-256, each stream's message count, last place and last message, control's
 * place in each stream, and the versions of Thermite and of control's store that made it.
 */

export const BACKUP_VERSION = 1;

/** What of control's state folder a backup holds, each by its name there. */
export const CONTROL_STATE = {
  /** The store: copied first, whole and consistent while control writes (`vacuum into`). */
  db: "control.db",
  /** Signs every command to the rigs; the rigs pin its public half. */
  signingKey: "control-signing.key",
  signingPub: "control-signing.pub",
  /** Opens every sealed value in the store; elsewhere when THERMITE_CONTROL_SECRETS_KEY_FILE says so. */
  secretsKey: "secrets.key",
  /** The message bus's certificate authority, which every rig on the bus trusts. */
  busCaCert: "bus-ca.pem",
  busCaKey: "bus-ca.key",
  /** The seed of the backup's own user on the bus, which may snapshot and restore its streams. */
  busBackupSeed: "bus-backup.seed",
  /** Kits written or uploaded on the New campaign page, as git repositories. */
  kits: "kits",
  /** Exports of rigs that have no results repository. */
  exports: "exports",
} as const;

/** The files of control's state a backup holds, in the order it copies them after the store. */
export const STATE_FILES = [
  CONTROL_STATE.signingKey,
  CONTROL_STATE.signingPub,
  CONTROL_STATE.secretsKey,
  CONTROL_STATE.busCaCert,
  CONTROL_STATE.busCaKey,
  CONTROL_STATE.busBackupSeed,
] as const;

/** The folders of control's state a backup holds, each whole. */
export const STATE_FOLDERS = [CONTROL_STATE.kits, CONTROL_STATE.exports] as const;

/** A backup's own layout: its manifest, control's state, the streams' snapshots. */
export const BACKUP_LAYOUT = {
  manifest: "manifest.json",
  state: "state",
  streams: "streams",
} as const;

/** The folder a backup is written to, inside the folder it is given: its name says when. */
export const backupName = (at: Date) => `thermite-backup-${at.toISOString().replace(/[:.]/g, "-")}`;

/** A stream's snapshot in a backup, as the server gives it: a tar, compressed with s2. */
export const snapshotFile = (stream: string) => `${BACKUP_LAYOUT.streams}/${stream}.snapshot`;

/** The streams a backup holds: those kept for good, the record of every rig's events. */
export const STREAMS_BACKED_UP: readonly string[] = STREAMS_KEPT_FOR_GOOD;

/**
 * The streams a backup leaves out, and why each needs no backup: control makes each again as it
 * starts, and what it held comes back from control's store or from the rigs.
 */
export const STREAMS_LEFT_OUT: Readonly<Record<string, string>> = {
  [REPORT_STREAM]:
    "an inbox: a page stays only until control takes it, and a rig sends again what control lacks",
  [COMMAND_STREAM]:
    "commands on their way: control keeps each in its store, and publishes again those still pending as it starts",
  [LIVE_STREAM]: "the newest live lines, a view the rigs make again as they work",
  [CONFIG_STREAM]: "each rig's config, which control writes again from its store",
};

/**
 * The server's memory a stream's restore needs, about, in bytes: the snapshot API's restore holds
 * much of the stream while it puts it back. Measured on the pinned server: 1,000,000 events took
 * 879 MiB at the most. A server with less is stopped part way, and leaves a stream that looks
 * whole and is not: the restore's check refuses it.
 */
export function restoreMemoryBytes(messages: number): number {
  return RESTORE_MEMORY_BASE + messages * RESTORE_MEMORY_PER_MESSAGE;
}
const RESTORE_MEMORY_BASE = 128 * 2 ** 20;
const RESTORE_MEMORY_PER_MESSAGE = 1024;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Count = z.number().int().nonnegative();

/**
 * A path inside a backup, under one of its folders: relative, with no `..` and no empty part. A
 * manifest is read back from a folder anyone could have changed.
 */
const pathUnder = (folder: string) =>
  z
    .string()
    .refine(
      (p) =>
        p.startsWith(`${folder}/`) &&
        p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      `a path inside the backup's ${folder} folder`,
    );

/** A file the backup holds, with its size and SHA-256: one of control's state's. */
export const BackupFile = z.object({
  path: pathUnder(BACKUP_LAYOUT.state),
  bytes: Count,
  sha256: Sha256,
});
export type BackupFile = z.infer<typeof BackupFile>;

/** A stream the backup holds: its state when its snapshot was taken, and the snapshot's file. */
export const BackupStream = z.object({
  name: z.string().min(1),
  messages: Count,
  first_seq: Count,
  last_seq: Count,
  bytes: Count,
  /** The SHA-256 of its last message (subject, a newline, data); null for an empty stream. */
  last_sha256: Sha256.nullable(),
  /** Its settings as the server gave them with the snapshot: its restore gives them back. */
  config: z.record(z.string(), z.unknown()),
  /** Its snapshot's file. */
  file: z.object({ path: pathUnder(BACKUP_LAYOUT.streams), bytes: Count, sha256: Sha256 }),
});
export type BackupStream = z.infer<typeof BackupStream>;

export const BackupManifest = z.object({
  v: z.literal(BACKUP_VERSION),
  of: z.literal("control"),
  made_at: z.string(),
  /** The Thermite that made it. */
  thermite: z.object({ version: z.string(), commit: z.string().nullable() }),
  /** Control's store: its schema version, and its place in each stream it applies. */
  store: z.object({ schema: Count, positions: z.record(z.string(), Count) }),
  files: z.array(BackupFile),
  streams: z.array(BackupStream),
  /** The streams left out, with why. */
  left_out: z.record(z.string(), z.string()),
});
export type BackupManifest = z.infer<typeof BackupManifest>;

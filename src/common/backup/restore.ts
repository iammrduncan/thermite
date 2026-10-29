import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BACKUP_LAYOUT,
  type BackupManifest,
  type BackupStream,
  CONTROL_STATE,
  restoreMemoryBytes,
  STATE_FILES,
  STATE_FOLDERS,
} from "../../core/backup.ts";
import { errorText } from "../errors.ts";
import { copyHashed, giveTo, hashFile, moveAside, ownerFor } from "./files.ts";
import { readManifest } from "./make.ts";
import type { BackupBus, StreamEnd } from "./streams.ts";

/**
 * `thermite restore` (goal 173): a backup put back, with control stopped. The streams first, as
 * the backup's user that control's state now holds, which the bus's server knows; then control's
 * state, each file and folder it replaces moved aside into a dated folder beside them, never
 * deleted. A stream comes back only where the bus has none of that name: its server keeps a
 * stream for good, and only its store, set aside with the bus stopped (setBusStoreAside), makes
 * room. The stream it finds after is checked against the manifest (its count, its last place and
 * its last message), since a server stopped part way through a restore leaves a stream that looks
 * whole: the restore refuses one that differs, naming it, and changes no file of control's.
 */

/** A restore refused: the backup, or a stream on the bus, is not what the manifest says. */
export class RestoreRefused extends Error {}

/** The dated folder what a restore replaces goes in, beside it. */
export const replacedName = (at: Date) => `replaced-${at.toISOString().replace(/[:.]/g, "-")}`;

/** The entries of control's state folder a restore replaces: all a backup holds, with the store's own files. */
const STATE_ENTRIES = [
  CONTROL_STATE.db,
  `${CONTROL_STATE.db}-wal`,
  `${CONTROL_STATE.db}-shm`,
  ...STATE_FILES,
  ...STATE_FOLDERS,
];

/**
 * Checks each file of a backup against its manifest: there, its size and its SHA-256. The
 * manifest; throws RestoreRefused, naming the first file that differs.
 */
export async function checkBackup(folder: string): Promise<BackupManifest> {
  let manifest: BackupManifest;
  try {
    manifest = readManifest(folder);
  } catch (err) {
    throw new RestoreRefused(errorText(err));
  }
  for (const f of [...manifest.files, ...manifest.streams.map((s) => s.file)]) {
    const path = join(folder, f.path);
    if (!existsSync(path)) throw new RestoreRefused(`the backup lacks ${f.path}`);
    const h = await hashFile(path);
    if (h.bytes !== f.bytes || h.sha256 !== f.sha256)
      throw new RestoreRefused(`${f.path} is not the file the backup's manifest names: it changed`);
  }
  return manifest;
}

/**
 * Moves everything in the bus's store folder into a dated folder inside it, with the bus stopped:
 * the server starts with an empty store, and makes no stream until control or a restore does. The
 * folder it moved them to; undefined when the store was empty.
 */
export function setBusStoreAside(storeDir: string, now = new Date()): string | undefined {
  if (!existsSync(storeDir)) throw new RestoreRefused(`no folder ${storeDir}: the bus's store`);
  const names = readdirSync(storeDir).filter((n) => !n.startsWith("replaced-"));
  const aside = join(storeDir, replacedName(now));
  return moveAside(storeDir, names, aside).length ? aside : undefined;
}

const words = (n: number) => n.toLocaleString("en-US");
const mib = (bytes: number) => `${words(Math.ceil(bytes / 2 ** 20))} MiB`;

/** Why a stream on the bus is not the backup's, in words; undefined when it is. */
async function differs(
  bus: BackupBus,
  s: BackupStream,
  now: StreamEnd,
): Promise<string | undefined> {
  const got = `${words(now.messages)} messages to ${words(now.last_seq)}`;
  const want = `${words(s.messages)} to ${words(s.last_seq)}`;
  if (now.messages !== s.messages || now.last_seq !== s.last_seq)
    return `it holds ${got}, and the backup holds ${want}`;
  if (s.last_sha256 && (await bus.messageSha256(s.name, s.last_seq)) !== s.last_sha256)
    return `its last message, at ${words(s.last_seq)}, is not the one the backup recorded`;
  return undefined;
}

/** What to do about a stream the bus holds that is not the backup's: set the store aside, then again. */
const setAsideFirst = (name: string, why: string) =>
  `${name} on the bus is not the backup's: ${why}. A server stopped part way through a restore leaves a stream that looks whole and is not, and a bus that ran on since the backup holds more. Stop the bus, set its store aside (thermite restore --bus-store), start it with room for the restore, and run the restore again. Nothing of control's state was changed.`;

export interface RestoreOptions {
  /** The backup's folder. */
  from: string;
  /** Control's state folder (THERMITE_CONTROL_DIR). Control must be stopped. */
  stateDir: string;
  /** The bus, as the backup's user. */
  bus: BackupBus;
  now?: Date | undefined;
  /** Each step, in words, as it is done. */
  say?: ((line: string) => void) | undefined;
}

/**
 * Restores a backup: its streams where the bus has none, each checked after; then control's state.
 * Where control's state was replaced; throws RestoreRefused, in words, when a stream is not the
 * backup's, before any file of control's is changed.
 */
export async function restoreControl(o: RestoreOptions): Promise<{ replaced: string | undefined }> {
  const say = o.say ?? (() => {});
  const now = o.now ?? new Date();
  const manifest = await checkBackup(o.from);
  say(
    `the backup of ${manifest.made_at} is whole: ${manifest.files.length} files and ${manifest.streams.length} streams as its manifest says`,
  );

  for (const s of manifest.streams) {
    const before = await o.bus.state(s.name);
    if (before) {
      const why = await differs(o.bus, s, before);
      if (why) throw new RestoreRefused(setAsideFirst(s.name, why));
      say(`${s.name} is on the bus as the backup holds it`);
      continue;
    }
    const need = restoreMemoryBytes(s.messages);
    say(
      `${s.name}: restoring ${words(s.messages)} messages; the bus's server needs about ${mib(need)} of memory for it`,
    );
    try {
      await o.bus.restore(s.name, join(o.from, s.file.path), s);
    } catch (err) {
      const error = errorText(err);
      throw new RestoreRefused(
        `the restore of ${s.name} failed: ${error}. A server with less than about ${mib(need)} of memory is stopped part way; give it more, and run the restore again: it checks the stream it finds. Nothing of control's state was changed.`,
      );
    }
    const after = await o.bus.state(s.name);
    const why = after
      ? await differs(o.bus, s, after)
      : "the bus has no such stream after its restore";
    if (why) throw new RestoreRefused(setAsideFirst(s.name, why));
    say(`${s.name}: restored and checked, ${words(s.messages)} messages to ${words(s.last_seq)}`);
  }

  // Control's state: unchanged when it is the backup's already, as after a restore run again.
  const same = await Promise.all(
    manifest.files.map(async (f) => {
      const path = join(o.stateDir, f.path.slice(BACKUP_LAYOUT.state.length + 1));
      return existsSync(path) && (await hashFile(path)).sha256 === f.sha256;
    }),
  );
  if (same.every(Boolean)) {
    say("control's state is the backup's already: nothing moved");
    return { replaced: undefined };
  }
  const owner = ownerFor(o.stateDir);
  const aside = join(o.stateDir, replacedName(now));
  const moved = moveAside(o.stateDir, STATE_ENTRIES, aside);
  for (const f of manifest.files) {
    const rel = f.path.slice(BACKUP_LAYOUT.state.length + 1);
    await copyHashed(join(o.from, f.path), join(o.stateDir, rel));
  }
  for (const name of new Set(manifest.files.map((f) => f.path.split("/")[1] ?? "")))
    giveTo(join(o.stateDir, name), owner);
  if (moved.length) giveTo(aside, owner);
  say(
    moved.length
      ? `control's state: ${moved.join(", ")} moved aside to ${aside}, and the backup's put back`
      : "control's state: the backup's put back",
  );
  return { replaced: moved.length ? aside : undefined };
}

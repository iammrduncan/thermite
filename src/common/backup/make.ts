import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BACKUP_LAYOUT,
  BACKUP_VERSION,
  type BackupFile,
  BackupManifest,
  type BackupStream,
  backupName,
  CONTROL_STATE,
  STATE_FILES,
  STATE_FOLDERS,
  STREAMS_BACKED_UP,
  STREAMS_LEFT_OUT,
  snapshotFile,
} from "../../core/backup.ts";
import { writeAtomic } from "../fs.ts";
import { copyHashed, filesUnder, giveTo, hashFile, type Owner, sidecarsToOwner } from "./files.ts";
import type { BackupBus } from "./streams.ts";

/**
 * `thermite backup` (goal 173): control's state and the streams kept for good, into a dated
 * folder, with a manifest. Control's store first, then the streams: control's place in each
 * stream is then at or before the stream's end, and control, started from the backup, applies
 * what came between. The backup is written into a folder whose name ends in `.partial`, renamed
 * once its manifest is written: a folder with no such end is a whole backup.
 */

export interface BackupOptions {
  /** Control's state folder (THERMITE_CONTROL_DIR). */
  stateDir: string;
  /** The folder the backup's own folder is made in. */
  into: string;
  /** The bus, as the backup's user. */
  bus: BackupBus;
  /** The Thermite that makes it. */
  build: { version: string; commit: string | null };
  now?: Date | undefined;
  /** Each step, in words, as it is done. */
  say?: ((line: string) => void) | undefined;
  /** Who gets what it writes, when it runs as root (files.ts ownerFor). */
  owner?: Owner | undefined;
}

/** What control's store says of itself, read from its copy. */
function storeFacts(copy: string): BackupManifest["store"] {
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    // Control's store counts its migrations (control/store/schema.ts) and keeps its place in each
    // stream it applies (control/store/positions.ts). A store without either has none yet.
    const has = (table: string) =>
      db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table);
    const v = has("schema_migrations")
      ? (db.prepare("select max(version) as v from schema_migrations").get() as {
          v: number | null;
        })
      : undefined;
    const rows = has("bus_position")
      ? (db.prepare("select stream, seq from bus_position").all() as {
          stream: string;
          seq: number;
        }[])
      : [];
    return {
      schema: Number(v?.v ?? 0),
      positions: Object.fromEntries(rows.map((r) => [r.stream, Number(r.seq)])),
    };
  } finally {
    db.close();
  }
}

/** Makes a backup of control; its folder and manifest. Throws, in words, when it can't. */
export async function backupControl(
  o: BackupOptions,
): Promise<{ folder: string; manifest: BackupManifest }> {
  const say = o.say ?? (() => {});
  const now = o.now ?? new Date();
  const db = join(o.stateDir, CONTROL_STATE.db);
  if (!existsSync(db))
    throw new Error(`${o.stateDir} holds no ${CONTROL_STATE.db}: is it control's state folder?`);
  const folder = join(o.into, backupName(now));
  const partial = `${folder}.partial`;
  for (const f of [folder, partial])
    if (existsSync(f)) throw new Error(`${f} is there already: a backup never writes over one`);
  const state = join(partial, BACKUP_LAYOUT.state);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(join(partial, BACKUP_LAYOUT.streams), { mode: 0o700 });
  const files: BackupFile[] = [];
  const add = (rel: string, h: { bytes: number; sha256: string }) =>
    files.push({ path: `${BACKUP_LAYOUT.state}/${rel}`, ...h });

  // The store, whole and consistent while control writes to it.
  const copy = join(state, CONTROL_STATE.db);
  const live = new DatabaseSync(db, { readOnly: true });
  try {
    live.exec("pragma busy_timeout = 5000");
    live.prepare("vacuum into ?").run(copy);
  } finally {
    live.close();
    sidecarsToOwner(db);
  }
  add(CONTROL_STATE.db, await hashFile(copy));
  const store = storeFacts(copy);
  say(`copied ${CONTROL_STATE.db}: schema ${store.schema}, ${statSync(copy).size} bytes`);

  for (const name of STATE_FILES) {
    const from = join(o.stateDir, name);
    if (existsSync(from)) add(name, await copyHashed(from, join(state, name)));
  }
  for (const name of STATE_FOLDERS) {
    const from = join(o.stateDir, name);
    if (!existsSync(from)) continue;
    const under = filesUnder(from);
    for (const rel of under)
      add(`${name}/${rel}`, await copyHashed(join(from, rel), join(state, name, rel)));
    say(`copied ${name}/: ${under.length} files`);
  }

  const streams: BackupStream[] = [];
  for (const name of STREAMS_BACKED_UP) {
    const rel = snapshotFile(name);
    const snap = await o.bus.snapshot(name, join(partial, rel));
    const place = store.positions[name] ?? 0;
    if (place > snap.last_seq)
      throw new Error(
        `${name} ends at ${snap.last_seq}, before control's place in it, ${place}: this bus is not the one control's store was applied from`,
      );
    const last = snap.last_seq > 0 ? await o.bus.messageSha256(name, snap.last_seq) : undefined;
    streams.push({
      name,
      messages: snap.messages,
      first_seq: snap.first_seq,
      last_seq: snap.last_seq,
      bytes: snap.bytes,
      last_sha256: last ?? null,
      config: snap.config,
      file: { path: rel, ...(await hashFile(join(partial, rel))) },
    });
    say(`took ${name}'s snapshot: ${snap.messages} messages to ${snap.last_seq}`);
  }

  const manifest = BackupManifest.parse({
    v: BACKUP_VERSION,
    of: "control",
    made_at: now.toISOString(),
    thermite: o.build,
    store,
    files,
    streams,
    left_out: STREAMS_LEFT_OUT,
  });
  writeAtomic(
    join(partial, BACKUP_LAYOUT.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  giveTo(partial, o.owner);
  renameSync(partial, folder);
  return { folder, manifest };
}

/** A backup's manifest, read back and checked against its schema. Throws, in words, on one that is not. */
export function readManifest(folder: string): BackupManifest {
  const path = join(folder, BACKUP_LAYOUT.manifest);
  if (!existsSync(path))
    throw new Error(
      `${folder} has no ${BACKUP_LAYOUT.manifest}: not a whole backup (one that stopped part way ends in .partial)`,
    );
  const parsed = BackupManifest.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new Error(
      `${path} is not a backup's manifest this Thermite reads: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

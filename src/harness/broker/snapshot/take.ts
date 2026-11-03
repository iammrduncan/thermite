import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type FileDigest, FileSealer, SEAL_OVERHEAD, type SnapshotKeys, seal } from "../seal.ts";
import { CHUNK, CREATE, errCode, fsyncDir, inSnapshotFolder, READ, writeAll } from "./files.ts";
import {
  AREA_NAMES,
  LEDGER_FILE,
  leftOut,
  PROBE_FILE,
  SEALED,
  SEALED_FILE,
  SEALING_FILE,
  type SnapshotArea,
} from "./layout.ts";
import { readManifest, type SnapshotEntry, type SnapshotManifest } from "./manifest.ts";

/**
 * Taking a snapshot: the ledger copied first, then each part's plain files sealed into the
 * snapshot folder (a file sealed there already is not sealed again), the manifest written last
 * and renamed into place, and the sealed files no manifest names removed. Root's helper
 * (snapshot-main.ts) takes one, with the job the broker gives it (TakeJob).
 */

/**
 * Finishes what a take that was stopped left, in the working folder: a `manifest.new` that
 * verifies and is newer takes the place of `manifest`; one that does not goes. Gives the newest
 * manifest that verifies, or why the one there does not.
 */
function settle(keys: SnapshotKeys): { manifest?: SnapshotManifest; why?: string } {
  const cur = readManifest(SEALED.manifest, keys);
  let best = cur && "manifest" in cur ? cur.manifest : undefined;
  const next = readManifest(SEALED.next, keys);
  if (next) {
    if ("manifest" in next && (!best || next.manifest.seq > best.seq)) {
      renameSync(SEALED.next, SEALED.manifest);
      fsyncDir(".");
      best = next.manifest;
    } else unlinkSync(SEALED.next);
  }
  if (best) return { manifest: best };
  return cur && "why" in cur ? { why: cur.why } : {};
}

/** Whether a sealed file is in the working folder, with the size sealing gives `size` bytes. */
function sealedThere(name: string, size: number): boolean {
  try {
    const st = lstatSync(name);
    return st.isFile() && st.size === size + SEAL_OVERHEAD;
  } catch {
    return false;
  }
}

/**
 * Seals what `fd` holds into the working folder: into a new file of its own first, then renamed
 * to its sealed name, unless a sealed file of that name is there already (the same content).
 */
function sealInto(fd: number, keys: SnapshotKeys): FileDigest & { reused: boolean } {
  const temp = `.new-${randomBytes(16).toString("hex")}`;
  const out = openSync(temp, CREATE, 0o600);
  let digest: FileDigest;
  try {
    const sealer = new FileSealer(keys);
    writeAll(out, sealer.header);
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, null);
      if (got === 0) break;
      writeAll(out, sealer.update(buf.subarray(0, got)));
    }
    const end = sealer.final();
    writeAll(out, end.tail);
    fsyncSync(out);
    digest = end.digest;
  } catch (err) {
    closeSync(out);
    rmSync(temp, { force: true });
    throw err;
  }
  closeSync(out);
  if (sealedThere(digest.name, digest.size)) {
    unlinkSync(temp);
    return { ...digest, reused: true };
  }
  renameSync(temp, digest.name);
  return { ...digest, reused: false };
}

/**
 * Removes from the working folder what no manifest names: sealed files, files being sealed that
 * a stopped take left, and the users' empty probe files. Never a folder, and nothing else: a name
 * a sealed snapshot never uses stays, for the isolation check to find.
 */
function sweep(keep: ReadonlySet<string>): number {
  let removed = 0;
  for (const name of readdirSync(".")) {
    if (name === SEALED.manifest || keep.has(name)) continue;
    if (!SEALED_FILE.test(name) && !SEALING_FILE.test(name) && !PROBE_FILE.test(name)) continue;
    try {
      if (lstatSync(name).isDirectory()) continue;
      unlinkSync(name);
      removed++;
    } catch {
      // gone meanwhile
    }
  }
  return removed;
}

/** A copy of the ledger made with SQLite's backup: consistent while the ledger is written. */
export async function backupLedger(source: string, dest: string): Promise<void> {
  const db = new DatabaseSync(source);
  try {
    db.exec("pragma busy_timeout = 10000");
    // Every page in one step, in one read transaction: a write meanwhile cannot restart it. (The
    // most pages one step takes: Node.js 24 refuses SQLite's -1 for "all".)
    await backup(db, dest, { rate: 2_147_483_647 });
  } finally {
    db.close();
  }
}

export interface TakeResult {
  taken_at: string;
  reason: string;
  /** Its number: one more than the snapshot before it. */
  seq: number;
  files: number;
  dirs: number;
  bytes: number;
  /** Files whose sealed file was there already: unchanged, or the same content as another. */
  reused: number;
  /** Files sealed now. */
  sealed: number;
  /** Sealed files no manifest names any more, removed after the swap. */
  removed: number;
  ledger: boolean;
  /** Why the manifest before it did not verify, when it did not: every file was sealed again. */
  before_refused?: string;
  /** What was not taken, and why: links, devices, pipes, sockets, another owner's files. */
  skipped: string[];
  ms: number;
}

/**
 * Takes a sealed snapshot of `areas` into `dir` (root's folder on the volume). `backupLedger`
 * makes a consistent copy of the live ledger and gives its path (the broker makes it as the
 * controller's user). Throws when the snapshot can't be written; the snapshot before it then stays.
 */
export async function takeSnapshot(o: {
  dir: string;
  areas: readonly SnapshotArea[];
  reason: string;
  keys: SnapshotKeys;
  /** The rig's ID (THERMITE_RIG_ID), recorded in the manifest. */
  rig?: string | null | undefined;
  backupLedger: (source: string) => Promise<string>;
  now?: () => Date;
}): Promise<TakeResult> {
  const started = Date.now();
  const takenAt = (o.now?.() ?? new Date()).toISOString();
  const harness = o.areas.find((a) => a.name === "harness");
  const ledgerLive = harness ? join(harness.live, LEDGER_FILE) : undefined;
  // The ledger first, before any other part is read: an export the ledger records as made is
  // then in the outbox's copy too (one made after it is exported again, never lost).
  let ledgerThere = false;
  try {
    ledgerThere = ledgerLive !== undefined && lstatSync(ledgerLive).isFile();
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  const staged = ledgerLive && ledgerThere ? await o.backupLedger(ledgerLive) : undefined;
  return inSnapshotFolder(o.dir, () => {
    const settled = settle(o.keys);
    const before = new Map<string, SnapshotEntry>();
    for (const e of settled.manifest?.entries ?? [])
      if (e.type === "file" && !e.ledger) before.set(`${e.area}\0${e.path}`, e);
    const entries: SnapshotEntry[] = [];
    const r: TakeResult = {
      taken_at: takenAt,
      reason: o.reason,
      seq: (settled.manifest?.seq ?? 0) + 1,
      files: 0,
      dirs: 0,
      bytes: 0,
      reused: 0,
      sealed: 0,
      removed: 0,
      ledger: false,
      ...(settled.why ? { before_refused: settled.why } : {}),
      skipped: [],
      ms: 0,
    };
    const skip = (area: SnapshotArea, rel: string, why: string): void => {
      r.skipped.push(`${area.name}/${rel}: ${why}`);
    };
    const addFile = (
      area: SnapshotArea,
      rel: string,
      st: Stats,
      d: FileDigest,
      reused: boolean,
      ledger = false,
    ) => {
      entries.push({
        area: area.name,
        path: rel,
        type: "file",
        mode: st.mode & 0o777,
        uid: st.uid,
        gid: st.gid,
        mtime_ms: st.mtimeMs,
        size: d.size,
        sealed: d.name,
        sha256: d.sha256,
        ...(ledger ? { ledger: true as const } : {}),
      });
      r.files++;
      r.bytes += d.size;
      if (reused) r.reused++;
      else r.sealed++;
    };
    /** Seals a plain file opened without following a link; why not, or undefined when gone. */
    const sealPlain = (
      path: string,
      owner: number | undefined,
    ): (FileDigest & { reused: boolean }) | { refused: string } | undefined => {
      let fd: number;
      try {
        fd = openSync(path, READ);
      } catch (err) {
        if (errCode(err) === "ENOENT") return undefined;
        if (errCode(err) === "ELOOP") return { refused: "a link" };
        throw err;
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) return { refused: "not a plain file" };
        if (owner !== undefined && st.uid !== owner)
          return { refused: `owned by uid ${st.uid}, not ${owner}` };
        return sealInto(fd, o.keys);
      } finally {
        closeSync(fd);
      }
    };
    const walk = (area: SnapshotArea, rel: string): void => {
      if (leftOut(area, rel)) return;
      const live = rel ? join(area.live, rel) : area.live;
      let st: Stats;
      try {
        st = lstatSync(live);
      } catch (err) {
        if (errCode(err) === "ENOENT") return;
        throw err;
      }
      const why = st.isSymbolicLink()
        ? "a link"
        : !st.isDirectory() && !st.isFile()
          ? "not a plain file or folder"
          : st.uid !== area.uid
            ? `owned by uid ${st.uid}, not ${area.uid}`
            : undefined;
      if (why) {
        skip(area, rel, why);
        return;
      }
      if (st.isDirectory()) {
        entries.push({
          area: area.name,
          path: rel,
          type: "dir",
          mode: st.mode & 0o7777,
          uid: st.uid,
          gid: st.gid,
        });
        r.dirs++;
        let names: string[];
        try {
          names = readdirSync(live).sort();
        } catch (err) {
          if (errCode(err) === "ENOENT") return;
          throw err;
        }
        for (const n of names) walk(area, rel ? `${rel}/${n}` : n);
        return;
      }
      if (area.name === "harness" && rel === LEDGER_FILE) {
        if (!staged) return;
        const c = sealPlain(staged, undefined);
        if (!c || "refused" in c) throw new Error("the ledger's copy is gone or not a plain file");
        addFile(area, rel, st, c, c.reused, true);
        r.ledger = true;
        return;
      }
      // Unchanged since the last snapshot, and its sealed file still there: not read again.
      const was = before.get(`${area.name}\0${rel}`);
      if (
        was?.sealed !== undefined &&
        was.sha256 !== undefined &&
        was.mtime_ms !== undefined &&
        was.size === st.size &&
        Math.abs(was.mtime_ms - st.mtimeMs) < 0.001 &&
        sealedThere(was.sealed, was.size)
      ) {
        addFile(area, rel, st, { name: was.sealed, sha256: was.sha256, size: was.size }, true);
        return;
      }
      const c = sealPlain(live, area.uid);
      if (!c) return;
      if ("refused" in c) {
        skip(area, rel, c.refused);
        return;
      }
      addFile(area, rel, st, c, c.reused);
    };
    let wroteNext = false;
    try {
      for (const area of o.areas) walk(area, "");
      const manifest: SnapshotManifest = {
        format: "thermite-state-snapshot",
        version: 2,
        rig: o.rig ?? null,
        seq: r.seq,
        taken_at: takenAt,
        reason: o.reason,
        entries,
      };
      const sealed = seal(o.keys.manifest, "manifest", Buffer.from(JSON.stringify(manifest)));
      rmSync(SEALED.next, { force: true });
      wroteNext = true;
      const fd = openSync(SEALED.next, CREATE, 0o600);
      try {
        writeAll(fd, sealed);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDir(".");
      renameSync(SEALED.next, SEALED.manifest);
      wroteNext = false;
      fsyncDir(".");
    } catch (err) {
      if (wroteNext) rmSync(SEALED.next, { force: true });
      throw err;
    }
    r.removed = sweep(new Set(entries.flatMap((e) => (e.sealed ? [e.sealed] : []))));
    r.ms = Date.now() - started;
    return r;
  });
}

/** What the broker gives its helper (snapshot-main.ts) on its standard input, as JSON. */
export const TakeJob = z.object({
  dir: z.string(),
  reason: z.string(),
  areas: z.array(
    z.object({
      name: z.enum(AREA_NAMES),
      live: z.string(),
      uid: z.number().int(),
      gid: z.number().int(),
      only: z.string().optional(),
    }),
  ),
  /** A folder root makes for the ledger's copy, which the controller's user writes. */
  stage: z.string(),
  /** The ledger's owner: the controller's user. */
  owner: z.object({ uid: z.number().int(), gid: z.number().int() }),
  /** The rig's ID, for the manifest. */
  rig: z.string().nullable(),
  /** The snapshot key, in base64url: on the helper's standard input only, never its arguments. */
  key: z.string(),
});
export type TakeJob = z.infer<typeof TakeJob>;

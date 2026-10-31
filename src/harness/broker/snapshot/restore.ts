import {
  chmodSync,
  closeSync,
  fstatSync,
  lchownSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sameSecret } from "../../../common/secrets.ts";
import {
  FileOpener,
  SEAL_HEADER_BYTES,
  SEAL_OVERHEAD,
  type SnapshotKeys,
  SnapshotRefused,
} from "../seal.ts";
import { CHUNK, CREATE, errCode, inSnapshotFolder, READ, readAt, writeAll } from "./files.ts";
import { type AreaName, leftOut, SEALED, type SnapshotArea, safeRel } from "./layout.ts";
import { readManifest, type SnapshotManifest } from "./manifest.ts";

/**
 * Restoring the newest snapshot into empty live folders: all of it, once its manifest and every
 * file in it verify, or none of it.
 */

/**
 * The newest snapshot in the working folder whose manifest verifies: `manifest`, or a complete
 * `manifest.new` a take left before its rename. Nothing when neither is there; why, when one is
 * there and none verifies.
 */
function pickManifest(
  keys: SnapshotKeys,
): { name: string; manifest: SnapshotManifest } | { why: string } | undefined {
  const reads = [SEALED.manifest, SEALED.next].map((name) => ({
    name,
    read: readManifest(name, keys),
  }));
  let best: { name: string; manifest: SnapshotManifest } | undefined;
  for (const { name, read } of reads)
    if (read && "manifest" in read && (!best || read.manifest.seq > best.manifest.seq))
      best = { name, manifest: read.manifest };
  if (best) return best;
  const failed = reads.find((r) => r.read && "why" in r.read)?.read;
  return failed && "why" in failed ? { why: failed.why } : undefined;
}

/** The parts of the live state that hold anything: none on a container's fresh disk. */
export function liveHolds(areas: readonly SnapshotArea[]): string[] {
  const holds: string[] = [];
  for (const a of areas) {
    try {
      const names = readdirSync(a.live).filter((n) => !leftOut(a, n));
      if (names.length) holds.push(a.name);
    } catch (err) {
      if (errCode(err) !== "ENOENT") holds.push(a.name);
    }
  }
  return holds;
}

export interface RestoreResult {
  /** The manifest it came from: `manifest`, or a complete `manifest.new`. */
  from: string;
  seq: number;
  taken_at: string;
  reason: string;
  /** What was restored into each part. */
  areas: Record<string, { files: number; dirs: number; bytes: number }>;
  /** What the manifest names that this rig does not restore, and why. */
  refused: string[];
}

/** Where a part is restored before it takes its live folder's place. */
export const RESTORING = ".restoring";

/**
 * Opens a sealed file of the working folder into `dest`, a new file: its size, its tag, and the
 * content's SHA-256, size and keyed hash must all be the ones the manifest names, or it throws
 * SnapshotRefused. Gives the bytes written.
 */
function openInto(
  e: { sealed: string; sha256: string; size: number },
  dest: string,
  keys: SnapshotKeys,
): number {
  let fd: number;
  try {
    fd = openSync(e.sealed, READ);
  } catch (err) {
    if (errCode(err) === "ENOENT") throw new SnapshotRefused("its sealed file is missing");
    if (errCode(err) === "ELOOP") throw new SnapshotRefused("its sealed file is a link");
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SnapshotRefused("its sealed file is not a plain file");
    if (st.size !== e.size + SEAL_OVERHEAD)
      throw new SnapshotRefused(
        `its sealed file is ${st.size} bytes, not the ${e.size + SEAL_OVERHEAD} the manifest gives`,
      );
    const tagAt = st.size - (SEAL_OVERHEAD - SEAL_HEADER_BYTES);
    const opener = new FileOpener(keys, readAt(fd, SEAL_HEADER_BYTES, 0), readAt(fd, 16, tagAt));
    const out = openSync(dest, CREATE, 0o600);
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (let pos = SEAL_HEADER_BYTES; pos < tagAt; ) {
        const got = readSync(fd, buf, 0, Math.min(buf.length, tagAt - pos), pos);
        if (got === 0) throw new SnapshotRefused("its sealed file is cut short");
        writeAll(out, opener.update(buf.subarray(0, got)));
        pos += got;
      }
      const end = opener.final();
      writeAll(out, end.tail);
      if (
        end.digest.size !== e.size ||
        !sameSecret(end.digest.sha256, e.sha256) ||
        !sameSecret(end.digest.name, e.sealed)
      )
        throw new SnapshotRefused("its content is not the one the manifest names");
      return end.digest.size;
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Puts the newest snapshot back into the live folders, which must hold nothing but what a
 * snapshot leaves out (liveHolds). The manifest must verify, be this rig's (`rig`), and every
 * file it names must verify against it: otherwise the whole snapshot is refused (SnapshotRefused)
 * and nothing is restored. Plain files and folders only, under the parts this rig has and the
 * names a snapshot holds, each given its part's owner and the mode it had. Each part is written
 * beside its live folder first (`<live>.restoring`) and renamed into place once every part is
 * written and verified: a restore that fails leaves the live folders as they were. Nothing in the
 * snapshot folder changes. `own` gives a restored path its owner (root's lchown by default; tests
 * give their own). Undefined when there is no snapshot.
 */
export function restoreSnapshot(o: {
  dir: string;
  areas: readonly SnapshotArea[];
  keys: SnapshotKeys;
  rig?: string | null | undefined;
  own?: (path: string, uid: number, gid: number) => void;
}): RestoreResult | undefined {
  return inSnapshotFolder(o.dir, () => {
    const found = pickManifest(o.keys);
    if (!found) return undefined;
    if ("why" in found) throw new SnapshotRefused(found.why);
    const m = found.manifest;
    if ((m.rig ?? null) !== (o.rig ?? null))
      throw new SnapshotRefused(
        `it is ${m.rig ? `rig ${m.rig}'s` : "no rig's"}, not ${o.rig ? `rig ${o.rig}'s` : "this rig's"}`,
      );
    const own = o.own ?? ((p: string, uid: number, gid: number) => lchownSync(p, uid, gid));
    const byName = new Map(o.areas.map((a) => [a.name, a]));
    const staging = (a: SnapshotArea) => `${a.live}${RESTORING}`;
    for (const a of o.areas) rmSync(staging(a), { recursive: true, force: true });
    const result: RestoreResult = {
      from: found.name,
      seq: m.seq,
      taken_at: m.taken_at,
      reason: m.reason,
      areas: {},
      refused: [],
    };
    const restored = new Set<string>();
    const dirModes: [string, number][] = [];
    const renamed: SnapshotArea[] = [];
    const countsOf = (area: AreaName) => {
      const counts = result.areas[area] ?? { files: 0, dirs: 0, bytes: 0 };
      result.areas[area] = counts;
      return counts;
    };
    try {
      for (const e of m.entries) {
        const label = `${e.area}/${e.path}`;
        const refuse = (why: string) => result.refused.push(`${label}: ${why}`);
        const area = byName.get(e.area);
        if (!area) {
          refuse("not a part of this rig");
          continue;
        }
        if (!safeRel(e.path) || leftOut(area, e.path)) {
          refuse("not a name a snapshot holds");
          continue;
        }
        if (e.path === "" && e.type !== "dir") {
          refuse("a part's top must be a folder");
          continue;
        }
        const cut = e.path.lastIndexOf("/");
        const parent = e.path === "" ? undefined : cut < 0 ? "" : e.path.slice(0, cut);
        if (parent !== undefined && !restored.has(`${e.area}\0${parent}`)) {
          refuse("its folder was not restored");
          continue;
        }
        const dest = e.path ? join(staging(area), e.path) : staging(area);
        if (e.type === "dir") {
          if (e.path === "") mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
          mkdirSync(dest, { mode: 0o700 });
          own(dest, area.uid, area.gid);
          // Its own mode once everything in it is there: no set-user-id bit on a folder.
          dirModes.push([dest, e.mode & 0o3777]);
          restored.add(`${e.area}\0${e.path}`);
          countsOf(e.area).dirs++;
          continue;
        }
        let bytes: number;
        try {
          bytes = openInto(
            { sealed: e.sealed as string, sha256: e.sha256 as string, size: e.size as number },
            dest,
            o.keys,
          );
        } catch (err) {
          if (err instanceof SnapshotRefused) throw new SnapshotRefused(`${label}: ${err.message}`);
          throw err;
        }
        own(dest, area.uid, area.gid);
        // No set-id bit on a file: the rig image has none anywhere.
        chmodSync(dest, e.mode & 0o777);
        if (e.mtime_ms !== undefined) utimesSync(dest, e.mtime_ms / 1000, e.mtime_ms / 1000);
        const counts = countsOf(e.area);
        counts.files++;
        counts.bytes += bytes;
      }
      for (const [path, mode] of dirModes.reverse()) chmodSync(path, mode);
      // Every part is written and verified: each takes its live folder's place, which holds at
      // most what a snapshot leaves out (a temporary folder, an export not finished, a stale
      // write-ahead file).
      for (const a of o.areas)
        if (restored.has(`${a.name}\0`) && liveHolds([a]).length)
          throw new Error(`${a.live} is not empty: nothing is restored over it`);
      for (const a of o.areas) {
        if (!restored.has(`${a.name}\0`)) continue;
        rmSync(a.live, { recursive: true, force: true });
        renameSync(staging(a), a.live);
        renamed.push(a);
      }
    } catch (err) {
      // All or nothing: a part already in place goes again, so nothing half restored is left.
      for (const a of renamed) rmSync(a.live, { recursive: true, force: true });
      for (const a of o.areas) rmSync(staging(a), { recursive: true, force: true });
      throw err;
    }
    return result;
  });
}

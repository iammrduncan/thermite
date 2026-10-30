import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GIB } from "../../common/disk.ts";

/**
 * Copies of a lane's working area in a run's research folder: its files saved when its trial ends,
 * shown to the other lanes, and given back at its next trial. A copy reads each file a part at a
 * time, so a large file never sits whole in the controller's memory.
 */

/** The most files one copy of a lane's working area takes: a larger area is not copied. */
export const LANE_COPY_FILES_MAX = 20_000;

/** The most bytes one copy of a lane's working area takes (4 GiB): a larger area is not copied. */
export const LANE_COPY_BYTES_MAX = 4 * GIB;

/** How much of a file a copy reads at once. */
const CHUNK_BYTES = 1024 * 1024;

/** A copy refused for its size, in words: what the area holds, against its limit. */
export class LaneCopyRefused extends Error {
  override name = "LaneCopyRefused";
}

/**
 * Regular files under a directory, relative paths; symlinks and special files are left out. With
 * `max`, a directory that holds more is refused (LaneCopyRefused) before the walk goes further.
 */
export function regularFiles(
  dir: string,
  skip: (rel: string) => boolean = () => false,
  max = Number.POSITIVE_INFINITY,
): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    const p = rel ? join(dir, rel) : dir;
    const st = lstatSync(p);
    if (st.isDirectory()) {
      for (const n of readdirSync(p).sort()) {
        const r = rel ? join(rel, n) : n;
        if (!skip(r)) visit(r);
      }
    } else if (st.isFile() && rel) {
      out.push(rel);
      if (out.length > max)
        throw new LaneCopyRefused(`more than ${max.toLocaleString("en-US")} files`);
    }
  };
  if (existsSync(dir)) visit("");
  return out;
}

/**
 * Copies one regular file a part at a time, hashing what it copies. A link, or anything but a
 * regular file, is left out (undefined): it changed under the copy. More than `budget` bytes is
 * refused (LaneCopyRefused).
 */
function copyFile(
  src: string,
  dest: string,
  budget: number,
): { sha256: string; bytes: number } | undefined {
  let fd: number;
  try {
    fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    mkdirSync(dirname(dest), { recursive: true });
    const out = openSync(dest, "w");
    try {
      const hash = createHash("sha256");
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      let bytes = 0;
      for (let n = readSync(fd, buf, 0, CHUNK_BYTES, null); n > 0; ) {
        bytes += n;
        if (bytes > budget) throw new LaneCopyRefused("more bytes than its limit");
        hash.update(buf.subarray(0, n));
        writeSync(out, buf, 0, n);
        n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      }
      return { sha256: hash.digest("hex"), bytes };
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies a tree's regular files (modes from the umask: readable by every role), each with its
 * SHA-256 and size. A tree of more than LANE_COPY_FILES_MAX files or LANE_COPY_BYTES_MAX bytes is
 * refused (LaneCopyRefused, in words), and what was copied of it stays for the caller to remove.
 */
export function copyTree(
  from: string,
  to: string,
  limits = { files: LANE_COPY_FILES_MAX, bytes: LANE_COPY_BYTES_MAX },
): Map<string, { sha256: string; bytes: number }> {
  const files = regularFiles(from, undefined, limits.files);
  let size = 0;
  for (const rel of files) {
    try {
      size += lstatSync(join(from, rel)).size;
    } catch {
      // gone since the walk: left out below
    }
  }
  const limitWords = `${(limits.bytes / GIB).toLocaleString("en-US")} GiB`;
  if (size > limits.bytes)
    throw new LaneCopyRefused(`${(size / GIB).toFixed(1)} GiB, more than ${limitWords}`);
  const seen = new Map<string, { sha256: string; bytes: number }>();
  mkdirSync(to, { recursive: true });
  let left = limits.bytes;
  for (const rel of files) {
    let copied: { sha256: string; bytes: number } | undefined;
    try {
      copied = copyFile(join(from, rel), join(to, rel), left);
    } catch (err) {
      if (err instanceof LaneCopyRefused) throw new LaneCopyRefused(`more than ${limitWords}`);
      throw err;
    }
    if (!copied) continue; // changed under us into something else: left out
    left -= copied.bytes;
    seen.set(rel, copied);
  }
  return seen;
}

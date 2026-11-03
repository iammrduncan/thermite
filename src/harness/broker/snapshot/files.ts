import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { errorText } from "../../../common/errors.ts";

/**
 * Reading and writing in the snapshot folder, which a take and a restore share: root works from
 * inside it (inSnapshotFolder), by bare names, never following a link.
 */

export const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const CREATE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export const CHUNK = 1024 * 1024;

export const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;

export function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

export function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const got = readSync(fd, buf, n, length - n, position + n);
    if (got === 0) break;
    n += got;
  }
  return buf.subarray(0, n);
}

export function fsyncDir(path: string): void {
  try {
    const fd = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // a file system that cannot sync a folder: the rename still happened
  }
}

/**
 * Runs `fn` inside the snapshot folder: its working folder is the folder, and every name `fn`
 * uses is a bare name in it. Another user who renames the folder or puts a link in its place
 * (a volume that ignores permissions lets any user) can then never send root's writes, reads or
 * removals elsewhere. The folder must be a folder, not a link, and still the one entered.
 */
export function inSnapshotFolder<T>(dir: string, fn: () => T): T {
  let back = "/";
  try {
    back = process.cwd();
  } catch {
    // the working folder is gone: come back to /
  }
  const before = lstatSync(dir);
  if (!before.isDirectory()) throw new Error(`${dir} is not a folder`);
  process.chdir(dir);
  try {
    const here = statSync(".");
    const after = lstatSync(dir);
    if (
      !after.isDirectory() ||
      here.ino !== before.ino ||
      here.dev !== before.dev ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    )
      throw new Error(`${dir} changed as it was opened: nothing is read or written there`);
    return fn();
  } finally {
    process.chdir(back);
  }
}

/** A plain file in the working folder, whole, or nothing when it is not there. */
export function readWhole(name: string, max: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(name, READ);
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    throw new Error(
      errCode(err) === "ELOOP" ? "it is a link" : `it can't be opened (${errorText(err)})`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("it is not a plain file");
    if (st.size > max) throw new Error(`it is larger than ${max} bytes`);
    return readAt(fd, st.size, 0);
  } finally {
    closeSync(fd);
  }
}

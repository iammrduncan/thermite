import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes a file whole or not at all: to a temporary file beside it, renamed over it once written.
 * Its folder is made when missing. With `mode`, the file has that mode before it takes the name.
 */
export function writeAtomic(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * What a crash left of the writes in `dir`: its `.tmp-` entries, files or folders, removed. Call
 * it at a start, before anything writes there. The names removed.
 */
export function sweepTemp(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const left = readdirSync(dir).filter((name) => name.startsWith(".tmp-"));
  for (const name of left) rmSync(join(dir, name), { recursive: true, force: true });
  return left;
}

/** How much of a file fileSha256 holds at once. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/** A file's SHA-256 in hex, read a chunk at a time, so a large file is never held whole. */
export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk))
      hash.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

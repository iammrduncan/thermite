import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DiskWatch } from "./disk.ts";
import { fetchBundle } from "./git.ts";

/**
 * Imports from the shared inbox. The supervisor writes the inbox; the harness only reads it.
 * Every import is copied into the harness's own state volume first and hashed *as copied*,
 * so nothing can change between verification and use.
 */

export class ImportError extends Error {}

/** Resolves a relative inbox path, refusing traversal and symlinks that escape the inbox. */
export function resolveInbox(inboxDir: string, rel: string): string {
  const root = realpathSync(inboxDir);
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep)) throw new ImportError(`path escapes inbox: ${rel}`);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new ImportError(`not found in inbox: ${rel}`);
  }
  if (!real.startsWith(root + sep)) throw new ImportError(`symlink escapes inbox: ${rel}`);
  return real;
}

/**
 * Before an import is copied: its size in bytes, so the caller can refuse it when it would take
 * the rig's disk below its floor (DiskWatch.refuseBelowFloor). Throws to refuse.
 */
export type ImportRoom = (bytes: number, dir: string) => void;

/** An import's check of the rig's disk, as `what` in its words (none without a disk watch). */
export const importRoom =
  (disk: DiskWatch | undefined, what: string): ImportRoom =>
  (bytes, dir) =>
    disk?.refuseBelowFloor(what, dir, bytes);

/**
 * Copies src to dest as a stream while hashing the bytes written, at most the size src had when
 * the copy started (a file that grows while it is copied is refused). Returns the sha256 hex.
 */
async function copyHashed(src: string, dest: string, room?: ImportRoom): Promise<string> {
  const size = statSync(src).size;
  room?.(size, dirname(dest));
  const hash = createHash("sha256");
  let copied = 0;
  await pipeline(
    createReadStream(src),
    async function* (source) {
      for await (const chunk of source) {
        copied += (chunk as Buffer).length;
        if (copied > size) throw new ImportError(`${src} grew while it was copied`);
        hash.update(chunk as Buffer);
        yield chunk;
      }
    },
    createWriteStream(dest, { mode: 0o440 }),
  );
  return hash.digest("hex");
}

/**
 * Imports a file (for example a model) whose sha256 is named in a signed command.
 * Returns the stored path, `<storeDir>/<sha256>`.
 */
export async function importFile(input: {
  inboxDir: string;
  rel: string;
  expectedSha256: string;
  storeDir: string;
  room?: ImportRoom | undefined;
}): Promise<string> {
  const src = resolveInbox(input.inboxDir, input.rel);
  mkdirSync(input.storeDir, { recursive: true });
  const tmp = join(input.storeDir, `.tmp-${randomUUID()}`);
  try {
    const sha = await copyHashed(src, tmp, input.room);
    if (sha !== input.expectedSha256) {
      throw new ImportError(
        `sha256 mismatch for ${input.rel}: expected ${input.expectedSha256}, got ${sha}`,
      );
    }
    const dest = join(input.storeDir, sha);
    renameSync(tmp, dest);
    // Read-only for everyone: the run user loads models by exact path (the directory is 0711).
    chmodSync(dest, 0o444);
    return dest;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Imports a git bundle whose expected commit is named in a signed command: copies it, then
 * fetches it into the mirror and checks the commit is present. Returns the bundle's sha256.
 */
export async function importBundle(input: {
  inboxDir: string;
  rel: string;
  mirror: string;
  scratchDir: string;
  importId: string;
  expectedCommit: string;
  expectedSha256?: string | undefined;
  room?: ImportRoom | undefined;
}): Promise<{ sha256: string; commit: string }> {
  const src = resolveInbox(input.inboxDir, input.rel);
  mkdirSync(input.scratchDir, { recursive: true });
  const tmp = join(input.scratchDir, `bundle-${randomUUID()}.bundle`);
  try {
    const sha256 = await copyHashed(src, tmp, input.room);
    if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
      throw new ImportError(
        `sha256 mismatch for ${input.rel}: expected ${input.expectedSha256}, got ${sha256}`,
      );
    }
    const commit = await fetchBundle(input.mirror, tmp, input.importId, input.expectedCommit);
    return { sha256, commit };
  } finally {
    rmSync(tmp, { force: true });
  }
}

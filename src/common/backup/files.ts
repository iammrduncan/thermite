import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The files of a backup (goal 173): copied with their size and SHA-256 taken as they go, checked
 * against them when read back, and given to the owner of the folder they go in when the command
 * runs as root, as in the compose stack's backup service.
 */

/** Who owns a file: its user and group. */
export interface Owner {
  uid: number;
  gid: number;
}

/** A file's size and SHA-256. */
export interface Hashed {
  bytes: number;
  sha256: string;
}

/** A stream through which bytes pass unchanged, counted and hashed. */
function hashing(): { through: Transform; done: () => Hashed } {
  const hash = createHash("sha256");
  let bytes = 0;
  const through = new Transform({
    transform(chunk: Buffer, _enc, next) {
      hash.update(chunk);
      bytes += chunk.length;
      next(null, chunk);
    },
  });
  return { through, done: () => ({ bytes, sha256: hash.digest("hex") }) };
}

/** A file's size and SHA-256, read through once. */
export async function hashFile(path: string): Promise<Hashed> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * Copies a file to `to`, making its folder, with the file's own mode, and gives its size and
 * SHA-256 as copied. A file there already is refused: a backup and a restore never write over one.
 */
export async function copyHashed(from: string, to: string): Promise<Hashed> {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const h = hashing();
  const mode = statSync(from).mode & 0o777;
  await pipeline(createReadStream(from), h.through, createWriteStream(to, { flags: "wx", mode }));
  chmodSync(to, mode);
  return h.done();
}

/**
 * Every regular file under a folder, as paths relative to it, sorted. Anything else, such as a
 * link, is refused in words: a backup copies files and folders, and follows nothing elsewhere.
 */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const s = lstatSync(path);
      if (s.isDirectory()) walk(path);
      else if (s.isFile()) out.push(relative(dir, path));
      else throw new Error(`${path} is neither a file nor a folder: a backup holds only those`);
    }
  };
  walk(dir);
  return out;
}

/**
 * Who should own what a backup or a restore writes into `dir`: its owner, when this process runs
 * as root and the folder belongs to someone else; otherwise nobody changes hands.
 */
export function ownerFor(dir: string): Owner | undefined {
  if (process.getuid?.() !== 0) return undefined;
  const s = statSync(dir);
  return s.uid === 0 && s.gid === 0 ? undefined : { uid: s.uid, gid: s.gid };
}

/**
 * Gives a SQLite database's `-wal` and `-shm` files, which opening it may make, to the database's
 * owner when this process runs as root: control could not open its store again otherwise.
 */
export function sidecarsToOwner(db: string): void {
  if (process.getuid?.() !== 0 || !existsSync(db)) return;
  const s = statSync(db);
  for (const end of ["-wal", "-shm"])
    if (existsSync(`${db}${end}`)) chownSync(`${db}${end}`, s.uid, s.gid);
}

/** Gives `path`, and everything under it, to `owner`. */
export function giveTo(path: string, owner: Owner | undefined): void {
  if (!owner || !existsSync(path)) return;
  chownSync(path, owner.uid, owner.gid);
  if (lstatSync(path).isDirectory())
    for (const name of readdirSync(path)) giveTo(join(path, name), owner);
}

/**
 * Moves each of `names` that is in `dir` into `aside` (made when one is there), on the same file
 * system: nothing is copied and nothing is deleted. The names moved.
 */
export function moveAside(dir: string, names: readonly string[], aside: string): string[] {
  const moved: string[] = [];
  for (const name of names) {
    const from = join(dir, name);
    if (!existsSync(from)) continue;
    mkdirSync(aside, { recursive: true, mode: 0o700 });
    renameSync(from, join(aside, name));
    moved.push(name);
  }
  return moved;
}

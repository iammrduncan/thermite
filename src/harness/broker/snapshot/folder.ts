import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { SEAL_MAGIC } from "../seal.ts";
import { READ, readAt } from "./files.ts";
import { PROBE_FILE, SEALED, SEALED_FILE, SEALING_FILE, UNSEALED_DIRS } from "./layout.ts";

/**
 * The snapshot folder itself: made by root at the broker's start, an older image's unsealed
 * snapshot removed from it, what each user meets trying to open it, the broker's record of all
 * that, and what the folder holds as the isolation check looks at it.
 */

/**
 * Makes the snapshot folder, root's with mode 0700, and says what owner and mode the volume
 * shows for it. Never changes its owner: the volume may refuse it. A link there is refused.
 */
export function prepareSnapshotDir(dir: string): { uid: number; gid: number; mode: number } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  chmodSync(dir, 0o700);
  const st = lstatSync(dir);
  return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
}

/**
 * The folders an image before sealing left in the snapshot folder: an unsealed snapshot, which
 * is never restored. Removed only where no other user may write in the folder (`closed`); where
 * one may, a recursive removal could be sent elsewhere, so they stay, and the isolation check
 * names them. Gives what was removed, and what was left.
 */
export function removeUnsealed(
  dir: string,
  closed: boolean,
): { removed: string[]; left: string[] } {
  const out = { removed: [] as string[], left: [] as string[] };
  for (const name of UNSEALED_DIRS) {
    const path = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (closed && st.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
      out.removed.push(name);
    } else out.left.push(name);
  }
  return out;
}

/** What a look into the snapshot folder found (inspectSnapshotFolder). */
export interface FolderLook {
  /** A manifest is there. */
  manifest: boolean;
  /** Sealed files, not counting those being written. */
  files: number;
  /** The first thing a sealed snapshot never holds: a file that is not sealed, or another name. */
  problem?: string;
}

/**
 * What the snapshot folder holds, looked at from outside it (the isolation check): only the
 * manifest, sealed files and empty probe files may be there, each sealed file starting as sealing
 * starts one. An empty file holds nothing and passes. Throws when the folder can't be listed. The
 * role probe (selftest.ts, PROBE) looks the same way.
 */
export function inspectSnapshotFolder(dir: string): FolderLook {
  const look: FolderLook = { manifest: false, files: 0 };
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory())
      return {
        ...look,
        problem: UNSEALED_DIRS.includes(name)
          ? `an unsealed snapshot an older image left: ${name}`
          : `a folder a sealed snapshot never holds: ${name}`,
      };
    if (!st.isFile())
      return { ...look, problem: `a link or special file a sealed snapshot never holds: ${name}` };
    const kind =
      name === SEALED.manifest || name === SEALED.next
        ? "M"
        : SEALED_FILE.test(name) || SEALING_FILE.test(name)
          ? "B"
          : PROBE_FILE.test(name)
            ? "P"
            : undefined;
    if (!kind) return { ...look, problem: `a name a sealed snapshot never uses: ${name}` };
    if (st.size === 0) continue;
    if (kind === "P") return { ...look, problem: `a file that is not sealed: ${name}` };
    let head: Buffer;
    try {
      const fd = openSync(path, READ);
      try {
        head = readAt(fd, SEAL_MAGIC.length + 1, 0);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (head.toString("latin1") !== `${SEAL_MAGIC.toString("latin1")}${kind}`)
      return { ...look, problem: `a file that is not sealed: ${name}` };
    if (name === SEALED.manifest) look.manifest = true;
    else if (SEALED_FILE.test(name)) look.files++;
  }
  return look;
}

/** A look in words: "the manifest and 12 sealed files", or "no snapshot yet". */
export function lookWords(look: FolderLook): string {
  if (!look.manifest && !look.files) return "no snapshot yet";
  const files = `${look.files} sealed file${look.files === 1 ? "" : "s"}`;
  return look.manifest ? `the manifest and ${files}` : `${files} and no manifest`;
}

/**
 * Run as another user: whether it can list the snapshot folder and write in it, as JSON. Its
 * file is empty, and removed again.
 */
export const CLOSED_PROBE_JS = `const fs=require("node:fs");const d=process.argv[1];const out={};try{fs.readdirSync(d);out.list="ALLOWED"}catch(e){out.list=e.code||String(e)}const p=d+"/probe-"+process.getuid();try{fs.writeFileSync(p,"",{flag:"wx"});out.create="ALLOWED";try{fs.rmSync(p)}catch{}}catch(e){out.create=e.code||String(e)}process.stdout.write(JSON.stringify(out))`;

/**
 * What each user met trying to list the snapshot folder and write in it (`run` runs the probe's
 * command as that user): "refused (EACCES)", "OPENED: …" or "failed: …".
 */
export function closedTo(
  users: readonly string[],
  run: (user: string) => { status: number | null; stdout: string; stderr: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const user of users) {
    const r = run(user);
    let got: { list?: unknown; create?: unknown };
    try {
      got = JSON.parse(r.stdout) as typeof got;
    } catch {
      out[user] = `failed: exit ${r.status} ${r.stderr.trim().slice(-200)}`;
      continue;
    }
    const opened = [
      ...(got.list === "ALLOWED" ? ["lists it"] : []),
      ...(got.create === "ALLOWED" ? ["writes in it"] : []),
    ];
    const code = (v: unknown) => typeof v === "string" && /^E[A-Z]+$/.test(v);
    out[user] = opened.length
      ? `OPENED: ${opened.join(" and ")}`
      : code(got.list) && code(got.create)
        ? `refused (${got.list})`
        : `failed: ${r.stdout.slice(0, 200)}`;
  }
  return out;
}

/** The broker's record of the snapshot folder (SNAPSHOT_RECORD), for the isolation selftest. */
export interface SnapshotRecord {
  dir: string;
  /** The owner and mode the volume shows for it, as "uid:gid" and octal. */
  owner: string;
  mode: string;
  /** What each user met trying to list it and write in it (closedTo). */
  users: Record<string, string>;
  /** Every user was refused. */
  closed: boolean;
  /** The launch gave the snapshot key: sealed snapshots are taken and restored. */
  sealed: boolean;
  /** Why no snapshot is taken or restored, when none is. */
  off?: string | undefined;
  at: string;
}

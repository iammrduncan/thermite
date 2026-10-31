import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";

/**
 * A copy of the program's session log in a plain file the harness may read. Claude Code keeps its
 * transcript readable by its own user only (0600), and the harness runs as another user, so the
 * host, which runs as the program's user, copies it as it grows into a 0644 file in its own area.
 * The copy is made of the log's bytes, in order, and never through a link: the log is not found
 * through one or opened through one, and a link in the copy's place is removed.
 *
 * A host started again (a session resumed after a crash) goes on from the copy's size, so the
 * harness's place in it holds. A log that has become shorter than the copy is copied again from
 * its start.
 */

/** The most bytes read at each step; the rest at the next. */
export const MIRROR_STEP_MAX = 4 * 1024 * 1024;
/** The most bytes copied: past it, the copy stops growing and says why. */
export const MIRROR_MAX = 256 * 1024 * 1024;
/** The most entries looked at in the log's folder at each step, while the log is not found. */
const LOOK_MAX = 2_000;

export interface MirrorState {
  from?: string | undefined;
  bytes: number;
  stopped?: string | undefined;
}

/** The first file under `dir`, at most `depth` folders down, whose name matches `name`. */
function find(dir: string, depth: number, name: RegExp): string | undefined {
  let looked = 0;
  const visit = (at: string, left: number): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++looked > LOOK_MAX) return undefined;
      const path = join(at, e.name);
      if (e.isFile() && name.test(e.name)) return path;
      if (e.isDirectory() && left > 0) {
        const found = visit(path, left - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(dir, depth);
}

export class Mirror {
  private readonly dir: string;
  private readonly depth: number;
  private readonly name: RegExp;
  private readonly to: string;
  private readonly max: number;
  private from: string | undefined;
  private bytes = 0;
  private stopped: string | undefined;

  /** `max`: the most bytes copied, MIRROR_MAX unless given. */
  constructor(o: { dir: string; depth: number; name: string; to: string; max?: number }) {
    this.dir = o.dir;
    this.depth = o.depth;
    this.name = new RegExp(o.name);
    this.to = o.to;
    this.max = o.max ?? MIRROR_MAX;
  }

  state(): MirrorState {
    return { from: this.from, bytes: this.bytes, stopped: this.stopped };
  }

  /** Copies what the log gained since the last step. */
  step(): void {
    if (this.stopped) return;
    this.from ??= find(this.dir, this.depth, this.name);
    if (!this.from) return;
    let src: number;
    try {
      src = openSync(this.from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return; // not there yet, or a link: nothing is copied
    }
    try {
      const st = fstatSync(src);
      if (!st.isFile()) return;
      const dst = this.openCopy(st.size);
      if (dst === undefined) return;
      try {
        if (this.bytes >= this.max && st.size > this.bytes) {
          this.stopped = `the session log passed ${this.max} bytes, the most the copy holds`;
          return;
        }
        const want = Math.min(st.size - this.bytes, MIRROR_STEP_MAX, this.max - this.bytes);
        if (want <= 0) return;
        const buf = Buffer.alloc(want);
        const got = readSync(src, buf, 0, want, this.bytes);
        writeSync(dst, buf, 0, got);
        this.bytes += got;
      } finally {
        closeSync(dst);
      }
    } catch (err) {
      this.stopped = `the copy failed: ${errorText(err)}`;
    } finally {
      closeSync(src);
    }
  }

  /**
   * The copy, open for appending, with `this.bytes` its size: a link in its place is removed, and a
   * copy longer than the log (`logSize`) is begun again.
   */
  private openCopy(logSize: number): number | undefined {
    const flags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
    let fd: number;
    try {
      fd = openSync(this.to, flags, 0o644);
    } catch {
      try {
        if (lstatSync(this.to).isSymbolicLink()) unlinkSync(this.to);
        fd = openSync(this.to, flags, 0o644);
      } catch (err) {
        this.stopped = `the copy can't be written: ${errorText(err)}`;
        return undefined;
      }
    }
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      this.stopped = "the copy's place holds something that is not a file";
      return undefined;
    }
    this.bytes = st.size;
    if (st.size > logSize) {
      closeSync(fd);
      unlinkSync(this.to);
      this.bytes = 0;
      return openSync(this.to, flags, 0o644);
    }
    return fd;
  }
}

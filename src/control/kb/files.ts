import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Bus, BusMessage, Handled } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  KB_FILE_CHUNK_BYTES,
  KB_FILES_CONSUMER_CONFIG,
  KB_FILES_STREAM_CONFIG,
  type KbFileChunk,
  readKbFileChunk,
} from "../../core/link/kb-files.ts";
import { controlDiskOf } from "../disk.ts";
import type { ControlStore } from "../store/index.ts";

/** How long a chunk waits on the stream while control's disk is at its floor, before it is tried again. */
export const KB_FILES_HELD_MS = 60_000;

/**
 * The knowledge base's files in control's state (goal 175, step 2). Each file is kept once, by its
 * SHA-256, at `<dir>/<its first two hex digits>/<sha256>`, named there only once it is whole and
 * checked, and recorded in the store (kb_file), from where every item that names its SHA-256 has
 * it. Control takes the chunks from the `KB_FILES` stream one at a time, in the order the rig's
 * supervisor put them (core/link/kb-files.ts), and puts each file together in
 * `<dir>/.partial/<rig>.<sha256>`: a first chunk starts it again, and drops any other file of the
 * rig's that was cut short, so a rig has one such file at most; a chunk it has is passed over, and
 * a chunk after a gap drops it, to be put again whole. At its last chunk control checks its size
 * and SHA-256, and keeps it or drops it, in its log and audit log (`kb_file_refused`). A chunk is
 * acked once written, so one control did not finish with is handed again. A file control holds
 * already takes nothing more. While control's disk is at its floor (disk.ts) nothing is written:
 * each chunk waits on the stream, tried again every KB_FILES_HELD_MS. The item and its file meet by the SHA-256, whichever comes first:
 * an item whose file is not here yet waits for it; a file no item names yet waits for its item.
 */
export class KbFiles {
  readonly dir: string;
  private readonly store: ControlStore;
  /** Files kept and chunks refused since control started, for its log and tests. */
  kept = 0;
  refused = 0;
  /** Whether chunks wait for room on control's disk now: said in the log once, when it begins. */
  private held = false;

  constructor(dir: string, store: ControlStore) {
    this.dir = dir;
    this.store = store;
  }

  /** Where a file control holds is. */
  path(sha256: string): string {
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  /** One chunk from the stream: written into its file, which is kept once whole and checked. */
  async take(m: BusMessage): Promise<Handled> {
    let c: KbFileChunk;
    try {
      c = readKbFileChunk(m);
    } catch (err) {
      this.refuse({ subject: m.subject.slice(0, 200) }, errorText(err));
      return undefined;
    }
    const kb = this.store.kb();
    if (kb.hasFile(c.sha256)) return undefined;
    const floor = controlDiskOf(this.store)?.held;
    if (floor) {
      if (!this.held)
        log("control", "files for the knowledge base wait for room", { floor }, "warn");
      this.held = true;
      return { againInMs: KB_FILES_HELD_MS };
    }
    this.held = false;
    const final = this.path(c.sha256);
    // Named only once checked: a control stopped before it recorded the file records it now.
    if (existsSync(final)) {
      kb.fileKept(c.sha256, statSync(final).size);
      return undefined;
    }
    const part = join(this.dir, ".partial", `${c.rig}.${c.sha256}`);
    mkdirSync(dirname(part), { recursive: true });
    if (c.chunk === 0) this.dropCutShort(c.rig, part);
    const have = c.chunk === 0 || !existsSync(part) ? 0 : statSync(part).size;
    const at = c.chunk * KB_FILE_CHUNK_BYTES;
    const size = Math.min(KB_FILE_CHUNK_BYTES, c.bytes - at);
    if (m.data.length !== size) {
      rmSync(part, { force: true });
      return this.refuse(c, `chunk ${c.chunk} holds ${m.data.length} bytes, not ${size}`);
    }
    if (at < have) return undefined;
    if (at > have) {
      rmSync(part, { force: true });
      return this.refuse(c, `chunk ${c.chunk} came after a gap: the file is put again whole`);
    }
    if (c.chunk === 0) await writeFile(part, m.data);
    else await appendFile(part, m.data);
    if (at + size < c.bytes) return undefined;
    const sha256 = await sha256Of(part);
    if (sha256 !== c.sha256) {
      rmSync(part, { force: true });
      return this.refuse(c, `its ${c.bytes} bytes have the SHA-256 ${sha256}, not its name`);
    }
    mkdirSync(dirname(final), { recursive: true });
    renameSync(part, final);
    kb.fileKept(c.sha256, c.bytes);
    this.kept++;
    log("control", "a file for the knowledge base kept", {
      rig: c.rig,
      sha256: c.sha256,
      bytes: c.bytes,
    });
    return undefined;
  }

  /** A rig puts one file at a time: its first chunk drops the rig's other files cut short. */
  private dropCutShort(rig: string, part: string): void {
    const dir = dirname(part);
    for (const name of readdirSync(dir))
      if (name.startsWith(`${rig}.`) && join(dir, name) !== part) {
        rmSync(join(dir, name), { force: true });
        log("control", "a file for the knowledge base cut short dropped", { rig, part: name });
      }
  }

  private refuse(what: Partial<KbFileChunk> & { subject?: string }, why: string): Handled {
    this.refused++;
    const said = { ...what, why };
    log("control", "a chunk of a file for the knowledge base refused", said, "warn");
    this.store.auditLog.add("control", "kb_file_refused", said);
    return undefined;
  }
}

/** A file's SHA-256, read in pieces. */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const piece of createReadStream(path)) hash.update(piece as Buffer);
  return hash.digest("hex");
}

/**
 * Control's follow of the `KB_FILES` stream, which it makes: each chunk to `files`, in order,
 * until the bus is closed.
 */
export function followKbFiles(bus: Pick<Bus, "follow">, files: KbFiles): Promise<void> {
  return bus.follow(KB_FILES_STREAM_CONFIG, KB_FILES_CONSUMER_CONFIG, (m) => files.take(m));
}

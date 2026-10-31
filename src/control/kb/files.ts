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
import { kbSettingsOf, overLimitWords } from "./settings.ts";

/** How long a chunk waits on the stream while control's disk is at its floor, before it is tried again. */
export const KB_FILES_HELD_MS = 60_000;

/** How often control looks for orphan files; while the setting is 0 a look removes nothing. */
export const KB_ORPHANS_LOOK_MS = 60 * 60_000;
/** The most orphan files one look removes; the others wait for the next look. */
export const KB_ORPHANS_PER_LOOK = 1_000;

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
 * Every file is kept for good, unless the owner sets how many hours an orphan stays (settings.ts;
 * THERMITE_CONTROL_KB_ORPHAN_HOURS by default): then a file no version of any item names, kept
 * more than that many hours ago, is an orphan, and removeOrphans removes it. A file over the
 * largest the owner lets the knowledge base take is not kept, unless an item control stored names
 * it already.
 */
export class KbFiles {
  readonly dir: string;
  private readonly store: ControlStore;
  /** Files kept and chunks refused since control started, for its log and tests. */
  kept = 0;
  refused = 0;
  /** Whether chunks wait for room on control's disk now: said in the log once, when it begins. */
  private held = false;
  /** THERMITE_CONTROL_KB_ORPHAN_HOURS as control read it: the setting's default. */
  readonly orphanHoursDefault: number;

  constructor(dir: string, store: ControlStore, o: { orphanHours?: number } = {}) {
    this.dir = dir;
    this.store = store;
    this.orphanHoursDefault = o.orphanHours ?? 0;
  }

  /** How many hours an orphan file stays now: the owner's setting, or its default. */
  orphanHours(): number {
    return kbSettingsOf(this.store, this.orphanHoursDefault).orphan_hours;
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
    if (kb.files.has(c.sha256)) return undefined;
    const limit = kb.settings.maxFileBytes();
    if (limit > 0 && c.bytes > limit && !kb.files.named(c.sha256)) return this.tooLarge(c, limit);
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
      kb.files.kept(c.sha256, statSync(final).size);
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
    kb.files.kept(c.sha256, c.bytes);
    this.kept++;
    log("control", "a file for the knowledge base kept", {
      rig: c.rig,
      sha256: c.sha256,
      bytes: c.bytes,
    });
    return undefined;
  }

  /**
   * Removes the orphans: files kept more than `hours` ago (the setting's now, by default) that no
   * version of any item names, as its item never arrived or was refused; 0 removes nothing. Each goes from control's state and
   * its store, with a line in its log and `kb_file_removed` in its audit log. An item that names
   * one later waits for its file, as an item that comes before its file does. Says how many went.
   */
  removeOrphans(hours = this.orphanHours(), now = Date.now()): number {
    if (!(hours > 0)) return 0;
    const files = this.store.kb().files;
    const before = new Date(now - hours * 3_600_000).toISOString();
    let removed = 0;
    for (const f of files.orphans(before, KB_ORPHANS_PER_LOOK)) {
      const what = { sha256: f.sha256, bytes: f.bytes, stored_at: f.stored_at, hours };
      try {
        rmSync(this.path(f.sha256), { force: true });
      } catch (err) {
        log(
          "control",
          "an orphan file not removed; trying again at the next look",
          {
            ...what,
            error: errorText(err),
          },
          "warn",
        );
        continue;
      }
      files.removed(f.sha256);
      removed++;
      log("control", "a file for the knowledge base removed: no item names it", what);
      this.store.auditLog.add("control", "kb_file_removed", what);
    }
    return removed;
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

  /**
   * A chunk of a file over the largest the knowledge base takes: dropped, and refused in control's
   * audit log once for the file, with how many of its chunks came; its log says so at its first.
   */
  private tooLarge(c: KbFileChunk, limit: number): Handled {
    this.refused++;
    const said = { rig: c.rig, sha256: c.sha256, bytes: c.bytes, why: overLimitWords(c, limit) };
    if (c.chunk === 0) log("control", "a file for the knowledge base refused", said, "warn");
    this.store.auditLog.refusal("control", "kb_file_refused", said);
    return undefined;
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

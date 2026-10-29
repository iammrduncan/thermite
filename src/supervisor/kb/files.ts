import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { writeAtomic } from "../../common/fs.ts";
import { KB_OUTBOX_FILES } from "../../core/kb.ts";
import {
  KB_FILE_CHUNK_BYTES,
  KB_FILE_HEADERS,
  kbChunkId,
  kbFileChunks,
  kbFileSubject,
} from "../../core/link/kb-files.ts";

/**
 * The knowledge base's files, from the rig's outbox to control (goal 175, step 2). The harness
 * keeps each item's file in the outbox by its SHA-256 (KB_OUTBOX_FILES); each round, before it
 * sends the rig's report, the supervisor puts every file it has not put yet on the `KB_FILES`
 * stream, in chunks in order on the rig's own subject (core/link/kb-files.ts), and notes it in its
 * state (`kb-files-put/<sha256>`), so a file is sent once. A file whose bytes do not have its name
 * as their SHA-256 is never put. A put cut short is not noted, and starts again at the next round:
 * the stream keeps once a chunk it had within its duplicate window, and control starts a file
 * again at its first chunk. With the bus away, or control's stream not made yet, the files wait in
 * the outbox, and the item's event in the ledger and the report, until both can go.
 */

/** The files one round puts at most: the rest wait for the next round. */
export const KB_FILES_PER_ROUND = 50;
/** Where the supervisor notes each file it put, in its own state. */
export const KB_FILES_PUT = "kb-files-put";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * What one round of puts did: files put, files still waiting, files whose bytes are not their name
 * (never put; they wait, said each round), and why it stopped, if it did.
 */
export interface KbFilesPut {
  put: number;
  waiting: number;
  spoilt: string[];
  error?: string | undefined;
}

/** The rig's files not put yet, oldest first, from the outbox. */
function waitingFiles(outboxDir: string, home: string): string[] {
  const dir = join(outboxDir, KB_OUTBOX_FILES);
  if (!existsSync(dir)) return [];
  const put = join(home, KB_FILES_PUT);
  return readdirSync(dir)
    .filter((n) => SHA256.test(n) && !existsSync(join(put, n)))
    .map((n) => ({ n, at: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.n.localeCompare(b.n))
    .map((f) => f.n);
}

/** Reads `bytes` of a file from `at`, one chunk. */
function chunkOf(fd: number, at: number, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let read = 0;
  while (read < bytes) {
    const n = readSync(fd, out, read, bytes - read, at + read);
    if (n === 0) throw new Error(`the file ended at ${at + read} bytes, before ${at + bytes}`);
    read += n;
  }
  return out;
}

/** A file's SHA-256, read a chunk at a time. */
function sha256Of(fd: number, bytes: number): string {
  const hash = createHash("sha256");
  for (let at = 0; at < bytes; at += KB_FILE_CHUNK_BYTES)
    hash.update(chunkOf(fd, at, Math.min(KB_FILE_CHUNK_BYTES, bytes - at)));
  return hash.digest("hex");
}

/**
 * Puts one file on the stream: each chunk with its place, the count and the file's size, and an
 * id the stream keeps once. False, and nothing put, for a file whose bytes are not its name.
 * Throws on a failure of the bus, the file not noted as put.
 */
async function putFile(
  bus: Pick<Bus, "publish">,
  rig: string,
  path: string,
  sha256: string,
): Promise<boolean> {
  const fd = openSync(path, "r");
  try {
    const bytes = statSync(path).size;
    if (sha256Of(fd, bytes) !== sha256) return false;
    const chunks = kbFileChunks(bytes);
    for (let i = 0; i < chunks; i++) {
      const at = i * KB_FILE_CHUNK_BYTES;
      const data = chunkOf(fd, at, Math.min(KB_FILE_CHUNK_BYTES, bytes - at));
      await bus.publish(kbFileSubject(rig, sha256), data, {
        id: kbChunkId(rig, sha256, i),
        headers: {
          [KB_FILE_HEADERS.chunk]: String(i),
          [KB_FILE_HEADERS.chunks]: String(chunks),
          [KB_FILE_HEADERS.bytes]: String(bytes),
        },
      });
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * One round: up to KB_FILES_PER_ROUND files the outbox holds and the supervisor has not put, each
 * put whole and then noted. A failure of the bus ends the round, said in its answer; the files left
 * wait for the next round.
 */
export async function putKbFiles(o: {
  rig: string;
  outboxDir: string;
  home: string;
  bus: Pick<Bus, "publish">;
}): Promise<KbFilesPut> {
  const waiting = waitingFiles(o.outboxDir, o.home);
  const out: KbFilesPut = { put: 0, waiting: waiting.length, spoilt: [] };
  for (const sha256 of waiting.slice(0, KB_FILES_PER_ROUND)) {
    let done: boolean;
    try {
      done = await putFile(o.bus, o.rig, join(o.outboxDir, KB_OUTBOX_FILES, sha256), sha256);
    } catch (err) {
      return { ...out, error: `${sha256}: ${errorText(err)}` };
    }
    if (!done) {
      out.spoilt.push(sha256);
      continue;
    }
    mkdirSync(join(o.home, KB_FILES_PUT), { recursive: true });
    writeAtomic(join(o.home, KB_FILES_PUT, sha256), "");
    out.put++;
    out.waiting--;
    log("supervisor", "a file for the knowledge base put on the bus", { rig: o.rig, sha256 });
  }
  return out;
}

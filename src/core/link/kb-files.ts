import type { ConsumerConfig, StreamConfig } from "@nats-io/jetstream";
import { RIG_ID } from "../ids.ts";

/**
 * The knowledge base's files on their way to control (goal 175, step 2): the `KB_FILES` stream. An
 * item's file is kept whole by its SHA-256 (core/kb.ts): the harness keeps it in the rig's outbox,
 * the rig's supervisor puts it here once, in chunks in order on the rig's own subject, each chunk
 * naming the file's SHA-256 in a header, and control takes each chunk, puts the file together in
 * its state, checks its SHA-256 and keeps it once. The stream is an inbox: a chunk stays until
 * control has taken it, and it holds at most KB_FILE_CHUNKS_WAITING_PER_RIG of one rig's. A rig's
 * user may publish on its own subject only, and may not read the stream or remove from it; no rig
 * can put a file under another rig's subject, so none can spoil another's. The file and its
 * `kb_item` event meet on control by the SHA-256, whichever comes first.
 */

/** The stream that holds the files' chunks until control has taken them. */
export const KB_FILES_STREAM = "KB_FILES";
/** Every rig's files: `thermite.rig.<rig>.kbfile`, one subject for each rig. */
export const KB_FILES_SUBJECTS = "thermite.rig.*.kbfile";
/** The durable consumer control takes the chunks with. */
export const KB_FILES_CONSUMER = "control-kb-files";

const SHA256 = /^[0-9a-f]{64}$/;
const SUBJECT = /^thermite\.rig\.([^.*>\s]+)\.kbfile$/;

/** The subject a rig's files go on, every one of them. */
export function kbFileSubject(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a file's subject: ${rig}`);
  return `thermite.rig.${rig}.kbfile`;
}

/**
 * How large each chunk of a file is: the last is the rest, and an empty file is one empty chunk.
 * Well under the server's largest message (REPORT_MAX_BYTES), and what control holds of a file in
 * memory at once.
 */
export const KB_FILE_CHUNK_BYTES = 1024 * 1024;

/** How many chunks a file of this many bytes goes in. */
export const kbFileChunks = (bytes: number): number =>
  Math.max(1, Math.ceil(bytes / KB_FILE_CHUNK_BYTES));

/**
 * Each chunk's headers: its file's SHA-256, its place in the file, from 0, how many there are, and
 * the file's size.
 */
export const KB_FILE_HEADERS = {
  sha256: "Thermite-Sha256",
  chunk: "Thermite-Chunk",
  chunks: "Thermite-Chunks",
  bytes: "Thermite-Bytes",
} as const;

/** Room kept above a chunk for its headers: its id, its file and its place. */
const HEADER_ROOM = 4096;
/** The largest chunk message, its headers included: a larger one is refused. */
export const KB_FILE_MAX_MESSAGE_BYTES = KB_FILE_CHUNK_BYTES + HEADER_ROOM;

/**
 * How many of one rig's chunks the stream holds waiting for control, at most: 256, so at most
 * 256 × KB_FILE_MAX_MESSAGE_BYTES (about 257 MiB) of one rig's. While a rig has as many waiting,
 * its next chunk is refused, and its supervisor puts the file again at its next round; other
 * rigs' files go on.
 */
export const KB_FILE_CHUNKS_WAITING_PER_RIG = 256;

/**
 * A chunk's message id: its rig, its file and its place, so that a chunk published again inside
 * the stream's duplicate window is kept once, and a put that starts again after a failure sends
 * on only what the stream lacks.
 */
export const kbChunkId = (rig: string, sha256: string, chunk: number): string =>
  `${rig}:${sha256}:${chunk}`;

/** One chunk as control reads it: its rig from the subject, its file and place from the headers. */
export interface KbFileChunk {
  rig: string;
  sha256: string;
  chunk: number;
  chunks: number;
  bytes: number;
}

const count = (v: string | undefined) => (v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : -1);

/**
 * A chunk's subject and headers read and checked against each other; throws, in words, on a
 * message that is not a chunk of a file, or whose place does not fit the file's size.
 */
export function readKbFileChunk(m: {
  subject: string;
  header(name: string): string | undefined;
}): KbFileChunk {
  const rig = SUBJECT.exec(m.subject)?.[1];
  if (!rig || !RIG_ID.test(rig)) throw new Error(`not a file's subject: ${m.subject}`);
  const sha256 = m.header(KB_FILE_HEADERS.sha256) ?? "";
  if (!SHA256.test(sha256)) throw new Error("a chunk names no file's SHA-256");
  const chunk = count(m.header(KB_FILE_HEADERS.chunk));
  const chunks = count(m.header(KB_FILE_HEADERS.chunks));
  const bytes = count(m.header(KB_FILE_HEADERS.bytes));
  if (chunk < 0 || chunks < 1 || bytes < 0 || chunk >= chunks || chunks !== kbFileChunks(bytes))
    throw new Error(
      `a chunk's headers do not fit: chunk ${chunk} of ${chunks}, in a file of ${bytes} bytes`,
    );
  return { rig, sha256, chunk, chunks, bytes };
}

/** How long the bus remembers a chunk's id, in nanoseconds: two minutes. */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1e9;

/**
 * The stream's settings: an inbox, a work queue, so a chunk is gone once control has taken it.
 * Control keeps the file in its state. Each rig's subject holds at most
 * KB_FILE_CHUNKS_WAITING_PER_RIG chunks, each at most KB_FILE_MAX_MESSAGE_BYTES: a full one
 * refuses that rig's next chunk, and never drops one control has yet to take. No limit on their
 * age.
 */
export const KB_FILES_STREAM_CONFIG = {
  name: KB_FILES_STREAM,
  subjects: [KB_FILES_SUBJECTS],
  description: "The knowledge base's files, in chunks, until control has taken them",
  retention: "workqueue",
  storage: "file",
  max_msgs: -1,
  max_bytes: -1,
  max_age: 0,
  max_msgs_per_subject: KB_FILE_CHUNKS_WAITING_PER_RIG,
  max_msg_size: KB_FILE_MAX_MESSAGE_BYTES,
  discard: "new",
  discard_new_per_subject: true,
  duplicate_window: DUPLICATE_WINDOW_NS,
  num_replicas: 1,
} satisfies Partial<StreamConfig> & { name: string };

/** How long control may take over one chunk before the stream hands it again, in nanoseconds. */
const ACK_WAIT_NS = 30 * 1e9;

/**
 * Control's consumer: every chunk from the stream's start, one at a time and in order, so that a
 * file's chunks come in the order its supervisor put them, each acked once control has written it.
 */
export const KB_FILES_CONSUMER_CONFIG = {
  durable_name: KB_FILES_CONSUMER,
  ack_policy: "explicit",
  deliver_policy: "all",
  max_ack_pending: 1,
  ack_wait: ACK_WAIT_NS,
  max_deliver: -1,
} satisfies Partial<ConsumerConfig> & { durable_name: string };

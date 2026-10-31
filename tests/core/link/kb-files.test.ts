import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EVENT_SUBJECTS } from "../../../src/core/link/events.ts";
import {
  KB_FILE_CHUNK_BYTES,
  KB_FILE_CHUNKS_WAITING_PER_RIG,
  KB_FILE_HEADERS,
  KB_FILE_MAX_MESSAGE_BYTES,
  KB_FILES_STREAM_CONFIG,
  KB_FILES_SUBJECTS,
  kbFileChunks,
  kbFileSubject,
  readKbFileChunk,
} from "../../../src/core/link/kb-files.ts";
import { REPORT_SUBJECTS } from "../../../src/core/link/report.ts";

/** The `KB_FILES` stream's contract (goal 175): its subjects, chunks and a chunk's headers. */

const SHA = "0123456789abcdef".repeat(4);
const chunk = (subject: string, h: Record<string, string>) => ({
  subject,
  header: (name: string) => h[name],
});
const headers = (i: number, n: number, bytes: number) => ({
  [KB_FILE_HEADERS.sha256]: SHA,
  [KB_FILE_HEADERS.chunk]: String(i),
  [KB_FILE_HEADERS.chunks]: String(n),
  [KB_FILE_HEADERS.bytes]: String(bytes),
});

describe("the knowledge base's files on the bus", () => {
  test("a rig's files go on one subject of its own, and no other stream takes it", () => {
    assert.equal(kbFileSubject("rig-a"), "thermite.rig.rig-a.kbfile");
    assert.throws(() => kbFileSubject("rig.a"), /not a rig's name/);
    assert.deepEqual(KB_FILES_STREAM_CONFIG.subjects, [KB_FILES_SUBJECTS]);
    for (const other of [REPORT_SUBJECTS, ...EVENT_SUBJECTS])
      assert.notEqual(other.split(".")[3], "kbfile", other);
    assert.equal(
      KB_FILES_STREAM_CONFIG.retention,
      "workqueue",
      "an inbox: gone once control took it",
    );
  });

  test("one rig's chunks waiting are limited, by count and by size; a full subject refuses the next", () => {
    assert.equal(KB_FILE_CHUNKS_WAITING_PER_RIG, 256);
    assert.equal(KB_FILES_STREAM_CONFIG.max_msgs_per_subject, KB_FILE_CHUNKS_WAITING_PER_RIG);
    assert.equal(KB_FILES_STREAM_CONFIG.max_msg_size, KB_FILE_MAX_MESSAGE_BYTES);
    assert.equal(KB_FILE_MAX_MESSAGE_BYTES, KB_FILE_CHUNK_BYTES + 4096);
    assert.equal(KB_FILES_STREAM_CONFIG.discard, "new");
    assert.equal(KB_FILES_STREAM_CONFIG.discard_new_per_subject, true, "never drops a chunk");
  });

  test("chunks: a megabyte each, the last the rest, an empty file one empty chunk", () => {
    assert.equal(KB_FILE_CHUNK_BYTES, 1024 * 1024);
    assert.equal(kbFileChunks(0), 1);
    assert.equal(kbFileChunks(1), 1);
    assert.equal(kbFileChunks(KB_FILE_CHUNK_BYTES), 1);
    assert.equal(kbFileChunks(KB_FILE_CHUNK_BYTES + 1), 2);
  });

  test("a chunk is read from its subject and headers, which must agree with the file's size", () => {
    const subject = kbFileSubject("rig-a");
    assert.deepEqual(readKbFileChunk(chunk(subject, headers(1, 2, KB_FILE_CHUNK_BYTES + 5))), {
      rig: "rig-a",
      sha256: SHA,
      chunk: 1,
      chunks: 2,
      bytes: KB_FILE_CHUNK_BYTES + 5,
    });
    assert.throws(
      () => readKbFileChunk(chunk("thermite.rig.rig-a.report", headers(0, 1, 3))),
      /not a file's subject/,
    );
    assert.throws(
      () => readKbFileChunk(chunk(subject, headers(2, 2, 10))),
      /do not fit: chunk 2 of 2/,
    );
    assert.throws(() => readKbFileChunk(chunk(subject, headers(0, 3, 10))), /do not fit/);
    assert.throws(
      () =>
        readKbFileChunk(chunk(subject, { ...headers(0, 1, 3), [KB_FILE_HEADERS.sha256]: "../x" })),
      /names no file's SHA-256/,
    );
    assert.throws(() => readKbFileChunk(chunk(subject, {})), /names no file's SHA-256/);
    assert.throws(
      () => readKbFileChunk(chunk(`${subject}.${SHA}`, headers(0, 1, 3))),
      /not a file's subject/,
    );
  });
});

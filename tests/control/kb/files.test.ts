import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { followKbFiles, KbFiles } from "../../../src/control/kb/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import {
  KB_FILE_CHUNK_BYTES,
  KB_FILE_HEADERS,
  KB_FILES_STREAM_CONFIG,
  kbChunkId,
  kbFileChunks,
  kbFileSubject,
} from "../../../src/core/link/kb-files.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * Control's files of the knowledge base (goal 175, step 2): taken from the `KB_FILES` stream a
 * chunk at a time, put together, checked by their SHA-256 and kept once in control's state.
 */

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function setup() {
  const store = new ControlStore(":memory:");
  const bus = new FakeBus();
  await bus.makeStream(KB_FILES_STREAM_CONFIG);
  const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-kb-files-")), store);
  /** Chunk `i` of a file as a supervisor puts it; `as` names it otherwise. */
  const put = (rig: string, bytes: Buffer, i: number, as = sha(bytes)) => {
    const at = i * KB_FILE_CHUNK_BYTES;
    return bus.publish(
      kbFileSubject(rig, as),
      bytes.subarray(at, Math.min(at + KB_FILE_CHUNK_BYTES, bytes.length)),
      {
        id: `${kbChunkId(rig, as, i)}:${Math.random()}`,
        headers: {
          [KB_FILE_HEADERS.chunk]: String(i),
          [KB_FILE_HEADERS.chunks]: String(kbFileChunks(bytes.length)),
          [KB_FILE_HEADERS.bytes]: String(bytes.length),
        },
      },
    );
  };
  const putAll = async (rig: string, bytes: Buffer) => {
    for (let i = 0; i < kbFileChunks(bytes.length); i++) await put(rig, bytes, i);
  };
  const take = () => followKbFiles(bus, files);
  const refused = () =>
    store.auditLog.list(100).filter((a) => a.action === "kb_file_refused").length;
  return { store, bus, files, put, putAll, take, refused };
}

describe("control's files of the knowledge base", () => {
  test("a file of three chunks is put together, checked and kept once, and the stream emptied", async () => {
    const s = await setup();
    const bytes = randomBytes(2 * KB_FILE_CHUNK_BYTES + 77);
    await s.putAll("rig-a", bytes);
    await s.take();
    assert.deepEqual(readFileSync(s.files.path(sha(bytes))), bytes);
    assert.equal(s.store.kb().hasFile(sha(bytes)), true);
    assert.equal(s.bus.kept.length, 0, "every chunk taken");
    assert.deepEqual(readdirSync(join(s.files.dir, ".partial")), []);
  });

  test("the same file from two rigs, or put again, is kept once by its SHA-256", async () => {
    const s = await setup();
    const bytes = Buffer.from("# Notes on vector loads\n");
    await s.putAll("rig-a", bytes);
    await s.putAll("rig-b", bytes);
    await s.putAll("rig-a", bytes);
    await s.take();
    assert.equal(s.files.kept, 1);
    const rows = s.store.db.prepare("select sha256, bytes from kb_file").all();
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [{ sha256: sha(bytes), bytes: bytes.length }],
    );
    assert.deepEqual(readdirSync(join(s.files.dir, sha(bytes).slice(0, 2))), [sha(bytes)]);
    // An empty file is one empty chunk.
    const empty = Buffer.alloc(0);
    await s.putAll("rig-a", empty);
    await s.take();
    assert.equal(s.store.kb().hasFile(sha(empty)), true);
  });

  test("a chunk again is passed over; a gap drops the file until it is put again whole", async () => {
    const s = await setup();
    const bytes = randomBytes(KB_FILE_CHUNK_BYTES + 10);
    await s.put("rig-a", bytes, 0);
    await s.put("rig-a", bytes, 0);
    await s.take();
    assert.equal(s.store.kb().hasFile(sha(bytes)), false, "half a file is not kept");
    // A chunk handed again (its ack lost) changes nothing; then the last one completes it.
    await s.put("rig-a", bytes, 1);
    await s.take();
    assert.equal(s.store.kb().hasFile(sha(bytes)), true);
    // A file whose first chunk never came: refused, and nothing kept.
    const other = randomBytes(KB_FILE_CHUNK_BYTES + 3);
    await s.put("rig-a", other, 1);
    await s.take();
    assert.equal(s.store.kb().hasFile(sha(other)), false);
    assert.equal(s.refused(), 1);
    await s.putAll("rig-a", other);
    await s.take();
    assert.equal(s.store.kb().hasFile(sha(other)), true);
  });

  test("bytes that are not their name are refused, said in the audit log, and kept nowhere", async () => {
    const s = await setup();
    const bytes = Buffer.from("not what the name says");
    const name = "f".repeat(64);
    await s.put("rig-a", bytes, 0, name);
    await s.take();
    assert.equal(s.store.kb().hasFile(name), false);
    assert.ok(!existsSync(s.files.path(name)));
    assert.equal(s.refused(), 1);
    const said = s.store.auditLog.list(10).find((a) => a.action === "kb_file_refused");
    assert.match(JSON.stringify(said), /have the SHA-256 [0-9a-f]{64}, not its name/);
  });

  test("a control stopped after it named a file and before it recorded it records it from the next chunk", async () => {
    const s = await setup();
    const bytes = Buffer.from("kept, then control stopped");
    await s.putAll("rig-a", bytes);
    await s.take();
    s.store.db.prepare("delete from kb_file").run();
    await s.putAll("rig-a", bytes);
    await s.take();
    assert.equal(s.store.kb().hasFile(sha(bytes)), true);
    assert.equal(s.files.kept, 1, "not written again");
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KB_OUTBOX_FILES } from "../../../src/core/kb.ts";
import { KB_FILE_HEADERS, KB_FILES_STREAM_CONFIG } from "../../../src/core/link/kb-files.ts";
import { KB_FILES_PER_ROUND, KB_FILES_PUT, putKbFiles } from "../../../src/supervisor/kb/index.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * The supervisor's puts of the knowledge base's files (goal 175, step 2): each file of the outbox
 * once, in chunks on the rig's own subject; never one whose bytes are not its name; a round's
 * limit, the rest waiting for the next.
 */

async function setup() {
  const outbox = mkdtempSync(join(tmpdir(), "thermite-outbox-"));
  const home = mkdtempSync(join(tmpdir(), "thermite-supervisor-"));
  mkdirSync(join(outbox, KB_OUTBOX_FILES));
  const bus = new FakeBus();
  await bus.makeStream(KB_FILES_STREAM_CONFIG);
  const keep = (text: string, name?: string) => {
    const sha = createHash("sha256").update(text).digest("hex");
    writeFileSync(join(outbox, KB_OUTBOX_FILES, name ?? sha), text);
    return sha;
  };
  const put = () => putKbFiles({ rig: "rig-a", outboxDir: outbox, home, bus });
  return { outbox, home, bus, keep, put };
}

describe("the supervisor puts the knowledge base's files on the bus", () => {
  test("each file once, on the rig's subject, with its place and size; noted in its state", async () => {
    const s = await setup();
    const sha = s.keep("# notes\n");
    const first = await s.put();
    assert.deepEqual(first, { put: 1, waiting: 0, spoilt: [] });
    assert.deepEqual(
      s.bus.kept.map((m) => [
        m.subject,
        m.headers[KB_FILE_HEADERS.chunk],
        m.headers[KB_FILE_HEADERS.bytes],
      ]),
      [[`thermite.rig.rig-a.kbfile.${sha}`, "0", "8"]],
    );
    assert.ok(existsSync(join(s.home, KB_FILES_PUT, sha)));
    assert.deepEqual(await s.put(), { put: 0, waiting: 0, spoilt: [] });
    assert.equal(s.bus.kept.length, 1);
  });

  test("a file whose bytes are not its name is never put, and blocks no other", async () => {
    const s = await setup();
    const name = "e".repeat(64);
    s.keep("spoilt", name);
    const good = s.keep("good");
    const r = await s.put();
    assert.deepEqual(r.spoilt, [name]);
    assert.equal(r.put, 1);
    assert.deepEqual(
      s.bus.kept.map((m) => m.subject),
      [`thermite.rig.rig-a.kbfile.${good}`],
    );
    // Names that are not a SHA-256, and the exports beside them, are not files to put.
    writeFileSync(join(s.outbox, KB_OUTBOX_FILES, "notes.md.tmp-1234"), "half");
    assert.deepEqual((await s.put()).spoilt, [name]);
  });

  test("a round puts its limit; the rest wait for the next round", async () => {
    const s = await setup();
    for (let i = 0; i < KB_FILES_PER_ROUND + 3; i++) s.keep(`file ${i}`);
    const first = await s.put();
    assert.deepEqual([first.put, first.waiting], [KB_FILES_PER_ROUND, 3]);
    const second = await s.put();
    assert.deepEqual([second.put, second.waiting], [3, 0]);
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KB_FILES_HELD } from "../../../src/core/api/harness/supervisor.ts";
import { KB_FILES_HELD_MAX, KB_OUTBOX_FILES } from "../../../src/core/kb.ts";
import { KB_FILE_HEADERS, KB_FILES_STREAM_CONFIG } from "../../../src/core/link/kb-files.ts";
import {
  KB_FILES_PER_ROUND,
  KB_FILES_PUT,
  putKbFiles,
  removeHeldKbFiles,
} from "../../../src/supervisor/kb/index.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * The supervisor's puts of the knowledge base's files (goal 175, step 2): each file of the outbox
 * once, in chunks on the rig's own subject; never one whose bytes are not its name; a round's
 * limit, the rest waiting for the next. And their end in the outbox: a file goes only once control
 * says it holds it, through the harness, which owns the outbox.
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
  test("each file once, on the rig's subject, with its SHA-256, place and size; noted in its state", async () => {
    const s = await setup();
    const sha = s.keep("# notes\n");
    const first = await s.put();
    assert.deepEqual(first, { put: 1, waiting: 0, spoilt: [] });
    assert.deepEqual(
      s.bus.kept.map((m) => [
        m.subject,
        m.headers[KB_FILE_HEADERS.sha256],
        m.headers[KB_FILE_HEADERS.chunk],
        m.headers[KB_FILE_HEADERS.bytes],
      ]),
      [["thermite.rig.rig-a.kbfile", sha, "0", "8"]],
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
      s.bus.kept.map((m) => m.headers[KB_FILE_HEADERS.sha256]),
      [good],
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

describe("the knowledge base's files leave the outbox once control holds them", () => {
  /**
   * The round's two sides: control on the bus, which answers `held` for the files it is told it
   * holds, and the harness, which removes what it is named (as forgetHeldKbFiles does).
   */
  function sides(s: Awaited<ReturnType<typeof setup>>, controlHolds: (f: string) => boolean) {
    const asked: string[][] = [];
    const named: string[][] = [];
    let away = false;
    const control = {
      rig: "rig-a",
      bus: {
        request: async (subject: string, data: string | Uint8Array) => {
          assert.equal(subject, "thermite.rig.rig-a.ask.kb-files");
          if (away) throw new Error("no responders");
          const { files } = JSON.parse(String(data)) as { files: string[] };
          asked.push(files);
          // Control names one it was not asked about too, where its answer has room: the round
          // removes only what it asked about.
          const held = files.filter(controlHolds);
          if (held.length < KB_FILES_HELD_MAX) held.push("f".repeat(64));
          return new TextEncoder().encode(JSON.stringify({ held }));
        },
      },
    };
    const harness = {
      call: (async (route: unknown, o: { body: { files: string[] } }) => {
        assert.equal(route, KB_FILES_HELD);
        named.push(o.body.files);
        for (const f of o.body.files) rmSync(join(s.outbox, KB_OUTBOX_FILES, f), { force: true });
        return { removed: o.body.files.length };
      }) as never,
    };
    const round = () => removeHeldKbFiles({ outboxDir: s.outbox, home: s.home, control, harness });
    return { asked, named, round, goAway: (v: boolean) => (away = v) };
  }

  test("only files it put are asked about; only those control holds are removed, through the harness", async () => {
    const s = await setup();
    const held = s.keep("held by control");
    const notYet = s.keep("not held yet");
    await s.put();
    // Written after the round's put: not put yet, so not asked about.
    const later = s.keep("written later");
    const r = sides(s, (f) => f === held);
    const out = await r.round();
    assert.deepEqual(out, { asked: 2, held: 1, removed: 1 });
    assert.deepEqual(
      r.asked.map((a) => [...a].sort()),
      [[held, notYet].sort()],
    );
    assert.deepEqual(r.named, [[held]]);
    assert.deepEqual(readdirSync(join(s.outbox, KB_OUTBOX_FILES)).sort(), [later, notYet].sort());
    // The put stays noted: written again, the file is not put again, and goes at the next round.
    assert.ok(existsSync(join(s.home, KB_FILES_PUT, held)));
    s.keep("held by control");
    assert.equal((await s.put()).put, 1, "only the later file is put");
    assert.equal((await r.round()).removed, 1);
    assert.ok(!existsSync(join(s.outbox, KB_OUTBOX_FILES, held)));
  });

  test("control away or holding none: nothing is removed, and the next round asks again", async () => {
    const s = await setup();
    const sha = s.keep("a file");
    await s.put();
    const r = sides(s, () => false);
    r.goAway(true);
    const away = await r.round();
    assert.match(String(away.error), /control was not asked which files it holds: no responders/);
    assert.equal(away.removed, 0);
    r.goAway(false);
    assert.deepEqual(await r.round(), { asked: 1, held: 0, removed: 0 });
    assert.deepEqual(r.named, []);
    assert.deepEqual(readdirSync(join(s.outbox, KB_OUTBOX_FILES)), [sha]);
    // Nothing to ask about: no ask at all.
    const empty = await setup();
    const none = sides(empty, () => true);
    assert.deepEqual(await none.round(), { asked: 0, held: 0, removed: 0 });
    assert.deepEqual(none.asked, []);
  });

  test("a round asks about at most its limit, oldest first", async () => {
    const s = await setup();
    for (let i = 0; i < KB_FILES_HELD_MAX + 2; i++) {
      s.keep(`file ${i}`);
      mkdirSync(join(s.home, KB_FILES_PUT), { recursive: true });
    }
    for (const n of readdirSync(join(s.outbox, KB_OUTBOX_FILES)))
      writeFileSync(join(s.home, KB_FILES_PUT, n), "");
    const r = sides(s, () => true);
    assert.equal((await r.round()).asked, KB_FILES_HELD_MAX);
    assert.equal((await r.round()).asked, 2);
    assert.deepEqual(readdirSync(join(s.outbox, KB_OUTBOX_FILES)), []);
  });
});

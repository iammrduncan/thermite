import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  KbFiles,
  kbSettingsOf,
  setKbSettings,
  writeOwnerNote,
} from "../../../src/control/kb/index.ts";
import { openControlStore } from "../../../src/control/store/index.ts";
import { controlStore } from "../../helpers/control-store.ts";
import { FINDING, fillReader } from "../../helpers/kb-reader.ts";
import {
  DROPPED,
  HELD,
  seen,
  WRITE_FAILED,
  watched,
  withAnotherCaller,
  withTurns,
  withWriteFailing,
} from "../../helpers/together.ts";

/**
 * The transactions of control's knowledge base outside the store (control/kb/): the owner's note
 * and its number, the settings and their audit entry, and each orphan file's removal and its
 * audit entry.
 */

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("the knowledge base's transactions on control", () => {
  test("writeOwnerNote: the note's number is read and the note written as one piece", async () => {
    await withTurns(async () => {
      const store = controlStore();
      await fillReader(store);
      const kb = store.kb();
      const note = (text: string) => writeOwnerNote(store, { address: FINDING, text }, "owner:ui");
      // While the first note's transaction is open, with the slot's next number read, the owner
      // writes another note on the same item: it waits, and takes the number after.
      let second: Awaited<ReturnType<typeof note>> | undefined;
      const held = await withAnotherCaller(
        store,
        kb,
        "nextItem",
        () => note("The first note."),
        async () => {
          second = await note("The second note.");
        },
      );
      assert.deepEqual(held.order, HELD);
      assert.deepEqual(
        [held.out, second].map((o) => (o?.ok ? o.address : o?.error)),
        ["gemv/gs-1/owner/note:1", "gemv/gs-1/owner/note:2"],
      );
      assert.equal((await kb.at("gemv/gs-1/owner/note:1"))?.body, "The first note.");
      assert.equal((await kb.at("gemv/gs-1/owner/note:2"))?.body, "The second note.");
      assert.equal((await store.auditLog.list(10, { action: "kb_note" })).length, 2);
    });
  });

  test("setKbSettings: both settings and their audit entry", async () => {
    const store = openControlStore(":memory:");
    const set = () => setKbSettings(store, { max_file_mib: 64, orphan_hours: 24 }, 48, "owner:api");
    const before = await kbSettingsOf(store, 48);
    assert.deepEqual([before.max_file_mib, before.orphan_hours], [0, 48]);
    const dropped = await withWriteFailing(store, store.auditLog, "add", set);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await kbSettingsOf(store, 48), before, "neither setting was kept");
    assert.deepEqual(await store.auditLog.list(10, { action: "kb_settings_set" }), []);

    // The second setting's write fails: the first one goes with it.
    const half = await withWriteFailing(
      store,
      store.kb().settings,
      "set",
      set,
      (key) => key === "orphan_hours",
    );
    assert.equal(half.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(half), DROPPED);
    assert.deepEqual(await kbSettingsOf(store, 48), before);

    const kept = await watched(store, set);
    assert.equal(kept.threw, undefined);
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "kb_setting"] }]);
    const now = await kbSettingsOf(store, 48);
    assert.deepEqual([now.max_file_mib, now.orphan_hours], [64, 24]);
    assert.deepEqual(
      (await store.auditLog.list(10, { action: "kb_settings_set" })).map((e) => e.body),
      [{ max_file_mib: 64, orphan_hours: 24 }],
    );
    await store.close();
  });

  test("KbFiles.removeOrphans: each orphan gone from the store and its audit entry", async () => {
    const store = openControlStore(":memory:");
    const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-together-kb-")), store);
    const kb = store.kb();
    const orphans = [randomBytes(100), randomBytes(100)];
    const day = "2026-10-28T00:00:00.000Z";
    for (const f of orphans) {
      await kb.files.kept(sha(f), 100, day);
      mkdirSync(dirname(files.path(sha(f))), { recursive: true });
      writeFileSync(files.path(sha(f)), f);
    }
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    const held = async () => {
      const out: boolean[] = [];
      for (const f of orphans) out.push(await kb.files.has(sha(f)));
      return out;
    };
    const removedEntries = async () =>
      (await store.auditLog.list(10, { action: "kb_file_removed" })).length;

    // The second orphan's audit entry fails: the first orphan's row and entry go with it.
    let adds = 0;
    const dropped = await withWriteFailing(
      store,
      store.auditLog,
      "add",
      () => files.removeOrphans(24, now),
      () => ++adds === 2,
    );
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(seen(dropped), DROPPED);
    assert.deepEqual(await held(), [true, true], "the store still names both files");
    assert.equal(await removedEntries(), 0);
    // The files' bytes are on control's disk, outside the store, and went before the failure:
    // the next look finds both rows again and removes them.
    assert.deepEqual(
      orphans.map((f) => existsSync(files.path(sha(f)))),
      [false, false],
    );

    const kept = await watched(store, () => files.removeOrphans(24, now));
    assert.equal(kept.out, 2);
    assert.deepEqual(seen(kept), [{ failed: false, changed: ["audit", "kb_file"] }]);
    assert.deepEqual(await held(), [false, false]);
    assert.equal(await removedEntries(), 2);
    await store.close();
  });
});

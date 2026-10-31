import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import {
  inspectSnapshotFolder,
  LEDGER_FILE,
  liveHolds,
  restoreSnapshot,
  SEALED,
  type SnapshotArea,
  takeSnapshot,
} from "../../../../src/harness/broker/snapshot/index.ts";
import {
  fixture,
  gid,
  makeLedger,
  manifestOf,
  RIG,
  rowsIn,
  sealedOf,
  stagedBackup,
  typicalState,
  uid,
} from "./setup.ts";

/**
 * Taking a sealed snapshot of the rig's live state (broker/snapshot.ts): what it seals and what it
 * leaves out, a consistent copy of the ledger while it is written, a new manifest swapped in by
 * rename, and incremental takes.
 */

/** Every file under `path` with its contents and mode, as a sorted list. */
function tree(path: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const name of readdirSync(p).sort()) {
      const q = join(p, name);
      const st = lstatSync(q);
      const rel = relative(path, q);
      if (st.isDirectory()) {
        out.push(`${rel}/ ${(st.mode & 0o7777).toString(8)}`);
        walk(q);
      } else out.push(`${rel} ${(st.mode & 0o7777).toString(8)} ${readFileSync(q, "utf8")}`);
    }
  };
  walk(path);
  return out;
}

/** A restore of the snapshot into a fresh folder of its own, as onto a fresh disk. */
let asides = 0;
const restoreAside = (f: ReturnType<typeof fixture>) =>
  f.restore({
    areas: f.areas.map((a) => ({ ...a, live: join(f.root, `aside-${++asides}`, a.name) })),
  });

describe("the rig's sealed state snapshot (broker/snapshot.ts)", () => {
  test("a snapshot seals the live state, and a restore onto an empty disk puts it back with owners and modes", async () => {
    const f = fixture();
    typicalState(f);
    const r = await f.take("at the stop");
    assert.equal(r.ledger, true);
    assert.equal(r.seq, 1);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.reused + r.sealed, r.files);
    // The folder holds the manifest and sealed files named by a keyed hash, nothing else; no
    // byte of what the live state holds shows in any of them.
    const names = readdirSync(f.dir).sort();
    assert.ok(names.includes(SEALED.manifest));
    assert.ok(names.filter((n) => n !== SEALED.manifest).every((n) => /^[0-9a-f]{64}$/.test(n)));
    for (const n of names) {
      const bytes = readFileSync(join(f.dir, n));
      assert.equal(bytes.subarray(0, 8).toString("latin1"), "THMSEAL1", n);
      for (const secret of [
        "rig key",
        "private",
        "the token",
        "weights",
        '{"kit":1}',
        "cursor",
        "SQLite format",
      ])
        assert.ok(!bytes.includes(Buffer.from(secret)), `${secret} shows in ${n}`);
    }
    assert.deepEqual(inspectSnapshotFolder(f.dir), {
      manifest: true,
      files: names.length - 1,
    });
    const manifest = manifestOf(f);
    assert.equal(manifest.rig, RIG);
    assert.equal(manifest.reason, "at the stop");
    const labels = manifest.entries.map((e) => `${e.area}/${e.path}`);
    // What a snapshot never holds: the write-ahead files, an export still being written, the
    // supervisor's temporary folder and its copy of the token, other files beside the token.
    for (const out of [
      "harness/ledger/ledger.db-wal",
      "harness/ledger/ledger.db-shm",
      "outbox/.tmp-20261022-bbbb",
      "supervisor/tmp",
      "supervisor/harness-token",
      "secrets/other",
    ])
      assert.ok(!labels.includes(out), `${out} is not in the snapshot`);
    assert.ok(labels.includes("supervisor/tunnel/keys.json"));
    assert.ok(labels.includes("secrets/supervisor-token"));
    // The manifest binds every file: its sealed name, its SHA-256, its size, owner and mode.
    const keysEntry = manifest.entries.find((e) => e.path === "tunnel/keys.json");
    assert.equal(keysEntry?.size, '{"sign":"private"}'.length);
    assert.match(keysEntry?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(keysEntry?.mode, 0o600);
    assert.equal(keysEntry?.uid, uid);

    // The pod stops: its disk is emptied, the volume stays.
    const before = tree(f.live).filter(
      (l) =>
        !/^(outbox\/\.tmp|supervisor\/tmp|supervisor\/harness-token|secrets\/other|harness\/ledger\/ledger\.db)/.test(
          l,
        ),
    );
    rmSync(f.live, { recursive: true, force: true });
    assert.deepEqual(liveHolds(f.areas), []);
    const owned: string[] = [];
    const restored = restoreSnapshot({
      dir: f.dir,
      areas: f.areas,
      keys: f.keys,
      rig: RIG,
      own: (path, u, g) => {
        assert.equal(u, uid);
        assert.equal(g, gid);
        owned.push(path);
      },
    });
    assert.ok(restored);
    assert.deepEqual(restored.refused, []);
    assert.equal(restored.from, SEALED.manifest);
    assert.equal(restored.seq, 1);
    assert.equal(restored.taken_at, manifest.taken_at);
    assert.equal(restored.areas.supervisor?.files, 4);
    assert.equal(restored.areas.secrets?.files, 1);
    const after = tree(f.live).filter((l) => !/^harness\/ledger\/ledger\.db/.test(l));
    assert.deepEqual(after, before, "every file and folder is back, with its mode");
    assert.deepEqual(rowsIn(join(f.live, "harness", LEDGER_FILE)), { ok: "ok", a: 3, b: 3 });
    // Every owner it set is on the live side: nothing under the snapshot folder.
    assert.ok(owned.length > 10);
    for (const p of owned)
      assert.ok(!relative(f.dir, p).match(/^[^.]/), `${p} is not on the volume`);
    // Nothing in the snapshot folder changed.
    assert.deepEqual(readdirSync(f.dir).sort(), names);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("the ledger's copy is consistent while the ledger is written", async () => {
    const f = fixture();
    const ledger = join(f.live, "harness", LEDGER_FILE);
    makeLedger(ledger, 0);
    // Another process writes the ledger all the time: one row in each table per transaction.
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("pragma busy_timeout=5000");const end=Date.now()+2500;let i=0;while(Date.now()<end){db.exec("begin");db.prepare("insert into a values (?)").run(i);db.prepare("insert into b values (?)").run(i);db.exec("commit");i++}db.close()`,
        ledger,
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise((r) => writer.on("exit", r));
    await new Promise((r) => setTimeout(r, 300));
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await takeSnapshot({
        dir: f.dir,
        areas: f.areas.slice(0, 1),
        reason: `while written ${i}`,
        keys: f.keys,
        rig: RIG,
        backupLedger: stagedBackup(f.root),
      });
      assert.equal(r.ledger, true);
      // Restored elsewhere, as onto a fresh disk.
      const back: SnapshotArea = { name: "harness", live: join(f.root, `back-${i}`), uid, gid };
      f.restore({ areas: [back] });
      const copy = rowsIn(join(back.live, LEDGER_FILE));
      assert.equal(copy.ok, "ok");
      assert.equal(copy.a, copy.b, "no transaction is half in the copy");
      seen.push(copy.a);
      await new Promise((r) => setTimeout(r, 200));
    }
    await exited;
    assert.ok(seen[0] !== undefined && seen[0] > 0, "the copy holds what was written");
    assert.ok((seen.at(-1) ?? 0) > (seen[0] ?? 0), `later copies hold more: ${seen.join(", ")}`);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a new manifest is swapped in by rename; the snapshot before stays until it is complete", async () => {
    const f = fixture();
    typicalState(f);
    await f.take("first");
    const first = readFileSync(join(f.dir, SEALED.manifest));
    const firstNames = readdirSync(f.dir).sort();
    // A take that fails (here, the ledger's copy) leaves the snapshot before it as it was.
    f.put("harness/kits/abc/kit.json", '{"kit":2}');
    await assert.rejects(
      f.take("fails", {
        backup: async () => {
          throw new Error("no ledger copy");
        },
      }),
      /no ledger copy/,
    );
    assert.deepEqual(readdirSync(f.dir).sort(), firstNames);
    assert.deepEqual(readFileSync(join(f.dir, SEALED.manifest)), first);
    // A take stopped half way (the pod killed): a manifest.new cut short and a file half sealed.
    writeFileSync(join(f.dir, SEALED.next), first.subarray(0, 40));
    writeFileSync(join(f.dir, `.new-${"0".repeat(32)}`), first.subarray(0, 20));
    assert.equal(
      restoreAside(f)?.reason,
      "first",
      "a manifest.new that does not verify never counts",
    );
    const second = await f.take("second");
    assert.equal(second.seq, 2);
    assert.ok(!readdirSync(f.dir).includes(SEALED.next));
    assert.ok(!readdirSync(f.dir).some((n) => n.startsWith(".new-")), "what it left is gone");
    assert.equal(manifestOf(f).reason, "second");
    // Stopped between writing manifest.new and its rename: complete, and it counts.
    await f.take("third");
    renameSync(join(f.dir, SEALED.manifest), join(f.dir, SEALED.next));
    const r = restoreAside(f);
    assert.equal(r?.from, SEALED.next);
    assert.equal(r?.reason, "third");
    // The next take puts it in place first, and counts on from it.
    const fourth = await f.take("fourth");
    assert.equal(fourth.seq, 4);
    assert.deepEqual(
      readdirSync(f.dir).filter((n) => !/^[0-9a-f]{64}$/.test(n)),
      [SEALED.manifest],
    );
    rmSync(f.root, { recursive: true, force: true });
  });

  test("incremental: an unchanged file is not read again, the same content is sealed once, and what no manifest names goes", async () => {
    const f = fixture();
    typicalState(f);
    f.put("harness/a-copy.json", '{"kit":1}');
    const first = await f.take("first");
    // The same content in two files: one sealed file.
    const m1 = manifestOf(f);
    const kit = m1.entries.find((e) => e.path === "kits/abc/kit.json");
    const copy = m1.entries.find((e) => e.path === "a-copy.json");
    assert.ok(kit?.sealed && kit.sealed === copy?.sealed);
    // a-copy.json is kit.json's content; rig-settings.json and the export's manifest are both {}.
    assert.equal(first.reused, 2);
    // A file no one may read now, unchanged: the next take does not open it.
    chmodSync(join(f.live, "inbox", "models", "m.bin"), 0);
    f.put("harness/kits/abc/kit.json", '{"kit":2}');
    const second = await f.take("second");
    chmodSync(join(f.live, "inbox", "models", "m.bin"), 0o640);
    assert.deepEqual(second.skipped, []);
    assert.ok(
      second.sealed <= 2,
      `sealed ${second.sealed}: the changed kit, and the ledger's copy`,
    );
    assert.ok(second.reused >= second.files - 2, `reused ${second.reused} of ${second.files}`);
    // The old kit's sealed file is still named (a-copy.json); one named by none goes.
    const m2 = manifestOf(f);
    const named = new Set(m2.entries.flatMap((e) => (e.sealed ? [e.sealed] : [])));
    assert.deepEqual(
      readdirSync(f.dir)
        .filter((n) => n !== SEALED.manifest)
        .sort(),
      [...named].sort(),
      "the folder holds exactly the sealed files the manifest names",
    );
    rmSync(join(f.live, "harness", "a-copy.json"));
    const third = await f.take("third");
    assert.ok(third.removed >= 1, "the first kit's sealed file is named by none now");
    assert.ok(!existsSync(join(f.dir, kit.sealed)));
    // A sealed file someone removed is sealed again, though its file did not change.
    const keysFile = sealedOf(f, "supervisor/tunnel/keys.json");
    rmSync(keysFile);
    const fourth = await f.take("fourth");
    assert.ok(fourth.sealed >= 1);
    assert.ok(existsSync(keysFile));
    rmSync(f.live, { recursive: true, force: true });
    assert.deepEqual(f.restore()?.refused, []);
    assert.equal(
      readFileSync(join(f.live, "harness", "kits", "abc", "kit.json"), "utf8"),
      '{"kit":2}',
    );
    rmSync(f.root, { recursive: true, force: true });
  });
});

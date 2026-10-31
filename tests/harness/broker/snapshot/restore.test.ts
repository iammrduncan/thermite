import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SnapshotRefused, seal } from "../../../../src/harness/broker/seal.ts";
import {
  inSnapshotFolder,
  inspectSnapshotFolder,
  liveHolds,
  removeUnsealed,
  SEALED,
  type SnapshotManifest,
  takeSnapshot,
} from "../../../../src/harness/broker/snapshot/index.ts";
import { fixture, manifestOf, RIG, sealedOf, stagedBackup, typicalState, uid } from "./setup.ts";

/**
 * Restoring the rig's sealed snapshot (broker/snapshot.ts): a tampered, missing or foreign
 * snapshot is refused whole, a link, pipe or other user's file is never taken, a restore is all or
 * nothing, and an unsealed snapshot is never restored.
 */

/** Writes `m` as the snapshot's manifest, sealed with `keys` (a manifest under the right key). */
const writeManifest = (f: ReturnType<typeof fixture>, m: SnapshotManifest) =>
  writeFileSync(
    join(f.dir, SEALED.manifest),
    seal(f.keys.manifest, "manifest", Buffer.from(JSON.stringify(m))),
  );

/** A restore that must be refused whole: nothing restored, no staging folder left. */
function refusedWhole(f: ReturnType<typeof fixture>, why: RegExp, o = {}): void {
  rmSync(f.live, { recursive: true, force: true });
  assert.throws(
    () => f.restore(o),
    (err: Error) => err instanceof SnapshotRefused && why.test(err.message),
  );
  assert.deepEqual(
    existsSync(f.live) ? readdirSync(f.live) : [],
    [],
    "nothing is restored, and no staging folder is left",
  );
}

describe("the rig's sealed state snapshot (broker/snapshot.ts)", () => {
  test("a changed sealed file, manifest or name, a missing file and another pod's snapshot are each refused whole", async () => {
    const f = fixture();
    typicalState(f);
    f.put("harness/a.txt", "aaaa");
    f.put("harness/b.txt", "bbbb");
    await f.take("kept");
    const saved = join(f.root, "saved");
    const save = () => {
      rmSync(saved, { recursive: true, force: true });
      mkdirSync(saved);
      for (const n of readdirSync(f.dir))
        writeFileSync(join(saved, n), readFileSync(join(f.dir, n)));
    };
    const back = () => {
      rmSync(f.dir, { recursive: true, force: true });
      mkdirSync(f.dir);
      for (const n of readdirSync(saved))
        writeFileSync(join(f.dir, n), readFileSync(join(saved, n)));
    };
    save();
    // One byte of a sealed file.
    const keysFile = sealedOf(f, "supervisor/tunnel/keys.json");
    const bytes = readFileSync(keysFile);
    bytes[30] = (bytes[30] as number) ^ 1;
    writeFileSync(keysFile, bytes);
    refusedWhole(f, /^supervisor\/tunnel\/keys\.json: it did not verify/);
    back();
    // One byte of the manifest.
    const m = readFileSync(join(f.dir, SEALED.manifest));
    m[40] = (m[40] as number) ^ 1;
    writeFileSync(join(f.dir, SEALED.manifest), m);
    refusedWhole(f, /^its manifest: it did not verify/);
    back();
    // Two sealed files of the same size, each under the other's name.
    const a = sealedOf(f, "harness/a.txt");
    const b = sealedOf(f, "harness/b.txt");
    renameSync(a, join(f.root, "swap"));
    renameSync(b, a);
    renameSync(join(f.root, "swap"), b);
    refusedWhole(f, /^harness\/a\.txt: its content is not the one the manifest names/);
    back();
    // A sealed file cut short, and one gone.
    writeFileSync(a, readFileSync(a).subarray(0, 30));
    refusedWhole(f, /^harness\/a\.txt: its sealed file is 30 bytes/);
    back();
    rmSync(b);
    refusedWhole(f, /^harness\/b\.txt: its sealed file is missing/);
    back();
    // A link in a sealed file's place.
    rmSync(b);
    symlinkSync(join(f.live, "harness", "b.txt"), b);
    refusedWhole(f, /^harness\/b\.txt: its sealed file is a link/);
    back();
    // Another pod's snapshot (its own key), swapped in whole: its manifest does not open.
    const other = fixture();
    typicalState(other);
    await other.take("another pod's");
    rmSync(f.dir, { recursive: true, force: true });
    renameSync(other.dir, f.dir);
    refusedWhole(f, /^its manifest: it did not verify/);
    // Only its manifest, beside this pod's files: refused too.
    back();
    mkdirSync(other.dir, { recursive: true });
    await other.take("another pod's, again");
    writeFileSync(join(f.dir, SEALED.manifest), readFileSync(join(other.dir, SEALED.manifest)));
    refusedWhole(f, /^its manifest: it did not verify/);
    back();
    // This pod's key but another rig's snapshot.
    refusedWhole(f, /^it is rig rp-test0001's, not rig rp-other's/, { rig: "rp-other" });
    // With nothing changed, it restores.
    rmSync(f.live, { recursive: true, force: true });
    assert.deepEqual(f.restore()?.refused, []);
    assert.equal(readFileSync(join(f.live, "harness", "a.txt"), "utf8"), "aaaa");
    rmSync(other.root, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a snapshot takes no link, pipe or other user's file; a manifest's names are checked even when it verifies", async () => {
    const f = fixture();
    typicalState(f);
    const secret = join(f.root, "root-only-secret");
    writeFileSync(secret, "root's secret");
    symlinkSync(secret, join(f.live, "supervisor", "keys-link"));
    spawnSync("mkfifo", [join(f.live, "inbox", "pipe")]);
    // A part whose files are another user's (the broker checks owners as root): none is taken.
    const areas = f.areas.map((a) => (a.name === "outbox" ? { ...a, uid: uid + 1 } : a));
    const r = await takeSnapshot({
      dir: f.dir,
      areas,
      reason: "with strangers",
      keys: f.keys,
      rig: RIG,
      backupLedger: stagedBackup(f.root),
    });
    assert.ok(r.skipped.includes("supervisor/keys-link: a link"), r.skipped.join("; "));
    assert.ok(r.skipped.includes("inbox/pipe: not a plain file or folder"), r.skipped.join("; "));
    assert.ok(r.skipped.some((s) => s.startsWith("outbox/: owned by uid")));
    const labels = manifestOf(f).entries.map((e) => `${e.area}/${e.path}`);
    assert.ok(!labels.includes("supervisor/keys-link"));
    assert.ok(!labels.some((l) => l.startsWith("outbox/")));

    // A manifest sealed under this pod's key that names a path climbing out of its part, a name
    // a snapshot never holds, or a file whose folder it lacks: each is refused, the rest restored.
    const m = manifestOf(f);
    const any = m.entries.find((e) => e.type === "file") as SnapshotManifest["entries"][number];
    m.entries.push(
      { ...any, area: "harness", path: "../escaped" },
      { ...any, area: "secrets", path: "other" },
      { ...any, area: "harness", path: "nowhere/file" },
    );
    writeManifest(f, m);
    rmSync(f.live, { recursive: true, force: true });
    const restored = f.restore();
    assert.ok(restored);
    assert.deepEqual(restored.refused.sort(), [
      "harness/../escaped: not a name a snapshot holds",
      "harness/nowhere/file: its folder was not restored",
      "secrets/other: not a name a snapshot holds",
    ]);
    assert.equal(existsSync(join(f.live, "escaped")), false);
    assert.equal(readFileSync(join(f.live, "secrets", "supervisor-token"), "utf8"), "the token");
    // A rig without one of the parts restores the others (an image with another layout).
    rmSync(f.live, { recursive: true, force: true });
    const fewer = f.restore({ areas: f.areas.filter((a) => a.name !== "secrets") });
    assert.ok(fewer?.refused.includes("secrets/: not a part of this rig"));
    assert.equal(existsSync(join(f.live, "secrets")), false);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a restore is all or nothing, and never over live state", async () => {
    const f = fixture();
    typicalState(f);
    await f.take("kept");
    rmSync(f.live, { recursive: true, force: true });
    // The supervisor's part holds something already (a restart that kept the disk, say): nothing
    // is restored over it, and no other part is left half restored.
    mkdirSync(join(f.live, "supervisor"), { recursive: true });
    writeFileSync(join(f.live, "supervisor", "relay-state.json"), "newer");
    assert.deepEqual(liveHolds(f.areas), ["supervisor"]);
    assert.throws(() => f.restore(), /is not empty/);
    assert.deepEqual(readdirSync(f.live), ["supervisor"]);
    assert.equal(readFileSync(join(f.live, "supervisor", "relay-state.json"), "utf8"), "newer");
    // A part that holds only what a snapshot leaves out counts as empty, and is replaced.
    rmSync(join(f.live, "supervisor", "relay-state.json"));
    mkdirSync(join(f.live, "supervisor", "tmp"));
    assert.deepEqual(liveHolds(f.areas), []);
    assert.deepEqual(f.restore()?.refused, []);
    assert.equal(
      readFileSync(join(f.live, "supervisor", "relay-state.json"), "utf8"),
      '{"cursor":7}',
    );
    assert.equal(existsSync(join(f.live, "supervisor", "tmp")), false);
    // No staging folder is left behind.
    assert.deepEqual(
      readdirSync(f.live).filter((n) => n.endsWith(".restoring")),
      [],
    );
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a restored file keeps its time, so the next snapshot does not seal it again", async () => {
    const f = fixture();
    typicalState(f);
    utimesSync(
      join(f.live, "harness", "kits", "abc", "kit.json"),
      1_700_000_000.123,
      1_700_000_000.123,
    );
    await f.take("before the stop");
    rmSync(f.live, { recursive: true, force: true });
    f.restore();
    const again = await f.take("after the start");
    assert.ok(again.sealed <= 1, `sealed ${again.sealed}: at most the ledger's copy`);
    assert.equal(again.seq, 2);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("no snapshot yet; an unsealed one an older image left is never restored", async () => {
    const f = fixture();
    assert.equal(f.restore(), undefined);
    // An image before sealing: snapshot/ with a plaintext SNAPSHOT.json and copies.
    mkdirSync(join(f.dir, "snapshot", "harness"), { recursive: true });
    writeFileSync(join(f.dir, "snapshot", "SNAPSHOT.json"), '{"version":1,"entries":[]}');
    writeFileSync(join(f.dir, "snapshot", "harness", "rig-settings.json"), "{}");
    assert.equal(f.restore(), undefined, "only a sealed manifest counts");
    assert.match(
      inspectSnapshotFolder(f.dir).problem ?? "",
      /^an unsealed snapshot an older image left: snapshot$/,
    );
    // Where other users may write in the folder, it stays (a recursive removal could be sent
    // elsewhere); where none may, it goes.
    assert.deepEqual(removeUnsealed(f.dir, false), { removed: [], left: ["snapshot"] });
    assert.ok(existsSync(join(f.dir, "snapshot")));
    assert.deepEqual(removeUnsealed(f.dir, true), { removed: ["snapshot"], left: [] });
    assert.deepEqual(readdirSync(f.dir), []);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("root works inside the folder: a folder swapped for a link is refused", () => {
    const f = fixture();
    const elsewhere = join(f.root, "elsewhere");
    mkdirSync(elsewhere);
    const link = join(f.root, "volume", "linked");
    symlinkSync(elsewhere, link);
    assert.throws(() => inSnapshotFolder(link, () => "in"), /is not a folder/);
    const cwd = process.cwd();
    assert.equal(
      inSnapshotFolder(f.dir, () => readdirSync(".").length),
      0,
    );
    assert.equal(process.cwd(), cwd, "the working folder comes back");
    rmSync(f.root, { recursive: true, force: true });
  });
});

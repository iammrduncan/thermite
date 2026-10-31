import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import {
  deriveKeys,
  FileOpener,
  FileSealer,
  parseSnapshotKey,
  SEAL_HEADER_BYTES,
  SEAL_OVERHEAD,
  SNAPSHOT_KEY_VAR,
  SnapshotRefused,
  seal,
  takeSnapshotKey,
  unseal,
} from "../../../src/harness/broker/seal.ts";

/**
 * The state snapshot's seal: AES-256-GCM under keys derived from the pod's snapshot key, a fresh
 * nonce for each file, and names that are a keyed hash of the content.
 */

const keyOf = () => randomBytes(32);

/** Seals `plain` as a file, in chunks, and gives the sealed bytes and the digest. */
function sealFile(keys: ReturnType<typeof deriveKeys>, plain: Buffer, chunk = 7) {
  const s = new FileSealer(keys);
  const parts = [s.header];
  for (let i = 0; i < plain.length; i += chunk) parts.push(s.update(plain.subarray(i, i + chunk)));
  const end = s.final();
  parts.push(end.tail);
  return { sealed: Buffer.concat(parts), digest: end.digest };
}

/** Opens sealed file bytes as the restore does: header and tag first, then the ciphertext. */
function openFile(keys: ReturnType<typeof deriveKeys>, sealed: Buffer) {
  const o = new FileOpener(
    keys,
    sealed.subarray(0, SEAL_HEADER_BYTES),
    sealed.subarray(sealed.length - 16),
  );
  const plain = [o.update(sealed.subarray(SEAL_HEADER_BYTES, sealed.length - 16))];
  const end = o.final();
  plain.push(end.tail);
  return { plain: Buffer.concat(plain), digest: end.digest };
}

describe("the snapshot key (seal.ts)", () => {
  test("32 bytes in base64url, or why not", () => {
    const raw = keyOf().toString("base64url");
    const ok = parseSnapshotKey(raw);
    assert.ok("key" in ok && ok.key.length === 32);
    assert.match(
      (parseSnapshotKey(undefined) as { why: string }).why,
      /the launch gave no THERMITE_STATE_SNAPSHOT_KEY/,
    );
    assert.match((parseSnapshotKey("") as { why: string }).why, /gave no/);
    for (const bad of [
      "short",
      randomBytes(31).toString("base64url"),
      `${raw}x`,
      "a+b/".repeat(11),
    ])
      assert.match(
        (parseSnapshotKey(bad) as { why: string }).why,
        /is not 32 bytes in base64url/,
        bad,
      );
  });

  test("the broker takes it out of its environment as it reads it", () => {
    const raw = keyOf().toString("base64url");
    const env: Record<string, string | undefined> = { [SNAPSHOT_KEY_VAR]: raw, PATH: "/bin" };
    const got = takeSnapshotKey(env);
    assert.ok("key" in got && got.key.toString("base64url") === raw);
    assert.deepEqual(Object.keys(env), ["PATH"], "nothing started after this has it");
    // Without one: why, and still nothing in the environment.
    const none = takeSnapshotKey(env);
    assert.ok("why" in none);
  });

  test("one key for each purpose", () => {
    const k = deriveKeys(keyOf());
    const all = [k.file, k.name, k.manifest].map((b) => b.toString("hex"));
    assert.equal(new Set(all).size, 3);
    assert.ok(all.every((h) => h.length === 64));
    // The same snapshot key gives the same keys: a restore after a stop opens what was sealed.
    const key = keyOf();
    assert.deepEqual(deriveKeys(key), deriveKeys(Buffer.from(key)));
  });
});

describe("sealing (seal.ts)", () => {
  test("a manifest: round trip; another key, another kind or any change is refused", () => {
    const keys = deriveKeys(keyOf());
    const plain = Buffer.from(JSON.stringify({ entries: [1, 2, 3] }));
    const sealed = seal(keys.manifest, "manifest", plain);
    assert.equal(sealed.length, plain.length + SEAL_OVERHEAD);
    assert.equal(sealed.subarray(0, 9).toString("latin1"), "THMSEAL1M");
    assert.ok(!sealed.includes(Buffer.from("entries")), "nothing of it shows");
    assert.deepEqual(unseal(keys.manifest, "manifest", sealed), plain);
    // A fresh nonce each time: the same manifest seals differently.
    assert.notDeepEqual(seal(keys.manifest, "manifest", plain), sealed);
    assert.throws(() => unseal(deriveKeys(keyOf()).manifest, "manifest", sealed), SnapshotRefused);
    assert.throws(() => unseal(keys.file, "manifest", sealed), SnapshotRefused);
    assert.throws(() => unseal(keys.manifest, "file", sealed), /not a sealed file/);
    for (const at of [9, 20, 25, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = (bad[at] as number) ^ 1;
      assert.throws(() => unseal(keys.manifest, "manifest", bad), SnapshotRefused, `byte ${at}`);
    }
    assert.throws(() => unseal(keys.manifest, "manifest", sealed.subarray(0, 30)), SnapshotRefused);
  });

  test("a file, in chunks: round trip, its name a keyed hash of its content, its SHA-256", () => {
    const keys = deriveKeys(keyOf());
    const plain = Buffer.from("the pod's tunnel keys: a private key in PEM ...".repeat(50));
    const a = sealFile(keys, plain);
    assert.equal(a.sealed.length, plain.length + SEAL_OVERHEAD);
    assert.equal(a.sealed.subarray(0, 9).toString("latin1"), "THMSEAL1B");
    assert.ok(!a.sealed.includes(Buffer.from("private key")));
    assert.match(a.digest.name, /^[0-9a-f]{64}$/);
    assert.equal(a.digest.size, plain.length);
    const back = openFile(keys, a.sealed);
    assert.deepEqual(back.plain, plain);
    assert.deepEqual(back.digest, a.digest);
    // The same content: the same name (sealed once), but other bytes (a fresh nonce).
    const b = sealFile(keys, plain, 1000);
    assert.equal(b.digest.name, a.digest.name);
    assert.notDeepEqual(b.sealed, a.sealed);
    // Another pod's key names it otherwise, and can't open it.
    const other = deriveKeys(keyOf());
    assert.notEqual(sealFile(other, plain).digest.name, a.digest.name);
    assert.throws(() => openFile(other, a.sealed), SnapshotRefused);
    // Any byte changed, the tag cut, or a manifest offered as a file: refused.
    for (const at of [9, 30, a.sealed.length - 1]) {
      const bad = Buffer.from(a.sealed);
      bad[at] = (bad[at] as number) ^ 1;
      assert.throws(() => openFile(keys, bad), SnapshotRefused, `byte ${at}`);
    }
    assert.throws(
      () => openFile(keys, seal(keys.manifest, "manifest", plain)),
      /not a sealed file/,
    );
    // An empty file seals and opens too.
    const empty = sealFile(keys, Buffer.alloc(0));
    assert.deepEqual(openFile(keys, empty.sealed).plain, Buffer.alloc(0));
  });
});

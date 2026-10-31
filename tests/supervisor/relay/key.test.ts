import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fromSeed } from "@nats-io/nkeys";
import {
  isSealKey,
  openConfig,
  sealConfig,
  sealKeyFingerprint,
} from "../../../src/core/link/config.ts";
import { isUserKey, userKeyFingerprint } from "../../../src/core/link/users.ts";
import {
  BUS_KEY_FILE,
  busKey,
  busKeyFigure,
  SEAL_KEY_FILE,
} from "../../../src/supervisor/relay/key.ts";

const home = () => mkdtempSync(join(tmpdir(), "thermite-sup-key-"));
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("the rig's own key on the message bus", () => {
  test("is made the first time, with its seed in the state folder at mode 0600, and kept", (t) => {
    const dir = home();
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    const first = busKey(dir);
    const again = busKey(dir);
    t.mock.restoreAll();
    const path = join(dir, BUS_KEY_FILE);
    assert.equal(modeOf(path), 0o600);
    assert.equal(isUserKey(first.publicKey), true);
    assert.equal(again.publicKey, first.publicKey, "the same key at the next start");
    const seed = readFileSync(path, "utf8").trim();
    assert.match(seed, /^SU[A-Z2-7]{56}$/);
    assert.equal(fromSeed(new TextEncoder().encode(seed)).getPublicKey(), first.publicKey);
    // The log says it was made once, by its fingerprint: never the seed, nor the key itself.
    const lines = said.join("");
    assert.equal(lines.match(/made the rig's key on the bus/g)?.length, 1);
    assert.ok(lines.includes(userKeyFingerprint(first.publicKey)));
    assert.ok(!lines.includes(seed));
    assert.ok(!lines.includes(first.publicKey));
  });

  test("a seed file left readable by others is made 0600 again", () => {
    const dir = home();
    busKey(dir);
    const path = join(dir, BUS_KEY_FILE);
    chmodSync(path, 0o644);
    busKey(dir);
    assert.equal(modeOf(path), 0o600);
  });

  test("a file that holds no user key's seed stops the supervisor, saying what to do", () => {
    const dir = home();
    const path = join(dir, BUS_KEY_FILE);
    for (const bad of ["", "not a seed", "SUAAAA"]) {
      writeFileSync(path, bad);
      assert.throws(
        () => busKey(dir),
        (err: Error) =>
          err.message ===
          `${path} does not hold a NATS user key's seed: delete it, and the supervisor makes a new key at its next start (control records the change)`,
        bad,
      );
    }
  });

  test("the registration carries the public parts alone", () => {
    const key = busKey(home());
    const figure = busKeyFigure(key);
    assert.deepEqual(figure, { bus_key: key.publicKey, bus_seal_key: key.seal.publicKey });
    const sent = JSON.stringify(figure);
    assert.ok(!sent.includes(new TextDecoder().decode(key.seed)));
    assert.ok(!sent.includes("PRIVATE"));
  });

  test("its seal key is made beside it, at mode 0600, kept, and opens what is sealed to it", (t) => {
    const dir = home();
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    const first = busKey(dir);
    const again = busKey(dir);
    t.mock.restoreAll();
    const path = join(dir, SEAL_KEY_FILE);
    assert.equal(modeOf(path), 0o600);
    assert.equal(isSealKey(first.seal.publicKey), true);
    assert.equal(again.seal.publicKey, first.seal.publicKey, "the same key at the next start");
    const sealed = sealConfig("rig-a", "model-route", { route: null }, first.seal.publicKey);
    assert.deepEqual(openConfig("rig-a", "model-route", sealed, again.seal.privatePem), {
      route: null,
    });
    // The log says it was made once, by its fingerprint: never the key.
    const lines = said.join("");
    assert.equal(lines.match(/made the rig's seal key/g)?.length, 1);
    assert.ok(lines.includes(sealKeyFingerprint(first.seal.publicKey)));
    assert.ok(!lines.includes("PRIVATE") && !lines.includes(first.seal.publicKey));
    chmodSync(path, 0o644);
    busKey(dir);
    assert.equal(modeOf(path), 0o600);
  });

  test("a seal key file that holds no X25519 key stops the supervisor, saying what to do", () => {
    const dir = home();
    busKey(dir);
    const path = join(dir, SEAL_KEY_FILE);
    for (const bad of ["", "not a key", readFileSync(join(dir, BUS_KEY_FILE), "utf8")]) {
      writeFileSync(path, bad);
      assert.throws(
        () => busKey(dir),
        (err: Error) =>
          err.message ===
          `${path} does not hold an X25519 private key: delete it, and the supervisor makes a new seal key at its next start (control records the change)`,
      );
    }
  });
});

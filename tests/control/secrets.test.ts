import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keyHint, moveSecretsKey, SecretBox } from "../../src/control/secrets.ts";

describe("control's secret box", () => {
  test("a sealed key opens only with the box's own key, and a changed value fails", () => {
    const box = SecretBox.ephemeral();
    const sealed = box.seal("sk-test-1234567890");
    assert.ok(!sealed.includes("sk-test"));
    assert.equal(box.open(sealed), "sk-test-1234567890");
    // Each seal is fresh: the same key never seals to the same value.
    assert.notEqual(box.seal("sk-test-1234567890"), sealed);
    assert.throws(() => SecretBox.ephemeral().open(sealed));
    const raw = Buffer.from(sealed.slice(3), "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    assert.throws(() => box.open(`s1:${raw.toString("base64")}`));
  });

  test("the key file is made once, 0600, and kept", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-secrets-")), "control", "secrets.key");
    const sealed = SecretBox.fromFile(path).seal("value");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path, "utf8");
    assert.equal(SecretBox.fromFile(path).open(sealed), "value");
    assert.equal(readFileSync(path, "utf8"), before);
  });

  test("a key in the state folder moves to the file the setting names, and opens what it sealed there", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-secrets-"));
    const from = join(dir, "state", "secrets.key");
    const to = join(dir, "secrets", "secrets.key");
    const sealed = SecretBox.fromFile(from).seal("value");
    assert.equal(moveSecretsKey(from, to), "moved");
    assert.equal(existsSync(from), false, "no key is left beside the store");
    assert.equal(statSync(to).mode & 0o777, 0o600);
    assert.equal(SecretBox.fromFile(to).open(sealed), "value");
    // Nothing to move, the second time, or where the setting names the folder's own file.
    assert.equal(moveSecretsKey(from, to), undefined);
    SecretBox.fromFile(from);
    assert.equal(moveSecretsKey(from, from), undefined);
  });

  test("a copy of the same key in the state folder goes; two different keys are refused, and both kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-secrets-"));
    const from = join(dir, "secrets.key");
    const to = join(dir, "apart", "secrets.key");
    SecretBox.fromFile(to);
    writeFileSync(from, readFileSync(to, "utf8"), { mode: 0o600 });
    assert.equal(moveSecretsKey(from, to), "removed");
    assert.equal(existsSync(from), false);
    SecretBox.fromFile(from);
    const kept = readFileSync(to, "utf8");
    assert.throws(
      () => moveSecretsKey(from, to),
      /control has two secrets keys, .* and they differ/,
    );
    assert.ok(existsSync(from));
    assert.equal(readFileSync(to, "utf8"), kept);
    // A folder's file that holds no key is refused, and moves nowhere.
    const bad = join(dir, "bad.key");
    writeFileSync(bad, "not a key\n");
    assert.throws(
      () => moveSecretsKey(bad, join(dir, "else.key")),
      /does not hold a 32-byte base64 key/,
    );
    assert.equal(existsSync(join(dir, "else.key")), false);
  });

  test("the dashboard's hint shows four characters at most", () => {
    assert.equal(keyHint("sk-abcdefgh1234"), "…1234");
    assert.equal(keyHint("short"), "…");
  });
});

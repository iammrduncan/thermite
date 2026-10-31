import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keyHint, SecretBox } from "../../src/control/secrets.ts";

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

  test("the dashboard's hint shows four characters at most", () => {
    assert.equal(keyHint("sk-abcdefgh1234"), "…1234");
    assert.equal(keyHint("short"), "…");
  });
});

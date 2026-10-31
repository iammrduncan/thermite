import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeDeployKey } from "../../src/control/git-keys.ts";

describe("deploy keys control makes", () => {
  test("ssh reads the private key, and derives the same public key and fingerprint", () => {
    const k = makeDeployKey("thermite github-deploy");
    assert.match(
      k.publicKey,
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+ thermite github-deploy$/,
    );
    const file = join(mkdtempSync(join(tmpdir(), "thermite-key-")), "id");
    writeFileSync(file, k.privateKey, { mode: 0o600 });
    const derived = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();
    assert.equal(
      derived.split(" ").slice(0, 2).join(" "),
      k.publicKey.split(" ").slice(0, 2).join(" "),
    );
    const fp = execFileSync("ssh-keygen", ["-l", "-f", file], { encoding: "utf8" });
    assert.ok(fp.includes(k.fingerprint), `${fp} vs ${k.fingerprint}`);
    // Two keys are never the same.
    assert.notEqual(makeDeployKey("x").publicKey, makeDeployKey("x").publicKey);
  });
});

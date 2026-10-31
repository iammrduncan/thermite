import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { Credential, newToken } from "../../src/control/credential.ts";

describe("control credentials", () => {
  test("a credential made from a token's hash accepts that token and nothing else", () => {
    const { token, sha256 } = newToken();
    assert.equal(sha256, createHash("sha256").update(token).digest("hex"));
    assert.ok(token.length >= 40);
    const c = Credential.ofHash(sha256.toUpperCase());
    assert.ok(c.matches(token));
    assert.ok(!c.matches(`${token}x`));
    assert.ok(!c.matches(""));
    assert.ok(c.same(Credential.ofToken(token)));
    assert.ok(Credential.from(token).same(c));
    assert.notEqual(newToken().token, token);
  });

  test("a malformed hash or an empty token is refused", () => {
    assert.throws(() => Credential.ofHash("abc"), /64 hexadecimal/);
    assert.throws(() => Credential.ofHash("z".repeat(64)), /64 hexadecimal/);
    assert.throws(() => Credential.ofToken(""), /empty/);
  });
});

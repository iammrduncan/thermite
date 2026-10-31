import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { generateSigningKeys, verifyCommand, verifyJson } from "../../src/core/commands.ts";
import {
  controlCodeProof,
  enrollmentProof,
  generateTunnelKeys,
  keySha256,
  newNonce,
  open,
  PodConfig,
  publicKeyFromLine,
  publicKeyLine,
  type RequestHead,
  sameHex,
  seal,
  signAnswer,
  signRequest,
  verifyAnswer,
  verifyRequest,
} from "../../src/core/tunnel.ts";

describe("the tunnel's cryptography", () => {
  // Control signs requests with its command-signing key, as it signs commands.
  const control = generateSigningKeys();
  const other = generateSigningKeys();
  const rig = generateTunnelKeys();
  const head: RequestHead = {
    method: "POST",
    path: "/x/exchange",
    rig: "rp-1",
    pod: "pod1",
    at: 1_000_000,
    nonce: newNonce(),
  };
  const body = Buffer.from('{"answers":[]}');

  test("a request verifies only unchanged, and only with control's key", () => {
    const sig = signRequest(head, body, control.privateKeyPem);
    assert.ok(verifyRequest(head, body, sig, control.publicKeyPem));
    for (const changed of [
      { ...head, method: "GET" },
      { ...head, path: "/x/enroll" },
      { ...head, rig: "rp-2" },
      { ...head, pod: "pod2" },
      { ...head, at: head.at + 1 },
      { ...head, nonce: newNonce() },
    ])
      assert.ok(!verifyRequest(changed, body, sig, control.publicKeyPem), JSON.stringify(changed));
    assert.ok(!verifyRequest(head, Buffer.from("{}"), sig, control.publicKeyPem), "another body");
    assert.ok(!verifyRequest(head, body, sig, other.publicKeyPem), "another key");
    assert.ok(!verifyRequest(head, body, "not base64 at all", control.publicKeyPem));
    const forged = signRequest(head, body, other.privateKeyPem);
    assert.ok(!verifyRequest(head, body, forged, control.publicKeyPem), "signed by anyone else");
  });

  test("a request's signature can never pass for a signed command", () => {
    const sig = signRequest(head, body, control.privateKeyPem);
    // Exactly what control signed: the format of commands, with the tunnel's own v and kind.
    const signed = {
      v: "thermite-tunnel-v1",
      kind: "tunnel_request",
      ...head,
      body_sha256: createHash("sha256").update(body).digest("hex"),
    };
    assert.ok(verifyJson(signed, sig, control.publicKeyPem));
    const r = verifyCommand({ envelope: signed, signature: sig }, control.publicKeyPem, "rp-1");
    assert.equal(r.ok ? "" : r.reason, "malformed command");
  });

  test("an answer is bound to its request's nonce, status and body", () => {
    const sig = signAnswer(head.nonce, 200, body, rig.signPrivatePem);
    assert.ok(verifyAnswer(head.nonce, 200, body, sig, rig.signPublicPem));
    assert.ok(!verifyAnswer(newNonce(), 200, body, sig, rig.signPublicPem), "an old answer");
    assert.ok(!verifyAnswer(head.nonce, 404, body, sig, rig.signPublicPem));
    assert.ok(!verifyAnswer(head.nonce, 200, Buffer.from("x"), sig, rig.signPublicPem));
    assert.ok(!verifyAnswer(head.nonce, 200, body, sig, control.publicKeyPem));
  });

  test("sealed bytes open only with the recipient's key, and not once changed", () => {
    const other = generateTunnelKeys();
    const secret = Buffer.from('{"api_key":"a-made-up-model-key-0001"}');
    const sealed = seal(secret, rig.boxPublicPem);
    assert.ok(!sealed.includes(secret), "no plain text in what crosses the proxy");
    assert.ok(!sealed.toString("latin1").includes("model-key"));
    assert.deepEqual(open(sealed, rig.boxPrivatePem), secret);
    assert.notDeepEqual(seal(secret, rig.boxPublicPem), sealed, "a fresh key every time");
    assert.throws(() => open(sealed, other.boxPrivatePem));
    for (const at of [0, 33, 50, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = (bad[at] ?? 0) ^ 1;
      assert.throws(() => open(bad, rig.boxPrivatePem), `byte ${at} changed`);
    }
    assert.throws(() => open(Buffer.alloc(10), rig.boxPrivatePem), /too short/);
    assert.deepEqual(
      open(seal(Buffer.alloc(0), rig.boxPublicPem), rig.boxPrivatePem),
      Buffer.alloc(0),
    );
  });

  test("enrollment binds both sides to the code, and control's proof to one request", () => {
    const proof = enrollmentProof("code-1", rig.signPublicPem, rig.boxPublicPem);
    assert.ok(sameHex(proof, enrollmentProof("code-1", rig.signPublicPem, rig.boxPublicPem)));
    assert.ok(!sameHex(proof, enrollmentProof("code-2", rig.signPublicPem, rig.boxPublicPem)));
    assert.ok(!sameHex(proof, enrollmentProof("code-1", control.publicKeyPem, rig.boxPublicPem)));
    assert.ok(!sameHex(proof, ""));
    assert.ok(!sameHex(proof, "not hex"));
    const n = newNonce();
    const mine = controlCodeProof("code-1", "rp-1", "pod1", n);
    assert.ok(sameHex(mine, controlCodeProof("code-1", "rp-1", "pod1", n)));
    for (const other of [
      controlCodeProof("code-2", "rp-1", "pod1", n),
      controlCodeProof("code-1", "rp-2", "pod1", n),
      controlCodeProof("code-1", "rp-1", "pod2", n),
      controlCodeProof("code-1", "rp-1", "pod1", newNonce()),
    ])
      assert.ok(!sameHex(mine, other));
  });

  test("a key's SHA-256 and one-line form name it whatever its PEM's spacing", () => {
    const sha = keySha256(control.publicKeyPem);
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.equal(keySha256(`\n${control.publicKeyPem}\n\n`), sha);
    assert.notEqual(keySha256(other.publicKeyPem), sha);
    const line = publicKeyLine(rig.boxPublicPem);
    assert.ok(!line.includes("\n"));
    assert.equal(publicKeyFromLine(line), rig.boxPublicPem);
    assert.throws(() => publicKeyFromLine("bm90IGEga2V5"));
  });

  test("a launch's settings take only known names and values a shell takes as they are", () => {
    assert.deepEqual(PodConfig.parse({ env: { THERMITE_TARGET: "cuda-gpu" } }).env, {
      THERMITE_TARGET: "cuda-gpu",
    });
    assert.deepEqual(PodConfig.parse({}).env, {});
    for (const env of [
      { THERMITE_CONTROL_PUBKEY_FILE: "/tmp/x" },
      { PATH: "/bin" },
      { THERMITE_TARGET: "cpu; rm -rf /" },
      { THERMITE_TARGET: "$(id)" },
      { THERMITE_TARGET: "a\nb" },
      { THERMITE_TARGET: "" },
    ])
      assert.equal(PodConfig.safeParse({ env }).success, false, JSON.stringify(env));
  });
});

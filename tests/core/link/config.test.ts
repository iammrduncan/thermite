import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, test } from "node:test";
import {
  CONFIG_KEYS,
  CONFIG_MAX_BYTES,
  CONFIG_STREAM,
  CONFIG_STREAM_CONFIG,
  configConsumerConfig,
  configFits,
  configMessageId,
  configSubject,
  isSealKey,
  newSealKey,
  openConfig,
  readConfig,
  readConfigSubject,
  sealConfig,
  sealKeyFingerprint,
} from "../../../src/core/link/config.ts";
import { generateBoxKeys, open, publicKeyLine } from "../../../src/core/tunnel.ts";

/**
 * The link's fourth contract (goal 168, step 3): each rig's config on the message bus, a key-value
 * bucket, each value sealed to the rig's own seal key. The supervisor reads a message and keeps
 * what it knows; a message it can't take says why.
 */

const route = {
  route: {
    name: "lab",
    type: "openai",
    harness: "pi",
    version: 1,
    base_url: "https://models.example.com/v1",
    model: "m-1",
    context_window: 128_000,
    max_tokens: 0,
    reasoning: null,
    key_hint: "…abcd",
    revision: "0123456789abcdef",
    api_key: "made-up-key-for-the-test",
  },
  planner: null,
};

/** A message as control writes it, sealed to `sealKey`. */
function message(rig: string, key: string, value: unknown, sealKey: string, o: object = {}) {
  const m = {
    v: 1,
    rig,
    key,
    revision: "aa".repeat(16),
    written_at: "2026-10-28T20:00:00.000Z",
    sealed: sealConfig(rig, key as "model-route", value, sealKey),
    ...o,
  };
  return new TextEncoder().encode(JSON.stringify(m));
}

describe("a rig's config on the message bus", () => {
  test("one subject for each key of each rig, in a stream that keeps the latest of each", () => {
    assert.deepEqual(CONFIG_KEYS, ["model-route", "advisor-routes", "mcp-servers", "git-access"]);
    assert.equal(configSubject("rig-a", "model-route"), "thermite.rig.rig-a.config.model-route");
    assert.deepEqual(readConfigSubject("thermite.rig.rig-a.config.mcp-servers"), {
      rig: "rig-a",
      key: "mcp-servers",
    });
    // A key this build does not know is still read: the supervisor counts it.
    assert.deepEqual(readConfigSubject("thermite.rig.rig-a.config.later"), {
      rig: "rig-a",
      key: "later",
    });
    for (const bad of [
      "thermite.rig.rig-a.config",
      "thermite.rig.A.config.x",
      "thermite.run.r.config.x",
    ])
      assert.equal(readConfigSubject(bad), null, bad);
    assert.throws(() => configSubject("Not a rig", "model-route"), /not a rig's name/);
    assert.equal(CONFIG_STREAM_CONFIG.name, CONFIG_STREAM);
    assert.deepEqual(CONFIG_STREAM_CONFIG.subjects, ["thermite.rig.*.config.*"]);
    assert.equal(CONFIG_STREAM_CONFIG.max_msgs_per_subject, 1, "the latest of each key");
    assert.equal(CONFIG_STREAM_CONFIG.max_age, 0, "a value stays until the next");
    assert.equal(CONFIG_STREAM_CONFIG.max_msg_size, CONFIG_MAX_BYTES);
  });

  test("a rig's consumer takes its own keys, the latest of each first", () => {
    const c = configConsumerConfig("rig-a");
    assert.equal(c.durable_name, "rig-rig-a-config");
    assert.equal(c.filter_subject, "thermite.rig.rig-a.config.*");
    assert.equal(c.deliver_policy, "last_per_subject");
    assert.equal(c.ack_policy, "explicit");
  });

  test("the largest message, its headers with it, and each write's own id", () => {
    assert.equal(configFits(CONFIG_MAX_BYTES - 4096), true);
    assert.equal(configFits(CONFIG_MAX_BYTES - 4095), false);
    const m = { rig: "rig-a", key: "model-route", revision: "ab".repeat(16) };
    assert.notEqual(
      configMessageId({ ...m, written_at: "2026-10-28T20:00:00.000Z" }),
      configMessageId({ ...m, written_at: "2026-10-28T20:00:01.000Z" }),
      "the same value written again later is kept again",
    );
  });

  test("a seal key is an X25519 public key on one line; its fingerprint is not the key", () => {
    const k = newSealKey();
    assert.equal(isSealKey(k.publicKey), true);
    assert.match(sealKeyFingerprint(k.publicKey), /^[0-9a-f]{16}$/);
    assert.ok(!k.publicKey.includes(sealKeyFingerprint(k.publicKey)));
    // An Ed25519 key, garbage, a private key and empty are not seal keys.
    const ed = publicKeyLine(
      generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    for (const bad of ["", "not a key", ed, k.privatePem, `${k.publicKey}x`])
      assert.equal(isSealKey(bad), false, bad.slice(0, 20));
  });

  test("a value sealed to a rig opens with its key alone, and only as its own rig and key", () => {
    const a = newSealKey();
    const b = newSealKey();
    const sealed = sealConfig("rig-a", "model-route", route, a.publicKey);
    assert.ok(!Buffer.from(sealed, "base64").toString("latin1").includes("made-up-key"));
    assert.deepEqual(openConfig("rig-a", "model-route", sealed, a.privatePem), route);
    assert.throws(() => openConfig("rig-a", "model-route", sealed, b.privatePem));
    assert.throws(() => openConfig("rig-b", "model-route", sealed, a.privatePem));
    assert.throws(() => openConfig("rig-a", "mcp-servers", sealed, a.privatePem));
    // Sealed twice, two different messages: a fresh key each time.
    assert.notEqual(sealed, sealConfig("rig-a", "model-route", route, a.publicKey));
    // The tunnel's own label opens none of it.
    const box = generateBoxKeys();
    const tunnel = sealConfig("rig-a", "model-route", route, publicKeyLine(box.boxPublicPem));
    assert.throws(() => open(Buffer.from(tunnel, "base64"), box.boxPrivatePem));
  });

  test("the supervisor reads its own rig's values, checked against their key's schema", () => {
    const k = newSealKey();
    const subject = "thermite.rig.rig-a.config.model-route";
    const read = readConfig(
      "rig-a",
      subject,
      message("rig-a", "model-route", route, k.publicKey),
      k.privatePem,
    );
    assert.ok(!("refused" in read));
    assert.equal(read.key, "model-route");
    assert.equal(read.revision, "aa".repeat(16));
    assert.deepEqual(read.value, route);
    const mcp = { servers: [] };
    const servers = readConfig(
      "rig-a",
      "thermite.rig.rig-a.config.mcp-servers",
      message("rig-a", "mcp-servers", mcp, k.publicKey),
      k.privatePem,
    );
    // What control left out is filled in, as over HTTP: nothing unavailable.
    assert.ok(!("refused" in servers));
    assert.deepEqual(servers.value, { servers: [], unavailable: [] });
  });

  test("a message it can't take says why, and throws nothing (owner's decision 6)", () => {
    const k = newSealKey();
    const other = newSealKey();
    const subject = "thermite.rig.rig-a.config.model-route";
    const why = (s: string, data: Uint8Array, rig = "rig-a") => {
      const r = readConfig(rig, s, data, k.privatePem);
      return "refused" in r ? r.refused : "taken";
    };
    const good = message("rig-a", "model-route", route, k.publicKey);
    assert.equal(why("thermite.rig.rig-a.report", good), "not a config subject");
    assert.equal(why(subject, good, "rig-b"), "another rig's subject");
    assert.equal(
      why("thermite.rig.rig-a.config.later", message("rig-a", "later", {}, k.publicKey)),
      "a key this build does not know",
    );
    assert.equal(why(subject, new TextEncoder().encode("{not json")), "not a config message");
    assert.equal(
      why(subject, message("rig-a", "model-route", route, k.publicKey, { v: 2 })),
      "not a config message",
    );
    assert.equal(
      why(subject, message("rig-a", "mcp-servers", route, k.publicKey)),
      "its rig or key is not its subject's",
    );
    assert.equal(
      why(subject, message("rig-a", "model-route", route, other.publicKey)),
      "it does not open with this rig's seal key",
    );
    assert.equal(
      why(subject, message("rig-a", "model-route", { route: { name: 1 } }, k.publicKey)),
      "not a value of its key",
    );
    // A field this build does not know is passed over.
    assert.equal(
      why(subject, message("rig-a", "model-route", route, k.publicKey, { later: 1 })),
      "taken",
    );
  });
});

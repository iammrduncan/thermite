import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { canonicalJson } from "../../src/core/canonical.ts";
import {
  CommandPayloads,
  type Envelope,
  generateSigningKeys,
  signEnvelope,
  verifyCommand,
} from "../../src/core/commands.ts";

const _readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("signed commands", () => {
  const keys = generateSigningKeys();
  const now = new Date("2026-10-14T12:00:00Z");
  const envelope = (over: Partial<Envelope> = {}): Envelope => ({
    v: 1,
    id: randomUUID(),
    rig: "rig-a",
    kind: "pause_run",
    issued_by: "owner",
    issued_at: "2026-10-14T11:59:00Z",
    expires_at: "2026-10-14T13:00:00Z",
    payload: { run: "smoke-1", reason: "maintenance" },
    ...over,
  });

  test("accepts a correctly signed command for this rig", () => {
    const r = verifyCommand(
      signEnvelope(envelope(), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(r.ok);
  });
  test("rejects unsigned, tampered and wrongly signed commands", () => {
    const signed = signEnvelope(envelope(), keys.privateKeyPem);
    assert.equal(
      verifyCommand({ envelope: signed.envelope }, keys.publicKeyPem, "rig-a", now).ok,
      false,
    );
    const tampered = {
      ...signed,
      envelope: { ...signed.envelope, payload: { run: "other", reason: "x" } },
    };
    const t = verifyCommand(tampered, keys.publicKeyPem, "rig-a", now);
    assert.ok(!t.ok && t.reason === "bad signature");
    const other = generateSigningKeys();
    const w = verifyCommand(
      signEnvelope(envelope(), other.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!w.ok && w.reason === "bad signature");
  });
  test("rejects another rig's command, expired commands and bad payloads", () => {
    const wrongRig = verifyCommand(
      signEnvelope(envelope({ rig: "rig-b" }), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!wrongRig.ok && wrongRig.reason.includes("rig-b"));
    const expired = verifyCommand(
      signEnvelope(envelope({ expires_at: "2026-10-14T11:00:00Z" }), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!expired.ok && expired.reason === "expired");
    const badPayload = verifyCommand(
      signEnvelope(envelope({ payload: { run: "Bad Id" } }), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!badPayload.ok && badPayload.reason.startsWith("bad payload"));
  });

  test("an owner's message goes to everyone working, a lane, a trial, the planner or an advisor role; only all or a lane can be kept", () => {
    const msg = CommandPayloads.message_agent;
    for (const to of [
      "all",
      "planner",
      "advisors",
      "teachers",
      "auditor",
      "review_panel",
      "lane-1",
      "lane-16",
      "trial:t-0123456789abcdef",
    ])
      assert.ok(msg.safeParse({ run: "r-1", to, text: "x" }).success, to);
    for (const to of ["judge", "lane-0", "lane-17", "trial:x", "everyone", "supervisor"])
      assert.ok(!msg.safeParse({ run: "r-1", to, text: "x" }).success, to);
    assert.ok(msg.safeParse({ run: "r-1", to: "all", text: "x", keep: true }).success);
    assert.ok(msg.safeParse({ run: "r-1", to: "lane-2", text: "x", keep: true }).success);
    for (const to of ["planner", "advisors", "auditor", "trial:t-0123456789abcdef"]) {
      const r = msg.safeParse({ run: "r-1", to, text: "x", keep: true });
      assert.ok(!r.success, to);
      assert.match(String(r.error?.issues[0]?.message), /only a message to everyone working/);
    }
    assert.ok(msg.safeParse({ run: "r-1", to: "planner", text: "x", keep: false }).success);
    const unkeep = CommandPayloads.unkeep_message;
    assert.ok(unkeep.safeParse({ run: "r-1", message: 3 }).success);
    assert.ok(!unkeep.safeParse({ run: "r-1", message: 0 }).success);
    assert.ok(!unkeep.safeParse({ run: "r-1" }).success);
  });
});

describe("commands signed before the rename", () => {
  test("a command naming its unit and instance is verified as signed and read as rig and run", async () => {
    const { createPrivateKey, sign } = await import("node:crypto");
    const keys = generateSigningKeys();
    const old = {
      v: 1,
      id: randomUUID(),
      unit: "gpu-1",
      kind: "pause_instance",
      issued_by: "owner:ui",
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payload: { instance: "smoke-1", reason: "owner check" },
    };
    const signature = sign(
      null,
      Buffer.from(canonicalJson(old)),
      createPrivateKey(keys.privateKeyPem),
    ).toString("base64");
    const r = verifyCommand({ envelope: old, signature }, keys.publicKeyPem, "gpu-1");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.envelope.kind, "pause_run");
    assert.equal(r.ok && r.envelope.rig, "gpu-1");
    assert.deepEqual(r.ok && r.payload, { run: "smoke-1", reason: "owner check" });
    // Changed after signing: refused, as any other command.
    const tampered = {
      envelope: { ...old, payload: { instance: "other-1", reason: "x" } },
      signature,
    };
    assert.equal(verifyCommand(tampered, keys.publicKeyPem, "gpu-1").ok, false);
    assert.equal(verifyCommand({ envelope: old, signature }, keys.publicKeyPem, "gpu-2").ok, false);
  });
});

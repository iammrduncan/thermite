import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { issueCommand } from "../../src/control/issue/index.ts";
import { ControlStore, fingerprint } from "../../src/control/store/index.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";
import { verifyExport } from "../../src/supervisor/git-export.ts";
import { relayOnce } from "../../src/supervisor/relay/index.ts";
import { ADMIN, controlOnly, controlStack } from "../helpers/control-stack.ts";
import { enrollRigs, heldEvents, ingestReport } from "../helpers/control-store.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

const rigHeaders = {
  authorization: "Bearer rig-token-abcdef",
  "content-type": "application/json",
};

describe("signed reports at control", () => {
  test("stale reports, gaps and reports from a ledger the rig left are refused", async () => {
    const env = makeHarnessEnv("rig-a");
    const { store, control } = controlOnly({ keys: env.keys });
    const post = (body: unknown) =>
      control.request("/v1/rigs/rig-a/ingest", {
        method: "POST",
        headers: rigHeaders,
        body: JSON.stringify(body),
      });
    appendOther(env.service.ledger, "t", "one", null, {});
    const old = env.service.snapshot(0, 100) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
    appendOther(env.service.ledger, "t", "two", null, {});
    const fresh = env.service.snapshot(0, 100) as Record<string, unknown>;
    // A cluster rig control marked failed (its wait ended) that reports again is running again.
    store.clusters.addRig({
      rig: "rig-a",
      cluster: "k",
      namespace: "ns",
      placement: "slot",
      spec: {
        gpus: 0,
        gpuMode: "device-plugin",
        storageGi: 10,
        images: { harness: "h", supervisor: "s" },
      },
      created_by: "owner:ui",
    });
    store.clusters.setRigStatus("rig-a", "failed");
    assert.equal((await post(fresh)).status, 200);
    assert.equal(store.clusters.rig("rig-a")?.status, "running");
    assert.ok(store.rigHistory.list("rig-a").some((x) => x.step === "report_after_images" && x.ok));
    // An older report (a replay) is refused: the rig cannot be frozen in an old state.
    const replay = await post(old);
    assert.equal(replay.status, 409);
    // A page that starts past what control has is a gap.
    appendOther(env.service.ledger, "t", "three", null, {});
    appendOther(env.service.ledger, "t", "four", null, {});
    const ahead = env.service.snapshot(Number(fresh.next) + 1, 100) as Record<string, unknown>;
    const gap = await post(ahead);
    assert.equal(gap.status, 409);
    assert.equal(((await gap.json()) as { expected_cursor: number }).expected_cursor, fresh.next);
    const kinds = (await heldEvents(store, "rig-a")).map((e) => e.kind);
    assert.deepEqual(kinds, ["one", "two"]);
    // A rig that moved to a new ledger never goes back to the one it left.
    const base = { rig: "rig-a", cursor: 0, next: 0, events: [], summary: {} };
    await ingestReport(store, {
      ...base,
      ledger_id: "ledger-new",
      generated_at: new Date().toISOString(),
    });
    const back = store.reportedRigs.reportCheck("rig-a", {
      ledgerId: String(fresh.ledger_id),
      cursor: 0,
      generatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    assert.equal(back.ok, false);
  });

  test("with owner acceptance required, a rig's first key is held, and only the checked one is accepted", async () => {
    const env = makeHarnessEnv("rig-a");
    const { store, control } = controlOnly({
      keys: env.keys,
      options: { requireKeyAcceptance: true },
    });
    const snap = env.service.snapshot(0, 100);
    const post = () =>
      control.request("/v1/rigs/rig-a/ingest", {
        method: "POST",
        headers: rigHeaders,
        body: JSON.stringify(snap),
      });
    assert.equal((await post()).status, 409);
    assert.equal(store.reportedRigs.key("rig-a").pubkey, null);
    const wrong = await control.request("/v1/rigs/rig-a/key/accept?fingerprint=0000", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(wrong.status, 404);
    const fp = fingerprint(String(store.reportedRigs.key("rig-a").pending));
    const ok = await control.request(`/v1/rigs/rig-a/key/accept?fingerprint=${fp}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(ok.status, 200);
    assert.equal((await post()).status, 200);
  });
});

describe("the command queue", () => {
  test("expired commands are not relayed; the owner can cancel one; commands go through when reporting fails", async () => {
    const { env, store, control, cfg } = controlStack({ env: makeHarnessEnv("rig-a") });
    const expired = issueCommand(store, env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "export_now",
      payload: {},
      ttlMinutes: 1,
      issuedBy: "owner:test",
    });
    store.db
      .prepare(
        "update command set signed = json_set(signed, '$.envelope.expires_at', ?) where id = ?",
      )
      .run(new Date(Date.now() - 60_000).toISOString(), expired.id);
    const cancel = issueCommand(store, env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "export_now",
      payload: {},
      issuedBy: "owner:test",
    });
    const r = await control.request(`/v1/commands/${cancel.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(r.status, 200);
    const keep = issueCommand(store, env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "export_now",
      payload: {},
      issuedBy: "owner:test",
    });
    assert.deepEqual(
      store.commands.pending("rig-a").map((c) => c.envelope.id),
      [keep.id],
    );
    assert.equal(store.commands.get(expired.id)?.status, "expired");
    // Reporting fails (control refuses every report), yet the command is relayed and applied.
    const fetchImpl: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname.endsWith("/ingest")
        ? new Response("{}", { status: 500 })
        : await cfg.fetchImpl(input, init);
    await assert.rejects(relayOnce({ ...cfg, fetchImpl }, { cursor: 0 }));
    assert.equal(store.commands.get(keep.id)?.status, "delivered");
  });

  test("a command too large to deliver is refused when it is issued", () => {
    const store = new ControlStore(":memory:");
    enrollRigs(store, ["rig-a"]);
    assert.throws(
      () =>
        issueCommand(store, generateSigningKeys().privateKeyPem, {
          rig: "rig-a",
          kind: "pause_run",
          payload: { run: "i-1", reason: "x".repeat(4 * 1024 * 1024) },
          issuedBy: "owner:test",
        }),
      /too large/,
    );
  });
});

describe("exports", () => {
  test("a link or an unlisted file in an export is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-exp-"));
    mkdirSync(join(dir, "attempts"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        from_event: 0,
        through_event: 1,
        files: { "events.jsonl": "0".repeat(64) },
      }),
    );
    symlinkSync("/etc/hosts", join(dir, "events.jsonl"));
    const r = verifyExport(dir);
    assert.equal(r.manifest, undefined);
    assert.match(r.problems.join(";"), /not a regular file/);
    const dir2 = mkdtempSync(join(tmpdir(), "thermite-exp-"));
    writeFileSync(
      join(dir2, "manifest.json"),
      JSON.stringify({ from_event: 0, through_event: 1, files: {} }),
    );
    writeFileSync(join(dir2, "events.jsonl"), "");
    assert.match(verifyExport(dir2).problems.join(";"), /events.jsonl is not in the manifest/);
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint } from "../../../src/control/store/index.ts";
import type { ControllerContext } from "../../../src/harness/controller/context.ts";
import { openState } from "../../../src/harness/controller/state.ts";

test("the harness logs its report key's fingerprint at every start: the one control shows for the rig", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "thermite-state-"));
  const ctx = { rig: "rig-1", paths: { stateDir } } as unknown as ControllerContext;
  const lines: Record<string, unknown>[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => {
    lines.push(JSON.parse(chunk) as Record<string, unknown>);
    return true;
  });
  const first = openState(ctx);
  first.ledger.close();
  const again = openState(ctx);
  again.ledger.close();
  t.mock.restoreAll();
  const said = lines.filter((l) => l.msg === "the rig's report key");
  assert.equal(said.length, 2, "once at each start");
  const pub = readFileSync(join(stateDir, "ledger", "rig-signing.key.pub"), "utf8");
  // Control's fingerprint of the key it pins, and the page's command on the rig (sha256sum of the
  // trimmed public key, its first 16 characters).
  const byHand = createHash("sha256").update(pub.trim()).digest("hex").slice(0, 16);
  for (const l of said) {
    assert.equal(l.rig, "rig-1");
    assert.equal(l.fingerprint, fingerprint(again.rigKeys.publicKeyPem));
    assert.equal(l.fingerprint, byHand);
  }
});

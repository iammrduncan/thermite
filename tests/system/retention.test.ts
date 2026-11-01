import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildsDir } from "../../src/harness/retention.ts";
import { controlStack } from "../helpers/control-stack.ts";

/**
 * A retention policy of a rig's kind, end to end: the owner's Run now on control, the signed
 * `retention_run` relayed to the rig's harness, the judge's builds it covers removed there, and
 * the rig's `retention_removed` event back on control, in the history and the audit log.
 */

const DAY = 86_400_000;

describe("a retention policy on a rig, end to end", () => {
  test("Run now reaches the rig, which removes its old builds and says what went", async () => {
    const s = controlStack();
    await s.relay();
    const { ledger, paths } = s.env.service;
    const key = "b".repeat(64);
    ledger.builds.record({
      key,
      repo: "smoke",
      commit: "1".repeat(40),
      kitCommit: "2".repeat(40),
      ok: true,
      manifest: {},
      actor: "judge",
    });
    const dir = join(buildsDir(paths.stateDir), key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bin"), Buffer.alloc(2048));
    writeFileSync(join(dir, "manifest.json"), "{}\n");
    const old = new Date(Date.now() - 60 * DAY);
    utimesSync(join(dir, "manifest.json"), old, old);

    const made = await s.api("POST", "/v1/retention/policies", {
      name: "Old builds",
      kind: "builds",
      where: "rigs",
      rigs: ["rig-a"],
      rule: "older",
      older_n: 30,
    });
    const { policy } = (await made.json()) as { policy: { id: number } };
    const run = await s.api("POST", `/v1/retention/policies/${policy.id}/run`);
    assert.match(((await run.json()) as { said: string }).said, /^Sent “Old builds” to rig-a/);

    await s.relay(2);
    assert.equal(existsSync(dir), false, "the rig removed the build");
    const [removal] = s.store.retention.removals(5);
    assert.equal(removal?.rig, "rig-a");
    assert.equal(removal?.count, 1);
    assert.ok((removal?.bytes ?? 0) >= 2048);
    assert.equal(removal?.by, "Run now");
    const audit = s.store.auditLog.list(200).find((a) => a.action === "retention_removed");
    assert.equal(audit?.actor, "rig:rig-a");
  });
});

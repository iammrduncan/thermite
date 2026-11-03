import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { IDS, roleIds } from "../../../src/harness/broker/index.ts";
import { imageChecksProbes, PROBE, type Probe } from "../../../src/harness/selftest/index.ts";

/** Runs the roles' probe script with these probes, as this user or, from root, as another. */
function probe(probes: Probe[], as?: { uid: number; gid: number }): Record<string, string> {
  const r = spawnSync(process.execPath, ["-e", PROBE, JSON.stringify(probes)], {
    encoding: "utf8",
    ...as,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, string>;
}

const asRoot = process.getuid?.() === 0;

describe("the smoke check's own kits in the isolation selftest", () => {
  test("every role probes their folder and a kit file in it by its path; a folder with no kit has none", () => {
    const checks = mkdtempSync(join(tmpdir(), "image-checks-"));
    assert.deepEqual(imageChecksProbes(checks), []);
    assert.deepEqual(imageChecksProbes(join(checks, "missing")), []);
    const kit = join(checks, "kits", "smoke-cpu", "kit.json");
    mkdirSync(dirname(kit), { recursive: true });
    writeFileSync(kit, "{}");
    assert.deepEqual(imageChecksProbes(checks), [
      { name: "image-checks-list", op: "list", path: checks },
      { name: "image-kit-read", op: "read", path: kit },
    ]);
  });

  test("kept as the image keeps them, root's with the controller's group: only that group lists them or reads a kit", (t) => {
    const base = mkdtempSync(join(tmpdir(), "image-checks-closed-"));
    chmodSync(base, 0o755);
    const checks = join(base, "checks");
    const kit = join(checks, "kits", "smoke-cpu", "kit.json");
    mkdirSync(dirname(kit), { recursive: true });
    writeFileSync(kit, "{}");
    const tree = [checks, join(checks, "kits"), dirname(kit)];
    for (const d of tree) chmodSync(d, 0o750);
    chmodSync(kit, 0o640);
    const probes = imageChecksProbes(checks);
    const reached = { "image-checks-list": "ALLOWED", "image-kit-read": "ALLOWED" };
    // Their owner (here: this user) reaches them.
    assert.deepEqual(probe(probes), reached);
    if (!asRoot) {
      t.skip("another user's probe needs root (root on Linux runs it)");
      return;
    }
    for (const p of [...tree, kit]) chownSync(p, 0, IDS.thermite.gid);
    // The controller reads them through its group; every role, a lane's and an agent's users among
    // them, is refused at the folder.
    assert.deepEqual(probe(probes, IDS.thermite), reached);
    for (const role of ["lane-1", "lane-1-dev", "agent-1", "planner", "checker"] as const)
      assert.deepEqual(
        probe(probes, roleIds(role)),
        { "image-checks-list": "EACCES", "image-kit-read": "EACCES" },
        role,
      );
  });
});

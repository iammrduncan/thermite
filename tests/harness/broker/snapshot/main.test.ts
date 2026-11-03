import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER_FILE, SEALED } from "../../../../src/harness/broker/snapshot/index.ts";
import { fixture, gid, RIG, rowsIn, typicalState, uid } from "./setup.ts";

/**
 * The broker's helper process (snapshot-main.ts): it takes a sealed snapshot from the job and key
 * on its standard input, and logs a job it cannot do.
 */

describe("the broker's helper (snapshot-main.ts)", () => {
  const main = fileURLToPath(
    new URL("../../../../src/harness/broker/snapshot-main.ts", import.meta.url),
  );
  const runHelper = (input: string) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", main, "take"],
      { encoding: "utf8", input },
    );

  test("takes a sealed snapshot in its own process, its job and key on its standard input", () => {
    const f = fixture();
    typicalState(f);
    const job = {
      dir: f.dir,
      reason: "after an export",
      areas: f.areas,
      stage: join(f.root, "stage"),
      owner: { uid, gid },
      rig: RIG,
      key: f.key.toString("base64url"),
    };
    const r = runHelper(JSON.stringify(job));
    assert.equal(r.status, 0, r.stderr);
    const line = JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
    assert.equal(line.msg, "took a snapshot of the rig's state");
    assert.equal(line.reason, "after an export");
    assert.equal(line.ledger, true);
    assert.equal(line.seq, 1);
    assert.ok(line.sealed > 0);
    assert.ok(!r.stdout.includes(job.key), "the key is never logged");
    assert.equal(existsSync(job.stage), false, "the ledger's copy is gone");
    rmSync(f.live, { recursive: true, force: true });
    assert.ok(f.restore());
    assert.deepEqual(rowsIn(join(f.live, "harness", LEDGER_FILE)), { ok: "ok", a: 3, b: 3 });
    // A job it cannot do: logged, exit 1, and the snapshot before stays.
    const before = readFileSync(join(f.dir, SEALED.manifest));
    const bad = runHelper(
      JSON.stringify({ ...job, dir: join(f.root, "no-such-volume", "thermite") }),
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /could not take a snapshot of the rig's state: the last one stays/);
    assert.deepEqual(readFileSync(join(f.dir, SEALED.manifest)), before);
    // No key, or a job that is not one: nothing is taken.
    const nokey = runHelper(JSON.stringify({ ...job, key: "" }));
    assert.equal(nokey.status, 1);
    assert.match(nokey.stdout, /the launch gave no THERMITE_STATE_SNAPSHOT_KEY/);
    const notJob = runHelper("not json");
    assert.equal(notJob.status, 1);
    assert.match(notJob.stdout, /the job is not valid/);
    assert.deepEqual(readFileSync(join(f.dir, SEALED.manifest)), before);
    rmSync(f.root, { recursive: true, force: true });
  });
});

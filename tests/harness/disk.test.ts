import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GIB } from "../../src/common/disk.ts";
import { DiskWatch } from "../../src/harness/disk.ts";
import type { Ledger } from "../../src/harness/ledger/index.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

/** A full-disk stand-in: each place's free space is what the test sets, of a 100 GiB disk. */
function standIn(free: Record<string, number>) {
  return (path: string) => {
    const name = path.split("/").at(-1) ?? "";
    return { free: (free[name] ?? 100) * GIB, total: 100 * GIB };
  };
}

const diskEvents = (ledger: Ledger) =>
  ledger.db
    .prepare("select body from event where kind = 'rig_disk' order by id")
    .all()
    .map((r) => JSON.parse(String(r.body)) as { low: boolean; reason?: string });

describe("the rig's disk floor (goal 173)", () => {
  test("at the floor the rig holds new work and records it once; it goes back with room to spare", async () => {
    const env = makeJudgeEnv();
    const free: Record<string, number> = {};
    const disk = new DiskWatch({
      ledger: env.ledger,
      floorGib: 5,
      places: [
        { name: "state", path: env.paths.stateDir },
        { name: "scratch", path: env.paths.scratchDir },
        { name: "outbox", path: env.paths.outboxDir },
      ],
      free: standIn(free),
    });
    env.service.disk = disk;
    assert.equal(disk.held, undefined);
    assert.equal(diskEvents(env.ledger).length, 0);

    free.outbox = 3.2;
    disk.check();
    assert.match(disk.held ?? "", /at its floor of 5 GiB \(its outbox has 3\.2 GiB free\)/);
    assert.deepEqual(
      diskEvents(env.ledger).map((e) => e.low),
      [true],
    );
    assert.ok(disk.summary().since);
    // Checked again at the floor: nothing more is recorded, and nothing fails.
    disk.check();
    disk.check();
    assert.equal(diskEvents(env.ledger).length, 1);

    // An export is refused in words; the export command too, once, with the reason.
    await assert.rejects(
      env.service.export("scheduler"),
      /an export waits: the rig's disk is at its floor/,
    );
    await env.service.applyCommand(env.assign);
    const out = await env.service.applyCommand(env.sign("export_now", {}));
    assert.ok(out.status === "applied" && !out.accepted, JSON.stringify(out));
    assert.match(JSON.stringify(out), /disk is at its floor/);

    // The report carries the reading.
    const report = env.service.snapshot(0, 10) as {
      summary: { disk: { low: boolean; places: unknown[] } };
    };
    assert.equal(report.summary.disk.low, true);
    assert.equal(report.summary.disk.places.length, 3);

    // Just above the floor is not enough room: no flapping.
    free.outbox = 5.5;
    disk.check();
    assert.ok(disk.held);
    free.outbox = 7;
    disk.check();
    assert.equal(disk.held, undefined);
    assert.deepEqual(
      diskEvents(env.ledger).map((e) => e.low),
      [true, false],
    );
    assert.equal(disk.summary().since, null);
  });

  test("a restart at the floor holds from the start, with the time it began; 0 is no floor", () => {
    const env = makeJudgeEnv();
    const places = [{ name: "state", path: env.paths.stateDir }];
    const first = new DiskWatch({
      ledger: env.ledger,
      floorGib: 5,
      places,
      free: standIn({ state: 1 }),
    });
    const since = first.summary().since;
    assert.ok(since);
    const again = new DiskWatch({
      ledger: env.ledger,
      floorGib: 5,
      places,
      free: standIn({ state: 1 }),
    });
    assert.ok(again.held);
    assert.equal(again.summary().since, since);
    assert.equal(diskEvents(env.ledger).length, 1);
    // No floor: never held, and the floor's end is recorded.
    const off = new DiskWatch({
      ledger: env.ledger,
      floorGib: 0,
      places,
      free: standIn({ state: 0 }),
    });
    assert.equal(off.held, undefined);
    assert.deepEqual(
      diskEvents(env.ledger).map((e) => e.low),
      [true, false],
    );
  });
});

describe("an import and the rig's disk floor", () => {
  test("an import that would take its place below the floor is refused before it is copied", async () => {
    const { importFile, importRoom } = await import("../../src/harness/imports.ts");
    const { mkdirSync, mkdtempSync, readdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const env = makeJudgeEnv();
    const free: Record<string, number> = { models: 5 + 50 / GIB }; // 50 bytes above the floor
    const disk = new DiskWatch({
      ledger: env.ledger,
      floorGib: 5,
      places: [{ name: "state", path: env.paths.stateDir }],
      free: standIn(free),
    });
    const inbox = mkdtempSync(join(tmpdir(), "thermite-inbox-"));
    const model = Buffer.alloc(100, 1);
    writeFileSync(join(inbox, "m.bin"), model);
    const storeDir = join(mkdtempSync(join(tmpdir(), "thermite-store-")), "models");
    mkdirSync(storeDir);
    const input = {
      inboxDir: inbox,
      rel: "m.bin",
      expectedSha256: createHash("sha256").update(model).digest("hex"),
      storeDir,
      room: importRoom(disk, "the model m"),
    };
    await assert.rejects(
      importFile(input),
      /^Error: the model m is 0 GiB, and the rig's disk has 5 GiB free with a floor of 5 GiB: it is not copied$/,
    );
    assert.deepEqual(readdirSync(storeDir), [], "nothing was copied");
    free.models = 6;
    assert.ok((await importFile(input)).endsWith(input.expectedSha256), "with room: stored");
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Loops } from "../../../src/common/health.ts";
import { type BusFigures, ControlLook, storageFigures } from "../../../src/control/system/index.ts";
import { buildOf } from "../../../src/core/version.ts";
import { controlStore } from "../../helpers/control-store.ts";

/**
 * Control itself on Metrics (goal 179): its process with its loops, and where its state sits, in
 * memory and on disk, each place's used and available space, with control.db's tables from SQLite.
 */

const build = buildOf("0.1.1", "6802210731d3da56b6ec31e5b35ef8141528a556");

test("control's process: its use, Node's memory, the event loop since the first ask, and its loops", () => {
  const loops = new Loops();
  loops.add("retention", 60_000);
  const look = new ControlLook({ loops, build });
  const f = look.read();
  assert.ok(f.use.memory_bytes > 0);
  assert.ok(f.memory.heap_used > 0 && f.memory.heap_used <= f.memory.heap_total);
  assert.equal(f.ok, true);
  assert.deepEqual(Object.keys(f.loops), ["retention"]);
  assert.equal(f.history.length, 1);
  assert.equal(f.build.commit, build.commit);
  look.close();
});

test("control.db: its file and log, its pages, each table's bytes and rows, each index's table", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-db-figures-")), "control.db");
  const store = controlStore(path);
  await store.auditLog.add("owner", "test", { a: 1 });
  await store.auditLog.add("owner", "test", { a: 2 });
  const f = await store.size.measure();
  assert.ok(f.file_bytes > 0);
  assert.equal(f.file_bytes % f.page_size, 0);
  assert.ok(f.schema_version && f.schema_version >= 28);
  const audit = f.tables.find((t) => t.name === "audit");
  assert.equal(audit?.kind, "table");
  assert.ok((audit?.rows ?? 0) >= 2);
  const index = f.tables.find((t) => t.kind === "index");
  assert.ok(index?.of, "an index names its table");
  assert.equal(index?.rows, null);
  assert.ok(f.cache_bytes > 0);
});

test("storage: memory and disk, each place with what it uses and what it may still take", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-storage-")), "control.db");
  const store = controlStore(path);
  const control = new ControlLook({ loops: new Loops(), build }).read();
  const MIB = 2 ** 20;
  const busFigures = {
    server: {
      memory_bytes: 200 * MIB,
      jetstream: {
        memory_bytes: 0,
        memory_max: 384 * MIB,
        store_bytes: 900 * MIB,
        store_max: 1024 * MIB,
      },
    },
    streams: [{ name: "EVENTS", bytes: 800 * MIB }],
  } as unknown as BusFigures;
  const f = await storageFigures({ store, bus: undefined, control, busFigures });
  assert.deepEqual(
    f.memory.map((p) => p.name),
    ["control", "the bus's server", "streams kept in memory"],
  );
  assert.deepEqual(f.memory[2], {
    name: "streams kept in memory",
    used: 0,
    available: 384 * MIB,
    total: 384 * MIB,
    of: "JetStream's memory store, against its limit",
  });
  const state = f.disk.find((p) => p.name === "control's state folder");
  assert.ok(state && state.total !== null && state.available !== null);
  assert.equal(state.used + state.available <= (state.total ?? 0) + 1, true);
  assert.deepEqual(
    f.disk.find((p) => p.name === "the bus's store"),
    {
      name: "the bus's store",
      used: 900 * MIB,
      available: 124 * MIB,
      total: 1024 * MIB,
      of: "JetStream's file store, against its limit",
    },
  );
  assert.deepEqual(f.streams, [{ name: "EVENTS", bytes: 800 * MIB }]);
  assert.ok(f.kinds.some((k) => k.kind === "store" && (k.bytes ?? 0) > 0));
  assert.ok(f.db && f.db.tables.length > 0);
});

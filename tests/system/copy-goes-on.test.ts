import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  copyStore,
  type IngestReport,
  openPostgresStore,
  openSqliteStore,
} from "../../src/control/store/index.ts";
import { keepFolds } from "../../src/control/views/index.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import {
  applied,
  busOf,
  closeBus,
  heldEvents,
  ingestReport,
  storeOnBus,
} from "../helpers/control-store.ts";
import { FakeBus } from "../helpers/fake-bus.ts";
import { postgresConnection } from "../helpers/postgres.ts";

/**
 * After the copy of its store from SQLite to PostgreSQL (goal 268), control goes on from the same
 * event of the bus's stream: its start check holds, it applies what the stream got since, no
 * event is applied twice, and none is skipped.
 */

/** A page of a rig ledger's notes, as a report that passed control's checks carries them. */
const page = (rig: string, from: number, n: number): IngestReport => ({
  rig,
  ledger_id: "l-1",
  cursor: from - 1,
  next: from + n - 1,
  generated_at: new Date().toISOString(),
  summary: {},
  events: Array.from({ length: n }, (_, i) => ({
    id: from + i,
    at: new Date(Date.UTC(2026, 10, 14, 9, 0, 0, from + i)).toISOString(),
    actor: "harness",
    kind: "journal_note",
    subject: null,
    body: { n: from + i },
    run: null,
  })),
});

describe("control on PostgreSQL, after the copy of its store", () => {
  test("goes on from the same event: none applied twice, none skipped", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-copy-on-")), "control.db");
    const bus = new FakeBus();
    // Control on SQLite takes 40 events of rig-a, and stops.
    const sqlite = storeOnBus(openSqliteStore(path), bus);
    await ingestReport(sqlite, page("rig-a", 1, 40));
    await applied(sqlite);
    assert.equal(await sqlite.busPositions.of(EVENT_STREAM), 40);
    closeBus(sqlite);
    await sqlite.close();

    const conn = postgresConnection();
    const report = await copyStore({ sqlite: path, conn });
    assert.deepEqual(report.places, { [EVENT_STREAM]: 40 });

    // Control starts on PostgreSQL, on the same bus: its start check holds at the same place.
    const store = storeOnBus(openPostgresStore(conn, ":memory:"), bus);
    await applied(store);
    assert.equal(busOf(store).apply.stopped, null);
    assert.equal(await store.busPositions.of(EVENT_STREAM), 40);
    assert.equal(await store.reportedRigs.heldCursor("rig-a", "l-1"), 40);
    // The rig sends again from before the copy, and goes on: only the new events are new.
    assert.equal(await ingestReport(store, page("rig-a", 31, 10)), 0, "none is applied twice");
    assert.equal(await ingestReport(store, page("rig-a", 41, 5)), 5);
    const events = await heldEvents(store, "rig-a");
    assert.equal(await store.busPositions.of(EVENT_STREAM), 45);
    assert.equal(await store.reportedRigs.heldCursor("rig-a", "l-1"), 45);
    assert.deepEqual(
      events.map((e) => [e.seq, e.id]),
      Array.from({ length: 45 }, (_, i) => [i + 1, i + 1]),
      "every event once, in order: none skipped",
    );
    assert.equal(bus.kept.filter((k) => k.stream === EVENT_STREAM).length, 45);
    assert.deepEqual(keepFolds(store).held(), [{ rig: "rig-a", ledger: "l-1", seq: 45 }]);
    closeBus(store);
    await store.close();
  });
});

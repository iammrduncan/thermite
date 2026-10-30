import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { Outgoing } from "../../src/common/bus/index.ts";
import { copiesOf } from "../../src/common/db-copy.ts";
import { MOVE_CHECK_SAMPLE } from "../../src/control/events/index.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { keepFolds } from "../../src/control/views/index.ts";
import { canonicalJson } from "../../src/core/canonical.ts";
import {
  EVENT_HEADERS,
  EVENT_MAX_BYTES,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  readEventMessage,
} from "../../src/core/link/events.ts";
import { assigned } from "../helpers/assignments.ts";
import {
  applied,
  busOf,
  closeBus,
  controlStore,
  heldEvents,
  ingestReport,
} from "../helpers/control-store.ts";
import { asMessage, FakeBus } from "../helpers/fake-bus.ts";
import { keepOldRows, type OldRow, withEventsTable } from "../helpers/old-store.ts";

/**
 * The move of a store's events table to the message bus's `EVENTS` stream (goal 168, step 4,
 * part 4.5): a store from v0.1.0 or from before step 4's publish starts, moves its rows to the
 * stream in the table's order, checks them there, keeps a copy of itself outside the copies'
 * rotation, and drops the table (store migration 12). Every row once, in order, through a stop part
 * way, a lost ack and a batch stored late; the knowledge base's cursors across it; a stream older
 * than the store, a stream that lacks rows and a row too large for the bus stop the move, and the
 * table stays.
 */

const V010 = readFileSync(
  join(import.meta.dirname, "..", "helpers", "data", "control-v0.1.0.sql"),
  "utf8",
);

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-move-")), "control.db");
const version = (db: DatabaseSync) =>
  (db.prepare("select max(version) as v from schema_migrations").get() as { v: number }).v;
const hasTable = (db: DatabaseSync) =>
  Boolean(db.prepare("select 1 from sqlite_master where name = 'rig_event'").get());
const onStream = (bus: FakeBus) => bus.kept.filter((k) => k.stream === EVENT_STREAM);
const keptCopies = (path: string) =>
  readdirSync(join(path, "..")).filter((f) => f.startsWith("control.db.") && f.endsWith(".kept"));

/** A store from before step 4's publish, at version 11, with these rows in its events table. */
function oldStore(rows: OldRow[], path = fresh()): string {
  const s = new ControlStore(path);
  withEventsTable(s.db);
  keepOldRows(s.db, rows);
  s.db.close();
  return path;
}

/** `n` notes of one rig ledger, from `from`. */
const notes = (rig: string, ledger: string, from: number, n: number): OldRow[] =>
  Array.from({ length: n }, (_, i) => ({ rig, ledger, id: from + i, kind: "journal_note" }));

/** Waits until `ok` holds, or fails after two seconds. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`not in 2 s: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The stream holds the rows once each, in the table's order, at places 1 to n: each message,
 * read back, is its row, with its seq in its headers and no message id.
 */
function assertMoved(bus: FakeBus, rows: { seq: number; row: OldRow }[]): void {
  const kept = onStream(bus);
  assert.equal(kept.length, rows.length, "a message for each row");
  for (const [i, { seq, row }] of rows.entries()) {
    const k = kept[i];
    assert.ok(k);
    assert.equal(k.seq, i + 1);
    assert.equal(k.id, undefined, "no message id");
    const read = readEventMessage(asMessage(k));
    assert.deepEqual(
      [read.rig, read.ledger, read.seq, read.event.id],
      [row.rig, row.ledger, seq, row.id],
    );
    assert.equal(read.event.kind, row.kind);
  }
}

/** The rows as the table numbered them, from seq 1, with no gap. */
const numbered = (rows: OldRow[]) => rows.map((row, i) => ({ seq: i + 1, row }));

describe("a store's events table, moved to the events stream once, and dropped", () => {
  test("from before step 4: every row in order on its subject, checked, the table dropped, a copy kept", async () => {
    const rows: OldRow[] = [
      {
        rig: "rig-a",
        ledger: "la-1",
        id: 1,
        kind: "run_created",
        subject: "sort-1",
        run: "sort-1",
        body: { campaign: "c-1" },
      },
      { rig: "rig-a", ledger: "la-1", id: 2, kind: "trial_started", subject: "t-1", run: "sort-1" },
      {
        rig: "rig-a",
        ledger: "la-1",
        id: 3,
        kind: "experiment_added",
        subject: "sort-1",
        run: "sort-1",
      },
      {
        rig: "rig-b",
        ledger: "lb-1",
        id: 1,
        kind: "run_created",
        subject: "sort-2",
        run: "sort-2",
        body: { campaign: "c-2" },
      },
      // rig-b's event of a run the registry gives rig-a.
      { rig: "rig-b", ledger: "lb-1", id: 2, kind: "dev_run", run: "sort-1" },
      { rig: "rig-a", ledger: "la-1", id: 4, kind: "journal_note" },
      // rig-a's full reset: its new ledger.
      { rig: "rig-a", ledger: "la-2", id: 1, kind: "rig_check_started" },
      { rig: "rig-a", ledger: "la-2", id: 2, kind: "trial_started", subject: "t-3", run: "sort-1" },
    ];
    const path = oldStore(rows);
    const store = controlStore(path);
    await applied(store);
    const { bus, move } = busOf(store);
    assertMoved(bus, numbered(rows));
    assert.deepEqual(
      onStream(bus).map((k) => k.subject),
      [
        "thermite.run.sort-1.ev.run_created",
        "thermite.run.sort-1.ev.trial_started",
        "thermite.run.sort-1.queue.added",
        "thermite.run.sort-2.ev.run_created",
        "thermite.rig.rig-b.ev.dev_run",
        "thermite.rig.rig-a.ev.journal_note",
        "thermite.rig.rig-a.ev.rig_check_started",
        "thermite.run.sort-1.ev.trial_started",
      ],
    );
    assert.equal(move.published, 8);
    assert.equal(move.stopped, null);
    // The table and the rig's last cursor went, in store migration 12.
    assert.equal(hasTable(store.db), false);
    assert.equal(version(store.db), 22);
    const rigCols = store.db.prepare("pragma table_info(rig)").all() as { name: string }[];
    assert.ok(!rigCols.some((c) => c.name === "last_cursor"));
    // The copy before it is kept outside the rotation, and holds the table.
    assert.ok(move.copy?.endsWith(".kept"), move.copy);
    assert.deepEqual(keptCopies(path), [move.copy?.split("/").at(-1)]);
    assert.ok(!copiesOf(path).some((c) => c.path === move.copy), "outside the rotation");
    const copy = new DatabaseSync(move.copy ?? "", { readOnly: true });
    assert.equal((copy.prepare("select count(*) as n from rig_event").get() as { n: number }).n, 8);
    assert.equal(version(copy), 11);
    copy.close();
    // Control's records came from the stream: each ledger's held cursor, the registry.
    assert.equal(store.reportedRigs.heldCursor("rig-a", "la-1"), 4);
    assert.equal(store.reportedRigs.heldCursor("rig-a", "la-2"), 2);
    assert.equal(store.reportedRigs.heldCursor("rig-b", "lb-1"), 2);
    assert.deepEqual(store.reportedRigs.reportRow("rig-a"), {
      ledger_id: "la-2",
      cursor: 2,
      report_at: "2026-10-29T07:00:00.000Z",
    });
    // A report's events published first follow the moved rows: the views' seq is each event's place.
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "la-2",
      cursor: 2,
      next: 3,
      summary: {},
      events: [
        {
          id: 3,
          at: "2026-10-29T08:00:00.000Z",
          actor: "harness",
          kind: "journal_note",
          subject: null,
          body: {},
        },
      ],
    });
    const held = await heldEvents(store, "rig-a");
    assert.deepEqual(
      held.map((e) => e.seq),
      [1, 2, 3, 6, 7, 8, 9],
    );
    const recent = keepFolds(store).view("rig-a", { staleAfterMs: 600_000 })?.recent ?? [];
    assert.deepEqual(
      recent.map((e) => e.seq),
      [9, 8, 7],
      "the current ledger's, newest first",
    );
    // Started again: nothing to move, nothing published, no copy made.
    closeBus(store);
    store.db.close();
    const again = controlStore(path, bus);
    await applied(again);
    assert.equal(busOf(again).move.published, 0);
    assert.equal(onStream(bus).length, 9);
    assert.equal(keptCopies(path).length, 1);
  });

  test("from v0.1.0: migrated, its registry made from the table, moved, checked and dropped", async () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    keepOldRows(old, [
      {
        rig: "rig-a",
        ledger: "l-1",
        id: 1,
        kind: "run_created",
        subject: "gemv-1",
        body: { campaign: "gemv" },
      },
      {
        rig: "rig-a",
        ledger: "l-1",
        id: 2,
        kind: "instance_created",
        subject: "gemv-0",
        body: { campaign: "gemv" },
      },
      ...notes("rig-a", "l-1", 3, 3),
    ]);
    old.close();
    const store = controlStore(path);
    await applied(store);
    // Migrated from version 0, which a copy in the rotation keeps; moved; then dropped, which the
    // kept copy keeps.
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [0],
    );
    assert.equal(keptCopies(path).length, 1);
    assert.match(keptCopies(path)[0] ?? "", /^control\.db\.v11\..*\.kept$/);
    assert.equal(hasTable(store.db), false);
    assert.equal(version(store.db), 22);
    const kept = onStream(busOf(store).bus);
    assert.deepEqual(
      kept.map((k) => [k.headers[EVENT_HEADERS.seq], k.subject]),
      [
        ["1", "thermite.rig.rig-a.ev.run_created"],
        ["2", "thermite.rig.rig-a.ev.instance_created"],
        ["3", "thermite.rig.rig-a.ev.journal_note"],
        ["4", "thermite.rig.rig-a.ev.journal_note"],
        ["5", "thermite.rig.rig-a.ev.journal_note"],
      ],
      "no run of v0.1.0's: each on the rig's subject",
    );
    // The migrations that read the table ran on it before it went: the registry has both runs,
    // the one named before the rename too.
    assert.equal(store.runRegistry.createdOn("gemv-1", "rig-a")?.campaign, "gemv");
    assert.equal(store.runRegistry.createdOn("gemv-0", "rig-a")?.campaign, "gemv");
    const folder = store.db.prepare("select name from campaign_folder").get() as { name: string };
    assert.equal(folder.name, "speed", "and keeps what v0.1.0 kept");
  });

  test("stopped part way, then started again: every row once, in order", async () => {
    const rows = notes("rig-a", "l-1", 1, 2500);
    const path = oldStore(rows);
    const bus = new FakeBus();
    // The server goes away after the first two batches.
    bus.failAfter = 2;
    const first = controlStore(path, bus);
    const { move } = busOf(first);
    await until(() => move.waiting !== null, "the move waits");
    assert.equal(onStream(bus).length, 2000);
    assert.match(String(move.waiting), /no ack/);
    assert.equal(hasTable(first.db), true, "the table stays");
    closeBus(first);
    first.db.close();
    // Control starts again, and the server is back: it goes on after the stream's last row.
    bus.failing = false;
    bus.failAfter = undefined;
    const again = controlStore(path, bus);
    await applied(again);
    assert.equal(busOf(again).move.published, 500);
    assertMoved(bus, numbered(rows));
    assert.equal(hasTable(again.db), false);
  });

  test("a lost ack, and a batch the server stores late: no row moved twice", async () => {
    const lost = new FakeBus();
    lost.loseAck = true;
    const rows = notes("rig-a", "l-1", 1, 1500);
    const a = controlStore(oldStore(rows), lost);
    await applied(a);
    assertMoved(lost, numbered(rows));
    assert.equal(busOf(a).move.published, 500, "the lost ack's batch counts as not published");

    const late = new FakeBus();
    await late.makeStream(EVENT_STREAM_CONFIG);
    const publish = late.publishBatch.bind(late);
    let calls = 0;
    let held: Outgoing[] = [];
    late.publishBatch = async (batch) => {
      calls++;
      if (calls === 1) {
        held = [...batch];
        throw new Error("TimeoutError: no ack from the server");
      }
      if (calls === 2) await publish(held);
      return publish(batch);
    };
    const b = controlStore(oldStore(rows), late);
    await applied(b);
    assertMoved(late, numbered(rows));
    assert.equal(calls, 3, "the failed one, the refused one, then the rest after the late batch");
    assert.equal(hasTable(b.db), false);
  });

  test("the knowledge base's cursors: across the table's gaps, nothing indexed twice or skipped", async () => {
    const note = (id: number, text: string): OldRow => ({
      rig: "rig-a",
      ledger: "l-1",
      id,
      kind: "journal_note",
      subject: "gs-1",
      run: "gs-1",
      body: { id, by: "lane-1", kind: "lesson", text },
    });
    const path = fresh();
    const s = new ControlStore(path);
    assigned(s, "rig-a", "gs-1", "gemv");
    withEventsTable(s.db);
    keepOldRows(s.db, [
      {
        rig: "rig-a",
        ledger: "l-1",
        id: 1,
        kind: "run_created",
        subject: "gs-1",
        run: "gs-1",
        body: { campaign: "gemv" },
      },
      note(2, "first lesson"),
    ]);
    // The table's seq jumps: its rows' places in the stream are not their seqs after this.
    s.db.exec("update sqlite_sequence set seq = seq + 10 where name = 'rig_event'");
    keepOldRows(s.db, [note(3, "second lesson"), note(4, "third lesson")]);
    // As the old control left it: its knowledge base indexed from the table up to seq 13 (the
    // second lesson), its cursor there.
    const kbOld = s.kb();
    for (const e of [
      { kind: "run_created", body: { campaign: "gemv" } },
      { kind: "journal_note", body: note(2, "first lesson").body },
      { kind: "journal_note", body: note(3, "second lesson").body },
    ])
      kbOld.index(
        { rig: "rig-a", ledger: "l-1" },
        { at: "2026-10-29T07:00:00.000Z", actor: "harness", subject: "gs-1", ...e },
      );
    s.db.exec("update kb_cursor set seq = 13");
    const before = kbOld.changedAfter(["gemv"], 0).map((x) => [x.seq, x.ref]);
    assert.deepEqual(before, [
      [1, "gs-1"],
      [2, "2"],
      [3, "3"],
    ]);
    s.db.close();
    const store = controlStore(path);
    await applied(store);
    const kept = onStream(busOf(store).bus);
    assert.deepEqual(
      kept.map((k) => [k.seq, Number(k.headers[EVENT_HEADERS.seq])]),
      [
        [1, 1],
        [2, 2],
        [3, 13],
        [4, 14],
      ],
    );
    const kb = store.kb();
    assert.deepEqual(
      kb.changedAfter(["gemv"], 0).map((x) => [x.seq, x.ref]),
      [...before, [4, "4"]],
      "the third lesson alone is new",
    );
    assert.equal(kb.indexedFromTable(), 13, "the table's cursor does not move");
    // A rig's cursor counts the items: a run's sync after item 3 has the third lesson alone.
    assigned(store, "rig-b", "gs-2", "gemv");
    await ingestReport(store, {
      rig: "rig-b",
      ledger_id: "l-b",
      cursor: 0,
      next: 1,
      summary: {},
      events: [
        {
          id: 1,
          at: "2026-10-29T08:00:00.000Z",
          actor: "harness",
          kind: "run_created",
          subject: "gs-2",
          run: "gs-2",
          body: { campaign: "gemv" },
        },
      ],
    });
    assert.deepEqual(
      kb.sync("rig-b", "gs-2", 3)?.items.map((x) => x.ref),
      ["4"],
    );
    // The views' seq is each event's place in the stream, across the gap: 1 to 4, not 13 and 14.
    const held = await heldEvents(store, "rig-a");
    assert.deepEqual(
      held.map((e) => e.seq),
      [1, 2, 3, 4],
    );
  });

  test("a stream older than the store, or with events published first where the rows would go: refused, the table kept", async () => {
    const rows = notes("rig-a", "l-1", 1, 3);
    // The stream holds rows past the table's last: control's store is older than the stream.
    const ahead = new FakeBus();
    await ahead.makeStream(EVENT_STREAM_CONFIG);
    const row = (seq: number) =>
      canonicalJson({
        id: seq,
        at: "2026-10-29T07:00:00.000Z",
        actor: "harness",
        kind: "journal_note",
        subject: null,
        run: null,
        body: { n: seq },
      });
    for (const seq of [1, 2, 3, 4, 5])
      await ahead.publish("thermite.rig.rig-a.ev.journal_note", row(seq), {
        id: `x-${seq}`,
        headers: {
          [EVENT_HEADERS.rig]: "rig-a",
          [EVENT_HEADERS.ledger]: "l-1",
          [EVENT_HEADERS.seq]: String(seq),
        },
      });
    const a = controlStore(oldStore(rows), ahead);
    await busOf(a).started;
    assert.equal(
      busOf(a).move.stopped?.error,
      "the stream holds rows to seq 5, past the table's last, 3: control's store is older than the stream",
    );
    assert.equal(hasTable(a.db), true);
    assert.equal(version(a.db), 11);
    // The stream holds one moved row, then an event published first: the table's other rows
    // can't go before it.
    const first = new FakeBus();
    await first.makeStream(EVENT_STREAM_CONFIG);
    await first.publish("thermite.rig.rig-a.ev.journal_note", row(1), {
      id: "m-1",
      headers: {
        [EVENT_HEADERS.rig]: "rig-a",
        [EVENT_HEADERS.ledger]: "l-1",
        [EVENT_HEADERS.seq]: "1",
      },
    });
    await first.publish("thermite.rig.rig-a.ev.journal_note", row(9), {
      id: "rig-a:l-9:9",
      headers: { [EVENT_HEADERS.rig]: "rig-a", [EVENT_HEADERS.ledger]: "l-9" },
    });
    const b = controlStore(oldStore(rows), first);
    await busOf(b).started;
    assert.equal(
      busOf(b).move.stopped?.error,
      "the stream holds events published first after place 1, where the table's rows after seq 1 would go: control's store is older than the stream",
    );
    assert.equal(hasTable(b.db), true);
  });

  test("a stream that lacks rows of the table does not drop it, and says so in words", async () => {
    const rows = notes("rig-a", "l-1", 1, 200);
    const path = oldStore(rows);
    // A stream that holds the table's last row, but not every row before it: restored in part.
    const partial = new FakeBus();
    await partial.makeStream(EVENT_STREAM_CONFIG);
    const s = new ControlStore(path);
    for (const r of s.eventsTable.inOrder(0, 1000).filter((x) => x.seq !== 50))
      await partial.publish(
        `thermite.rig.rig-a.ev.journal_note`,
        canonicalJson({ ...r.event, run: r.run, body: JSON.parse(r.body) }),
        {
          id: `p-${r.seq}`,
          headers: {
            [EVENT_HEADERS.rig]: r.rig,
            [EVENT_HEADERS.ledger]: r.ledger_id,
            [EVENT_HEADERS.seq]: String(r.seq),
          },
        },
      );
    s.db.close();
    const store = controlStore(path, partial);
    await busOf(store).started;
    assert.equal(
      busOf(store).move.stopped?.error,
      "the events stream lacks rows of control's events table: it holds 199 of the table's 200 rows, the last at seq 200, where the table's last is 200",
    );
    assert.equal(hasTable(store.db), true, "the table stays");
    assert.equal(version(store.db), 11);
    assert.deepEqual(keptCopies(path), [], "no copy made: nothing dropped");
    closeBus(store);
    store.db.close();
    // As many rows, one of them not the table's at its place: its body changed.
    const changed = new FakeBus();
    await changed.makeStream(EVENT_STREAM_CONFIG);
    const t = new ControlStore(path);
    for (const r of t.eventsTable.inOrder(0, 1000))
      await changed.publish(
        `thermite.rig.rig-a.ev.journal_note`,
        canonicalJson({
          ...r.event,
          run: r.run,
          body: r.seq === 1 ? { n: "other" } : JSON.parse(r.body),
        }),
        {
          id: `c-${r.seq}`,
          headers: {
            [EVENT_HEADERS.rig]: r.rig,
            [EVENT_HEADERS.ledger]: r.ledger_id,
            [EVENT_HEADERS.seq]: String(r.seq),
          },
        },
      );
    t.db.close();
    const other = controlStore(path, changed);
    await busOf(other).started;
    assert.equal(
      busOf(other).move.stopped?.error,
      "the events stream lacks rows of control's events table: its place 1 does not hold the row it should, in the table's order",
    );
    assert.equal(hasTable(other.db), true);
    assert.ok(MOVE_CHECK_SAMPLE < rows.length, "a sample of the rows is compared");
  });

  test("a row too large for the bus stops the move there; the table stays", async () => {
    const path = oldStore([
      { rig: "rig-a", ledger: "l-1", id: 1, kind: "journal_note" },
      {
        rig: "rig-a",
        ledger: "l-1",
        id: 2,
        kind: "journal_note",
        body: { text: "x".repeat(EVENT_MAX_BYTES) },
      },
      { rig: "rig-a", ledger: "l-1", id: 3, kind: "journal_note" },
    ]);
    const store = controlStore(path);
    await busOf(store).started;
    const { bus, move } = busOf(store);
    assert.equal(onStream(bus).length, 1, "the row before it");
    const stopped = move.stopped;
    assert.ok(stopped);
    assert.deepEqual([stopped.rig, stopped.ledger, stopped.seq], ["rig-a", "l-1", 2]);
    assert.ok(Number(stopped.bytes) > EVENT_MAX_BYTES);
    assert.match(stopped.error, /more than a message on the bus holds \(8388608 bytes/);
    assert.equal(hasTable(store.db), true);
  });
});

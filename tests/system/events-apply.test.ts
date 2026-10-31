import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { EventsApply } from "../../src/control/events/index.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import { callUsage } from "../../src/core/usage.ts";
import { assigned } from "../helpers/assignments.ts";
import { controlStack } from "../helpers/control-stack.ts";
import { applied, busOf, closeBus, controlStore, ingestReport } from "../helpers/control-store.ts";
import { FakeBus } from "../helpers/fake-bus.ts";
import { appendOther } from "../helpers/kinds.ts";

/**
 * What control derives from its rigs' events, applied from the message bus's `EVENTS` stream
 * (goal 168, step 4): in the stream's order, with the stream's place in the same transaction; a
 * restart goes on from that place, a store older than the stream catches up, a store past the
 * stream's end is refused; an event applied twice changes nothing; each rig ledger's held cursor;
 * the knowledge base's cursors; the subjects of a run a page creates; and a page posted over HTTP
 * reaching the derived state through the bus. The knowledge base of a store moved from its events
 * table is in events-move.test.ts.
 */

type Ev = {
  id: number;
  kind: string;
  run?: string | null;
  subject?: string | null;
  body?: unknown;
};

/** A page of a rig's ledger, taken as a report that passed control's checks is. */
async function page(store: ControlStore, rig: string, ledger: string, events: Ev[]): Promise<void> {
  const first = events[0]?.id ?? 1;
  await ingestReport(store, {
    rig,
    ledger_id: ledger,
    cursor: first - 1,
    next: events.at(-1)?.id ?? first,
    generated_at: new Date().toISOString(),
    summary: {},
    events: events.map((e) => ({
      id: e.id,
      at: new Date(Date.UTC(2026, 9, 29, 5, 0, 0, e.id)).toISOString(),
      actor: "harness",
      kind: e.kind,
      subject: e.subject ?? null,
      body: e.body ?? { n: e.id },
      run: e.run ?? null,
    })),
  });
}

/** A model call's body, as a harness records it. */
const call = (trial: string) => ({
  trial,
  round: null,
  agent: "workers",
  harness: "pi",
  provider: "lab",
  model: "wide-model",
  ...callUsage({
    at: "2026-10-29T05:00:00.000Z",
    calls: 1,
    tokensIn: 100,
    cachedIn: null,
    tokensOut: 20,
    callMs: 900,
  }),
});

/** A command control issued the rig, pending until the harness's outcome comes. */
function issued(store: ControlStore, rig: string, id: string): void {
  store.db
    .prepare(
      "insert into command (id, rig, kind, signed, issued_by, issued_at, status) values (?, ?, 'pause_run', '{}', 'owner:ui', ?, 'pending')",
    )
    .run(id, rig, new Date().toISOString());
}

/** rig-a's ledger l-1: a run it creates, its trial, a model call, a note, a command's outcome. */
const RUN_PAGE: Ev[] = [
  { id: 1, kind: "run_created", subject: "gs-1", run: "gs-1", body: { campaign: "gemv" } },
  { id: 2, kind: "trial_started", subject: "gs-1", run: "gs-1", body: { trial: "t-1" } },
  { id: 3, kind: "model_call", subject: "gs-1", run: "gs-1", body: call("t-1") },
  {
    id: 4,
    kind: "journal_note",
    subject: "gs-1",
    run: "gs-1",
    body: { id: 1, by: "lane-1", kind: "lesson", text: "vector loads help" },
  },
  { id: 5, kind: "command", subject: "cmd-1", body: { accepted: true, kind: "pause_run" } },
];

/** Every record the apply writes, as rows: what must match between two stores. */
function derived(store: ControlStore) {
  const all = (sql: string) =>
    store.db
      .prepare(sql)
      .all()
      .map((r) => ({ ...r }));
  return {
    registry: all(
      "select run, rig, campaign, ledger_id, created_at from run_registry order by run, rig",
    ),
    commands: all("select id, status, outcome from command order by id"),
    calls: all(
      "select rig, ledger_id, event_id, run, campaign, trial from model_call order by 1, 2, 3",
    ),
    kb: all("select seq, campaign, rig, ledger, run, kind, ref, body from kb_item order by seq"),
    cursor: all("select seq, item_seq from kb_cursor"),
    held: all("select rig, ledger_id, through_event from rig_ledger order by rig, ledger_id"),
    place: store.busPositions.of(EVENT_STREAM),
  };
}

describe("control's records, applied from the events stream", () => {
  test("in the stream's order, with its place in the same transaction", async () => {
    const store = controlStore();
    assigned(store, "rig-a", "gs-1", "gemv");
    issued(store, "rig-a", "cmd-1");
    await page(store, "rig-a", "l-1", RUN_PAGE);
    await applied(store);
    const d = derived(store);
    assert.deepEqual(d.registry, [
      {
        run: "gs-1",
        rig: "rig-a",
        campaign: "gemv",
        ledger_id: "l-1",
        created_at: "2026-10-29T05:00:00.001Z",
      },
    ]);
    assert.equal(store.commands.get("cmd-1")?.status, "delivered");
    assert.deepEqual(store.commands.get("cmd-1")?.outcome, {
      source: "harness",
      accepted: true,
      kind: "pause_run",
    });
    assert.deepEqual(d.calls, [
      { rig: "rig-a", ledger_id: "l-1", event_id: 3, run: "gs-1", campaign: "gemv", trial: "t-1" },
    ]);
    assert.ok(store.kb().search("vector", ["gemv"]).length === 1, "the note in the folder");
    assert.deepEqual(d.held, [{ rig: "rig-a", ledger_id: "l-1", through_event: 5 }]);
    assert.equal(d.place, 5, "the stream's place of the last event");

    // A transaction that fails part way keeps nothing of the page, its place neither, and the
    // apply tries again until it goes through; the report waits for it.
    const { apply } = busOf(store);
    const recordCall = store.usage.recordCall.bind(store.usage);
    let fail = true;
    store.usage.recordCall = (...a) => {
      if (fail) throw new Error("disk I/O error");
      recordCall(...a);
    };
    issued(store, "rig-a", "cmd-2");
    const done = page(store, "rig-a", "l-1", [
      { id: 6, kind: "command", subject: "cmd-2", body: { accepted: false } },
      { id: 7, kind: "model_call", subject: "gs-1", run: "gs-1", body: call("t-2") },
    ]);
    const end = Date.now() + 2000;
    while (apply.waiting === null && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
    assert.equal(apply.waiting, "disk I/O error");
    assert.equal(store.busPositions.of(EVENT_STREAM), 5, "its place did not move");
    assert.equal(store.commands.get("cmd-2")?.status, "pending", "nor the command's outcome");
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-1"), 5, "nor the held cursor");
    fail = false;
    await done;
    assert.equal(apply.waiting, null);
    assert.equal(store.busPositions.of(EVENT_STREAM), 7);
    assert.equal(store.commands.get("cmd-2")?.status, "failed");
    assert.equal(derived(store).calls.length, 2);
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-1"), 7);
  });

  test("a control started again goes on from the store's place", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-apply-")), "control.db");
    const first = controlStore(path);
    assigned(first, "rig-a", "gs-1", "gemv");
    issued(first, "rig-a", "cmd-1");
    await page(first, "rig-a", "l-1", RUN_PAGE.slice(0, 3));
    await applied(first);
    const bus = busOf(first).bus;
    closeBus(first);
    // Control starts again on the same store and bus, and takes the rest of the ledger.
    const second = controlStore(path, bus);
    await page(second, "rig-a", "l-1", RUN_PAGE.slice(3));
    await applied(second);
    assert.equal(busOf(second).apply.applied, 2, "only what came after the store's place");
    assert.equal(second.busPositions.of(EVENT_STREAM), 5);
    assert.equal(second.commands.get("cmd-1")?.status, "delivered");
    assert.equal(second.reportedRigs.heldCursor("rig-a", "l-1"), 5);
  });

  test("a store older than the stream catches up by applying; one past its end is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-apply-"));
    const live = controlStore(join(dir, "control.db"));
    assigned(live, "rig-a", "gs-1", "gemv");
    issued(live, "rig-a", "cmd-1");
    await page(live, "rig-a", "l-1", RUN_PAGE.slice(0, 2));
    await applied(live);
    // A backup of the store, then more events.
    const backup = join(dir, "backup.db");
    live.db.exec(`vacuum into '${backup}'`);
    await page(live, "rig-a", "l-1", RUN_PAGE.slice(2));
    await page(live, "rig-b", "l-b", [{ id: 1, kind: "journal_note" }]);
    await applied(live);
    const bus = busOf(live).bus;
    closeBus(live);
    // The store restored from the backup, on the stream as it is: it applies what came after.
    const restored = new ControlStore(backup);
    assert.equal(restored.busPositions.of(EVENT_STREAM), 2);
    const apply = new EventsApply({ store: restored, bus, retryMs: 5 });
    await apply.start();
    await apply.nudge();
    assert.equal(apply.stopped, null);
    assert.equal(apply.applied, 4);
    assert.deepEqual(derived(restored), derived(live));

    // A store past the stream's end (the stream restored from an older backup): refused, with
    // the stream named, and nothing applied.
    const ahead = new EventsApply({ store: restored, bus: new FakeBus(), retryMs: 5 });
    await ahead.start();
    assert.equal(
      ahead.stopped,
      "control's store has applied the EVENTS stream to place 6, past its last, 0: the stream is older than the store, as when one of them was restored from an older backup. Restore the stream from a backup at least as new as the store, or the store from one no newer than the stream, then start control again",
    );
    assert.equal(restored.busPositions.of(EVENT_STREAM), 6);
    assert.equal(ahead.applied, 0);
  });

  test("an event applied twice changes nothing the second time", async () => {
    const store = controlStore();
    assigned(store, "rig-a", "gs-1", "gemv");
    issued(store, "rig-a", "cmd-1");
    await page(store, "rig-a", "l-1", RUN_PAGE);
    await applied(store);
    const before = derived(store);
    // As if the store lost its place and the stream handed every message again.
    store.busPositions.set(EVENT_STREAM, 0);
    const again = new EventsApply({ store, bus: busOf(store).bus, retryMs: 5 });
    await again.start();
    await again.nudge();
    assert.equal(again.applied, 0, "every event at or below its ledger's held cursor");
    assert.deepEqual(derived(store), before);
    // And with no held cursors either: each record is written the same again.
    store.busPositions.set(EVENT_STREAM, 0);
    store.db.exec("update rig_ledger set through_event = 0");
    const third = new EventsApply({ store, bus: busOf(store).bus, retryMs: 5 });
    await third.start();
    await third.nudge();
    assert.equal(third.applied, 5);
    const after = derived(store);
    // The knowledge base keeps an item's seq when nothing in it changed.
    assert.deepEqual(after, before);
  });

  test("each rig ledger keeps its own held cursor, across a full reset's new ledger", async () => {
    const store = controlStore();
    await page(store, "rig-a", "l-1", [
      { id: 1, kind: "journal_note" },
      { id: 2, kind: "journal_note" },
      { id: 3, kind: "journal_note" },
    ]);
    await page(store, "rig-b", "l-b", [{ id: 1, kind: "journal_note" }]);
    await applied(store);
    // A full reset: rig-a's new ledger starts again at event 1.
    await page(store, "rig-a", "l-2", [
      { id: 1, kind: "journal_note" },
      { id: 2, kind: "journal_note" },
    ]);
    await applied(store);
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-1"), 3);
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-2"), 2);
    assert.equal(store.reportedRigs.heldCursor("rig-b", "l-b"), 1);
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-9"), 0, "a ledger never applied");
    // Control's place in the rig's events is its current ledger's held cursor.
    const row = store.reportedRigs.reportRow("rig-a");
    assert.deepEqual([row?.ledger_id, row?.cursor], ["l-2", 2]);
  });

  test("the knowledge base: each event indexed once, and a rig's cursor counts items", async () => {
    const store = controlStore();
    assigned(store, "rig-a", "gs-1", "gemv");
    const note = (id: number, text: string): Ev => ({
      id,
      kind: "journal_note",
      subject: "gs-1",
      run: "gs-1",
      body: { id, by: "lane-1", kind: "lesson", text },
    });
    await page(store, "rig-a", "l-1", [
      { id: 1, kind: "run_created", subject: "gs-1", run: "gs-1", body: { campaign: "gemv" } },
      note(2, "first lesson"),
    ]);
    // The same page again, and the next: each event once.
    await page(store, "rig-a", "l-1", [note(2, "first lesson"), note(3, "second lesson")]);
    await page(store, "rig-a", "l-1", [note(4, "third lesson")]);
    const kb = store.kb();
    const items = () => kb.changedAfter(["gemv"], 0).map((x) => [x.seq, x.ref]);
    assert.deepEqual(items(), [
      [1, "gs-1"],
      [2, "2"],
      [3, "3"],
      [4, "4"],
    ]);
    // A run's sync from the cursor a rig holds: the items after it, by their seqs.
    assigned(store, "rig-b", "gs-2", "gemv");
    await page(store, "rig-b", "l-b", [
      { id: 1, kind: "run_created", subject: "gs-2", run: "gs-2", body: { campaign: "gemv" } },
    ]);
    const sync = kb.sync("rig-b", "gs-2", 2);
    assert.deepEqual(
      sync?.items.map((x) => [x.seq, x.ref]),
      [
        [3, "3"],
        [4, "4"],
      ],
    );
    assert.equal(sync?.next, 4);
  });

  test("a page that creates a run puts every event of the run on the run's subject", async () => {
    const store = controlStore();
    await page(store, "rig-a", "l-1", [
      { id: 1, kind: "run_created", subject: "nr-1", run: "nr-1", body: { campaign: "c" } },
      { id: 2, kind: "trial_started", subject: "nr-1", run: "nr-1" },
      { id: 3, kind: "experiment_added", subject: "nr-1", run: "nr-1" },
      // A run no rig holds yet, with no run_created: the reporting rig's.
      { id: 4, kind: "dev_run", run: "nr-2" },
    ]);
    // rig-b's event of rig-a's run: on rig-b's own subject.
    await page(store, "rig-b", "l-b", [{ id: 1, kind: "dev_run", run: "nr-1" }]);
    await applied(store);
    assert.deepEqual(
      busOf(store)
        .bus.kept.filter((k) => k.stream === EVENT_STREAM)
        .map((k) => k.subject),
      [
        "thermite.run.nr-1.ev.run_created",
        "thermite.run.nr-1.ev.trial_started",
        "thermite.run.nr-1.queue.added",
        "thermite.run.nr-2.ev.dev_run",
        "thermite.rig.rig-b.ev.dev_run",
      ],
    );
  });

  test("a page posted over HTTP reaches control's records through the bus", async () => {
    const s = controlStack();
    const ledger = s.env.service.ledger;
    appendOther(ledger, "harness", "run_created", "gs-9", { campaign: "gemv" });
    appendOther(ledger, "harness", "model_call", "gs-9", call("t-1"));
    await s.relay();
    const kept = busOf(s.store).bus.kept.filter((k) => k.stream === EVENT_STREAM);
    assert.ok(kept.length >= 2, "the events are on the stream");
    const last = Math.max(...kept.map((k) => k.seq));
    assert.equal(s.store.busPositions.of(EVENT_STREAM), last, "and applied to its end");
    assert.equal(s.store.runRegistry.createdOn("gs-9", "rig-a")?.campaign, "gemv");
    const calls = s.store.db
      .prepare("select run, campaign from model_call")
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(calls, [{ run: "gs-9", campaign: "gemv" }]);
  });
});

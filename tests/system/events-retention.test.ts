import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { eventDaysOf } from "../../src/control/events/index.ts";
import { createPolicy, previewOf, runPolicy } from "../../src/control/retention/index.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import { RetentionSpec } from "../../src/core/retention/index.ts";
import { busOf, ingestReport, storeOnBus } from "../helpers/control-store.ts";
import { FakeBus } from "../helpers/fake-bus.ts";

/**
 * A retention policy of control's copy of the rigs' events (control/events/days.ts): whole days of
 * a subject, oldest first, purged by the server's purge; runs still open kept; each rig ledger's
 * floor recorded, below which control never takes an event back from the rig, nor asks for it.
 */

const DAY = 86_400_000;
const NOW = Date.now();

type Event = {
  id: number;
  at: string;
  actor: string;
  kind: string;
  subject: string | null;
  body: unknown;
  run?: string | null;
};

/** rig-a's events: r-1 made and closed 40 days ago, r-2 made then and still open, and its own. */
function events(): Event[] {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString();
  return [
    {
      id: 1,
      at: at(40),
      actor: "harness",
      kind: "run_created",
      subject: "r-1",
      run: "r-1",
      body: { campaign: "speed", mode: "hill_climb" },
    },
    { id: 2, at: at(40), actor: "harness", kind: "verdict", subject: "a-1", run: "r-1", body: {} },
    {
      id: 3,
      at: at(40),
      actor: "harness",
      kind: "run_status",
      subject: "r-1",
      run: "r-1",
      body: { status: "closed", reason: "done" },
    },
    {
      id: 4,
      at: at(40),
      actor: "harness",
      kind: "run_created",
      subject: "r-2",
      run: "r-2",
      body: { campaign: "speed", mode: "hill_climb" },
    },
    {
      id: 5,
      at: at(40),
      actor: "harness",
      kind: "rig_check_started",
      subject: null,
      run: null,
      body: {},
    },
    {
      id: 6,
      at: at(1),
      actor: "harness",
      kind: "rig_check_started",
      subject: null,
      run: null,
      body: {},
    },
  ];
}

/** Control's store on a bus whose events were stored on the days their events say, as at a start. */
async function setup() {
  const bus = new FakeBus();
  const first = storeOnBus(new ControlStore(":memory:"), bus);
  const all = events();
  await ingestReport(first, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: 6,
    events: all,
    summary: {},
  });
  // As the server stamped each: on its event's day.
  for (const k of bus.kept.filter((m) => m.stream === EVENT_STREAM)) {
    const id = JSON.parse(k.data).id as number;
    k.at = all.find((e) => e.id === id)?.at;
  }
  // Control starts again on the same store and bus: its apply reads the stream from its first
  // message, as at every start.
  const store = storeOnBus(first, bus);
  await busOf(store).started;
  await busOf(store).apply.nudge();
  return { bus, store };
}

const onBus = (bus: FakeBus) =>
  bus.kept
    .filter((m) => m.stream === EVENT_STREAM)
    .map((m) => (JSON.parse(m.data) as { id: number }).id)
    .sort((a, b) => a - b);

describe("a retention policy of control's copy of the rigs' events", () => {
  test("by day, oldest first: runs still open kept; floors recorded; nothing asked for or taken back", async () => {
    const { bus, store } = await setup();
    assert.deepEqual(onBus(bus), [1, 2, 3, 4, 5, 6]);
    const days = eventDaysOf(store);
    assert.ok(days, "the apply keeps the events by day");
    const spec = RetentionSpec.parse({
      name: "Old events",
      kind: "events",
      rule: "older",
      older_n: 30,
    });
    const p = createPolicy(store, spec, false, "owner:ui");
    const preview = previewOf(store, p);
    // r-1's day (3 events) and rig-a's own old day (1); r-2 is open, and rig-a's newer day inside.
    assert.equal(preview.count, 4);
    assert.match(preview.words, /^It would remove 4 events on 1 rig, /);

    const r = await runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui");
    assert.equal(r.removed?.count, 4);
    assert.match(r.said, /^“Old events” removed 4 events on 1 rig, .* from control\.$/);
    assert.deepEqual(
      onBus(bus),
      [4, 6],
      "r-1 and rig-a's old day purged; r-2 and the new day stay",
    );
    // Each rig ledger's floor: the last event removed on purpose.
    assert.deepEqual(
      store.retention.floors("rig-a").map((f) => [f.ledger, f.through_event]),
      [["ledger-a", 5]],
    );
    assert.equal(
      store.reportedRigs.takenThrough("rig-a", "ledger-a"),
      6,
      "its held cursor, higher",
    );
    const [removal] = store.retention.removals(1);
    assert.deepEqual([removal?.kind, removal?.rig, removal?.count], ["events", null, 4]);
    assert.equal(store.auditLog.list(50).filter((a) => a.action === "retention_removed").length, 1);
    // Run again: nothing more to remove.
    assert.equal(
      (await runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui")).removed?.count,
      0,
    );
  });

  test("a store restored from before the purge: the rig is never asked for the events below the floor", async () => {
    const { bus, store } = await setup();
    const spec = RetentionSpec.parse({
      name: "Old events",
      kind: "events",
      rule: "older",
      older_n: 30,
      keep: { open: false },
    });
    const p = createPolicy(store, spec, false, "owner:ui");
    await runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui");
    assert.deepEqual(onBus(bus), [6]);
    assert.equal(store.retention.floor("rig-a", "ledger-a"), 5);
    // As after a restore of an older store: the held cursor is back at 0, and the floor stays.
    store.db.prepare("update rig_ledger set through_event = 0").run();
    assert.equal(store.reportedRigs.heldCursor("rig-a", "ledger-a"), 0);
    // The report check asks the rig to go on after the floor, not from 0: a gap goes back there.
    const at = new Date().toISOString();
    const gap = store.reportedRigs.reportCheck("rig-a", {
      ledgerId: "ledger-a",
      cursor: 7,
      generatedAt: at,
    });
    assert.deepEqual(gap, { ok: false, reason: "a gap in the event stream", expectedCursor: 5 });
    assert.deepEqual(
      store.reportedRigs.reportCheck("rig-a", { ledgerId: "ledger-a", cursor: 5, generatedAt: at }),
      { ok: true },
    );
    // The rig sends its old events again all the same: none at or below the floor goes back.
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: 0,
      next: 6,
      events: events(),
      summary: {},
    });
    assert.deepEqual(
      onBus(bus).filter((id) => id <= 5),
      [],
      "the events removed on purpose stay removed",
    );
  });
});

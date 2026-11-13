import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { eventDaysOf } from "../../src/control/events/index.ts";
import { createPolicy, previewOf, runPolicy } from "../../src/control/retention/index.ts";
import { sqliteBehind } from "../../src/control/store/behind.ts";
import { openControlStore } from "../../src/control/store/index.ts";
import { EVENT_HEADERS, EVENT_STREAM } from "../../src/core/link/events.ts";
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
  const first = storeOnBus(openControlStore(":memory:"), bus);
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

/** What the stream holds: each event as its rig and its id there, in the stream's order. */
const held = (bus: FakeBus) =>
  bus.kept
    .filter((m) => m.stream === EVENT_STREAM)
    .map((m) => `${m.headers[EVENT_HEADERS.rig]}:${(JSON.parse(m.data) as { id: number }).id}`);

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
    const p = await createPolicy(store, spec, false, "owner:ui");
    const preview = await previewOf(store, p);
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
      (await store.retention.floors("rig-a")).map((f) => [f.ledger, f.through_event]),
      [["ledger-a", 5]],
    );
    assert.equal(
      await store.reportedRigs.takenThrough("rig-a", "ledger-a"),
      6,
      "its held cursor, higher",
    );
    const [removal] = await store.retention.removals(1);
    assert.deepEqual([removal?.kind, removal?.rig, removal?.count], ["events", null, 4]);
    assert.equal(
      (await store.auditLog.list(50)).filter((a) => a.action === "retention_removed").length,
      1,
    );
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
    const p = await createPolicy(store, spec, false, "owner:ui");
    await runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui");
    assert.deepEqual(onBus(bus), [6]);
    assert.equal(await store.retention.floor("rig-a", "ledger-a"), 5);
    // As after a restore of an older store: the held cursor is back at 0, and the floor stays.
    sqliteBehind(store).db.prepare("update rig_ledger set through_event = 0").run();
    assert.equal(await store.reportedRigs.heldCursor("rig-a", "ledger-a"), 0);
    // The report check asks the rig to go on after the floor, not from 0: a gap goes back there.
    const at = new Date().toISOString();
    const gap = await store.reportedRigs.reportCheck("rig-a", {
      ledgerId: "ledger-a",
      cursor: 7,
      generatedAt: at,
    });
    assert.deepEqual(gap, { ok: false, reason: "a gap in the event stream", expectedCursor: 5 });
    assert.deepEqual(
      await store.reportedRigs.reportCheck("rig-a", {
        ledgerId: "ledger-a",
        cursor: 5,
        generatedAt: at,
      }),
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
  test("a run two rigs used: a day of one rig's is purged only where the other's kept days do not lie between", async () => {
    const bus = new FakeBus();
    const first = storeOnBus(openControlStore(":memory:"), bus);
    const at = (days: number, minutes: number) =>
      new Date(NOW - days * DAY + minutes * 60_000).toISOString();
    const made = { campaign: "speed", mode: "hill_climb" };
    const closed = { status: "closed", reason: "done" };
    const onRun = (id: number, minutes: number, kind = "verdict", body: unknown = {}): Event => ({
      id,
      at: at(40, minutes),
      actor: "harness",
      kind,
      subject: "r-s",
      run: "r-s",
      body,
    });
    const own = (id: number, days: number): Event => ({
      id,
      at: at(days, 30),
      actor: "harness",
      kind: "rig_check_started",
      subject: null,
      run: null,
      body: {},
    });
    const page = (rig: string, events: Event[]) =>
      ingestReport(first, {
        rig,
        ledger_id: `ledger-${rig}`,
        cursor: (events[0]?.id ?? 1) - 1,
        next: events.at(-1)?.id ?? 0,
        events,
        summary: {},
      });
    // Rig-a and rig-b each made a run named r-s 40 days ago, and reported in turns: on the run's
    // subject, rig-b's events lie between rig-a's.
    await page("rig-a", [onRun(1, 0, "run_created", made), onRun(2, 1)]);
    await page("rig-b", [
      onRun(1, 2, "run_created", made),
      onRun(2, 3),
      onRun(3, 4, "run_status", closed),
    ]);
    await page("rig-a", [onRun(3, 5), onRun(4, 6, "run_status", closed), own(5, 40), own(6, 1)]);
    const all = [...bus.kept.filter((m) => m.stream === EVENT_STREAM)];
    for (const k of all) k.at = (JSON.parse(k.data) as { at: string }).at;
    const store = storeOnBus(first, bus);
    await busOf(store).started;
    await busOf(store).apply.nudge();
    const before = held(bus);
    assert.deepEqual(before, [
      "rig-a:1",
      "rig-a:2",
      "rig-b:1",
      "rig-b:2",
      "rig-b:3",
      "rig-a:3",
      "rig-a:4",
      "rig-a:5",
      "rig-a:6",
    ]);

    // A policy of rig-a alone: its own old day goes; its day of r-s, which rig-b's lies inside,
    // stays whole, and so does rig-b's.
    const rigA = await createPolicy(
      store,
      RetentionSpec.parse({
        name: "Rig-a",
        kind: "events",
        rule: "older",
        older_n: 30,
        where: "rigs",
        rigs: ["rig-a"],
      }),
      false,
      "owner:ui",
    );
    const r = await runPolicy({ store, privateKeyPem: "" }, rigA.id, "hand", "owner:ui");
    assert.equal(r.removed?.count, 1);
    assert.deepEqual(
      held(bus),
      before.filter((e) => e !== "rig-a:5"),
    );
    assert.equal(await store.retention.floor("rig-a", "ledger-rig-a"), 5);
    assert.equal(await store.retention.floor("rig-b", "ledger-rig-b"), 0);

    // A policy of both: the run's old day of each goes whole, rig-a's events after rig-b's too.
    const both = await createPolicy(
      store,
      RetentionSpec.parse({ name: "Both", kind: "events", rule: "older", older_n: 30 }),
      false,
      "owner:ui",
    );
    const r2 = await runPolicy({ store, privateKeyPem: "" }, both.id, "hand", "owner:ui");
    assert.equal(r2.removed?.count, 7);
    assert.deepEqual(held(bus), ["rig-a:6"]);
    assert.equal(await store.retention.floor("rig-a", "ledger-rig-a"), 5);
    assert.equal(await store.retention.floor("rig-b", "ledger-rig-b"), 3);
  });
});

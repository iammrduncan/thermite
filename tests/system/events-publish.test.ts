import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildInfo } from "../../src/common/build-info.ts";
import type { Outgoing } from "../../src/common/bus/index.ts";
import { EventsWriter } from "../../src/control/events/index.ts";
import { foldReport, type Intake, keepReport, takeReport } from "../../src/control/ingest.ts";
import type { ControlStore, IngestReport } from "../../src/control/store/index.ts";
import { keepFolds } from "../../src/control/views/index.ts";
import {
  EVENT_HEADERS,
  EVENT_STREAM,
  eventMessageId,
  readEventMessage,
} from "../../src/core/link/events.ts";
import { readReport, reportMessageId, reportSubject } from "../../src/core/link/report.ts";
import { RelayError, type RelayState, relayOnce } from "../../src/supervisor/relay/index.ts";
import { controlStack, RIG_TOKEN } from "../helpers/control-stack.ts";
import {
  applied,
  busOf,
  closeBus,
  controlStore,
  heldEvents,
  ingestReport,
} from "../helpers/control-store.ts";
import { asMessage, type FakeBus } from "../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

/**
 * Control publishes each report's events to the message bus's `EVENTS` stream first (goal 168,
 * step 4, part 4.5), and answers once it has applied them: in order, each once, through a page of
 * several batches that fails part way, a lost ack, a batch the server stores late, a page sent
 * again inside and beyond the duplicate window, two ways in at once, a crash between the publish
 * and the apply, a full store and the bus away; on the subjects the run registry gives; and the
 * gap check on each rig ledger's held cursor, a full reset's new ledger at 0.
 */

type Ev = {
  id: number;
  kind?: string;
  run?: string | null;
  subject?: string | null;
  body?: unknown;
};

/** A page of a rig ledger's events, as a report that passed control's checks carries them. */
const page = (rig: string, ledger: string, events: Ev[]): IngestReport => ({
  rig,
  ledger_id: ledger,
  cursor: (events[0]?.id ?? 1) - 1,
  next: events.at(-1)?.id ?? 0,
  generated_at: new Date().toISOString(),
  summary: { at: events.length },
  events: events.map((e) => ({
    id: e.id,
    at: new Date(Date.UTC(2026, 9, 29, 8, 0, 0, e.id)).toISOString(),
    actor: "harness",
    kind: e.kind ?? "journal_note",
    subject: e.subject ?? null,
    body: e.body ?? { n: e.id },
    run: e.run ?? null,
  })),
});

/** `n` notes of one ledger, from `from`. */
const notes = (from: number, n: number): Ev[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i }));

const onStream = (bus: FakeBus) => bus.kept.filter((k) => k.stream === EVENT_STREAM);

/** Each rig ledger's event ids on the stream, in the stream's order. */
function idsOnStream(bus: FakeBus): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const k of onStream(bus)) {
    const read = readEventMessage(asMessage(k));
    const key = `${read.rig}/${read.ledger}`;
    out.set(key, [...(out.get(key) ?? []), read.event.id]);
  }
  return out;
}

/** `[from, ..., to]`. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A report taken in the writer's turn, as takeReport takes one that passed its checks. */
const keep = (store: ControlStore, r: IngestReport) =>
  busOf(store).writer.turn(() => keepReport(store, r));

/** A rig's harness with `n` events and its signed pages, and what taking a report needs. */
function signed(store: ControlStore, rig: string, n: number) {
  const env = makeHarnessEnv(rig);
  for (let i = 0; i < n; i++) appendOther(env.service.ledger, "t", "step", null, { i });
  store.enrollments.setConfiguredRigs([rig]);
  const intake: Intake = { store, control: buildInfo(), requireKeyAcceptance: false };
  const snapshot = (cursor: number, limit: number) =>
    readReport(env.service.snapshot(cursor, limit));
  return { env, intake, snapshot };
}

describe("control publishes each report's events first", () => {
  test("in order, each with its id and report, and answers once it has applied them", async () => {
    const store = controlStore();
    const { intake, snapshot } = signed(store, "rig-a", 30);
    const first = snapshot(0, 20);
    const [status, answer] = await takeReport(intake, "rig-a", first);
    assert.deepEqual([status, answer], [200, { added: 20 }]);
    const { bus } = busOf(store);
    const kept = onStream(bus);
    assert.equal(kept.length, 20);
    // Applied before control answered: its place, the ledger's held cursor, the rig's row.
    assert.equal(store.busPositions.of(EVENT_STREAM), kept.at(-1)?.seq);
    const ledger = first.report.ledger_id;
    assert.equal(store.reportedRigs.heldCursor("rig-a", ledger), 20);
    assert.deepEqual(store.reportedRigs.reportRow("rig-a"), {
      ledger_id: ledger,
      cursor: 20,
      report_at: first.report.generated_at,
    });
    assert.equal(store.reportedRigs.list()[0]?.last_cursor, 20);
    for (const [i, k] of kept.entries()) {
      const read = readEventMessage(asMessage(k));
      assert.equal(read.event.id, i + 1);
      assert.equal(k.id, eventMessageId("rig-a", ledger, i + 1));
      assert.equal(read.report, reportMessageId(first.report));
      assert.equal(read.seq, undefined, "no Thermite-Seq: it was never in a table");
      assert.equal(k.subject, "thermite.rig.rig-a.ev.step");
    }
    // Each event's seq in the views and the raw route is its place in the stream.
    const held = await heldEvents(store, "rig-a");
    assert.deepEqual(
      held.map((e) => e.seq),
      kept.map((k) => k.seq),
    );
    assert.deepEqual(
      keepFolds(store)
        .view("rig-a", { staleAfterMs: 600_000 })
        ?.recent.map((e) => e.seq)
        .toReversed()
        .slice(-3),
      [18, 19, 20],
    );
    // The same page again, and the next one, overlapping: each event once, in order.
    assert.deepEqual(await takeReport(intake, "rig-a", snapshot(0, 20)), [200, { added: 0 }]);
    assert.deepEqual(await takeReport(intake, "rig-a", snapshot(10, 20)), [200, { added: 10 }]);
    assert.deepEqual(idsOnStream(bus).get(`rig-a/${ledger}`), range(1, 30));
  });

  test("a page of several batches that fails part way leaves whole batches; sent again, only the rest", async () => {
    const store = controlStore();
    const { bus, writer } = busOf(store);
    const batches: number[] = [];
    const publish = bus.publishBatch.bind(bus);
    bus.publishBatch = (b) => {
      batches.push(b.length);
      return publish(b);
    };
    // A page of 2,500: three atomic batches, of 1,000, 1,000 and 500. The bus goes away after the
    // first.
    bus.failAfter = 1;
    const r = page("rig-a", "l-1", notes(1, 2500));
    const later = await keep(store, r);
    assert.match(
      String((later as { later?: string }).later),
      /^the message bus did not take this report's events: TimeoutError: no ack from the server\. Control takes the report once the bus does: send it again$/,
    );
    assert.equal(onStream(bus).length, 1000, "the first batch, whole");
    assert.equal(writer.later, 1);
    // Nothing of the rig's row moved for the page refused; its first batch is applied, and the
    // held cursor says where it ends.
    assert.equal(store.reportedRigs.reportRow("rig-a")?.report_at, null);
    // The bus is back: the same page publishes only what follows.
    bus.failing = false;
    bus.failAfter = undefined;
    assert.deepEqual(await keep(store, r), { added: 1500 });
    assert.deepEqual(idsOnStream(bus).get("rig-a/l-1"), range(1, 2500));
    assert.deepEqual(batches, [1000, 1000, 1000, 500]);
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-1"), 2500);
    assert.equal(writer.waiting, null);
  });

  test("a lost ack, and the page sent again inside and beyond the duplicate window: nothing published twice", async () => {
    const store = controlStore();
    const { bus } = busOf(store);
    bus.loseAck = true;
    const r = page("rig-a", "l-1", notes(1, 30));
    // The server stored the batch, and its ack was lost: refused for now.
    assert.ok("later" in (await keep(store, r)));
    assert.equal(onStream(bus).length, 30);
    // Sent again inside the window: the writer reads the stream's end again, waits for the apply,
    // and publishes nothing: the held cursor holds the page.
    assert.deepEqual(await keep(store, r), { added: 0 });
    // Beyond it, the server remembers no id: the held cursor alone keeps the page once.
    bus.forgetIds();
    assert.deepEqual(await keep(store, r), { added: 0 });
    assert.deepEqual(idsOnStream(bus).get("rig-a/l-1"), range(1, 30));
    // Each event's id is its rig, ledger and number: within the window, the server keeps one.
    assert.equal(onStream(bus)[0]?.id, "rig-a:l-1:1");
  });

  test("a batch the server stores late, after its publish failed, refuses the next; nothing is stored twice", async () => {
    const store = controlStore();
    const { bus } = busOf(store);
    const publish = bus.publishBatch.bind(bus);
    let calls = 0;
    let late: Outgoing[] = [];
    bus.publishBatch = async (b) => {
      calls++;
      if (calls === 1) {
        late = [...b];
        throw new Error("TimeoutError: no ack from the server");
      }
      // The first lands now, just before the second: which names the last place it expected.
      if (calls === 2) await publish(late);
      return publish(b);
    };
    const r = page("rig-a", "l-1", notes(1, 5));
    assert.ok("later" in (await keep(store, r)));
    // The stream's end read again: the late batch is there, and the second was refused.
    const second = await keep(store, r);
    assert.ok("later" in second, JSON.stringify(second));
    assert.match((second as { later: string }).later, /wrong last sequence/);
    assert.deepEqual(await keep(store, r), { added: 0 });
    assert.deepEqual(idsOnStream(bus).get("rig-a/l-1"), range(1, 5));
    assert.equal(calls, 2);
  });

  test("a page's events in its ledger's order, each once, whatever order the page gives them in", async () => {
    const store = controlStore();
    await ingestReport(store, page("rig-a", "l-1", [{ id: 3 }, { id: 1 }, { id: 2 }, { id: 2 }]));
    await ingestReport(store, page("rig-a", "l-1", [{ id: 5 }, { id: 4 }]));
    assert.deepEqual(idsOnStream(busOf(store).bus).get("rig-a/l-1"), range(1, 5));
    assert.equal(store.reportedRigs.heldCursor("rig-a", "l-1"), 5);
  });

  test("two ways in at once, HTTP and the reports stream, with pages that overlap: each event once, in order", async () => {
    const store = controlStore();
    const { intake, snapshot } = signed(store, "rig-a", 40);
    const over = (r: ReturnType<typeof snapshot>) => ({
      subject: reportSubject("rig-a"),
      seq: 1,
      data: new TextEncoder().encode(JSON.stringify(r.report)),
      header: () => undefined,
    });
    const answers = await Promise.all([
      takeReport(intake, "rig-a", snapshot(0, 25)),
      foldReport(intake, over(snapshot(0, 40))),
      takeReport(intake, "rig-a", snapshot(10, 30)),
    ]);
    const added = answers.map((a) =>
      Array.isArray(a) ? (a[1] as { added: number }).added : (a as { folded: number }).folded,
    );
    assert.equal(
      added.reduce((n, x) => n + x, 0),
      40,
    );
    const { bus } = busOf(store);
    assert.deepEqual([...idsOnStream(bus).values()], [range(1, 40)]);
    assert.equal(onStream(bus).length, 40);
  });

  test("a crash between the publish and the apply: control started again has each event once", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-publish-")), "control.db");
    const first = controlStore(path);
    await ingestReport(first, page("rig-a", "l-1", notes(1, 10)));
    const { bus } = busOf(first);
    await busOf(first).started;
    // This control publishes, then dies before its apply: an apply that never gets there.
    const dying = new EventsWriter({
      store: first,
      bus,
      apply: { reach: async (place) => first.busPositions.of(EVENT_STREAM) >= place },
      applyWaitMs: 10,
    });
    const r = page("rig-a", "l-1", notes(11, 10));
    const lost = await dying.turn(() => keepReport(first, r));
    assert.ok("later" in lost);
    assert.equal(onStream(bus).length, 20, "published");
    assert.equal(first.reportedRigs.heldCursor("rig-a", "l-1"), 10, "not applied");
    closeBus(first);
    first.db.close();
    // Control starts again: the apply takes what the stream holds after the store's place.
    const again = controlStore(path, bus);
    await applied(again);
    assert.equal(again.reportedRigs.heldCursor("rig-a", "l-1"), 20);
    // The rig sends the page again: nothing published twice; the view holds each event once.
    assert.equal(await ingestReport(again, r), 0);
    assert.equal(onStream(bus).length, 20);
    const ids = (await heldEvents(again, "rig-a")).map((e) => e.id);
    assert.deepEqual(ids, range(1, 20));
    const recent = keepFolds(again).view("rig-a", { staleAfterMs: 600_000 })?.recent ?? [];
    assert.equal(new Set(recent.map((e) => e.id)).size, recent.length, "no event twice");
  });

  test("on the subjects the run registry gives: a run a page creates is the rig's; another rig's run is not", async () => {
    const store = controlStore();
    await ingestReport(
      store,
      page("rig-a", "l-a", [
        { id: 1, kind: "run_created", subject: "nr-1", run: "nr-1", body: { campaign: "c" } },
        { id: 2, kind: "trial_started", subject: "nr-1", run: "nr-1" },
        { id: 3, kind: "experiment_added", subject: "nr-1", run: "nr-1" },
      ]),
    );
    // rig-b's event of rig-a's run goes on rig-b's own subject, with the run in its data.
    await ingestReport(store, page("rig-b", "l-b", [{ id: 1, kind: "dev_run", run: "nr-1" }]));
    const kept = onStream(busOf(store).bus);
    assert.deepEqual(
      kept.map((k) => k.subject),
      [
        "thermite.run.nr-1.ev.run_created",
        "thermite.run.nr-1.ev.trial_started",
        "thermite.run.nr-1.queue.added",
        "thermite.rig.rig-b.ev.dev_run",
      ],
    );
    assert.equal(readEventMessage(asMessage(kept[3] as (typeof kept)[0])).event.run, "nr-1");
    assert.deepEqual(store.runRegistry.rigsOf("nr-1"), ["rig-a"]);
  });

  test("the gap check holds each rig ledger's cursor; a full reset's new ledger starts at 0", async () => {
    const store = controlStore();
    const { intake, snapshot } = signed(store, "rig-a", 20);
    const ledger = snapshot(0, 1).report.ledger_id;
    assert.equal((await takeReport(intake, "rig-a", snapshot(0, 10)))[0], 200);
    // A gap after the events control holds: refused, with its held cursor.
    assert.deepEqual(await takeReport(intake, "rig-a", snapshot(15, 5)), [
      409,
      { error: "a gap in the event stream", expected_cursor: 10 },
    ]);
    // A full reset: the harness's new ledger starts again at event 1, and at 0 for control.
    // A report made now: never older than one taken before.
    const check = (ledgerId: string, cursor: number) =>
      store.reportedRigs.reportCheck("rig-a", {
        ledgerId,
        cursor,
        generatedAt: new Date().toISOString(),
      });
    assert.deepEqual(check("l-new", 3), {
      ok: false,
      reason: "a new ledger's events start at 0",
      expectedCursor: 0,
    });
    assert.deepEqual(check("l-new", 0), { ok: true });
    await ingestReport(store, page("rig-a", "l-new", notes(1, 4)));
    assert.deepEqual(
      [
        store.reportedRigs.heldCursor("rig-a", ledger),
        store.reportedRigs.heldCursor("rig-a", "l-new"),
      ],
      [10, 4],
    );
    // The ledger it left is refused for good; the new one goes on from its own cursor.
    assert.deepEqual(check(ledger, 10), {
      ok: false,
      reason: "a report from a ledger the rig has left",
    });
    assert.deepEqual(check("l-new", 4), { ok: true });
    assert.deepEqual(check("l-new", 5), {
      ok: false,
      reason: "a gap in the event stream",
      expectedCursor: 4,
    });
    assert.deepEqual(store.reportedRigs.reportRow("rig-a")?.cursor, 4);
  });

  test("a full store, and the bus away: the page refused for now, in words; the rig keeps its cursor", async () => {
    const s = controlStack({ env: makeHarnessEnv("rig-a") });
    for (let i = 0; i < 5; i++) appendOther(s.env.service.ledger, "t", "step", null, { i });
    const { bus } = busOf(s.store);
    bus.full = true;
    let state: RelayState = { cursor: 0 };
    await assert.rejects(relayOnce(s.cfg, state), (err: unknown) => {
      assert.ok(err instanceof RelayError);
      assert.match(err.message, /ingest -> 503: .*the bus's store is full: insufficient resources/);
      assert.equal(err.state.cursor, 0, "the supervisor keeps its cursor");
      return true;
    });
    // Over HTTP, the route says so, with when to try again.
    const signedPage = s.env.service.snapshot(0, 10);
    const r = await s.api("POST", "/v1/rigs/rig-a/ingest", signedPage, RIG_TOKEN);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.match(((await r.json()) as { error: string }).error, /store is full/);
    assert.equal(onStream(bus).length, 0);
    assert.equal(s.store.reportedRigs.reportRow("rig-a")?.report_at ?? null, null, "nothing kept");
    // The bus away: the same.
    bus.full = false;
    bus.failing = true;
    await assert.rejects(
      relayOnce(s.cfg, state),
      /ingest -> 503: .*TimeoutError: no answer from the server/,
    );
    // Back: the supervisor sends from its cursor, and control takes it all.
    bus.failing = false;
    state = await relayOnce(s.cfg, state);
    await applied(s.store);
    assert.equal(state.cursor, s.env.service.ledger.latestEventId());
    assert.equal((await heldEvents(s.store, "rig-a")).length, s.env.service.ledger.latestEventId());
  });

  test("on the reports stream, a page refused for now is handed again, before any later one", async () => {
    const store = controlStore();
    const { intake, snapshot } = signed(store, "rig-a", 5);
    const { bus } = busOf(store);
    bus.full = true;
    const m = {
      subject: reportSubject("rig-a"),
      seq: 1,
      data: new TextEncoder().encode(JSON.stringify(snapshot(0, 10).report)),
      header: () => undefined,
    };
    const folded = await foldReport(intake, m);
    assert.ok("later" in folded, JSON.stringify(folded));
    assert.match((folded as { later: string }).later, /store is full/);
    bus.full = false;
    assert.deepEqual(await foldReport(intake, m), { folded: 5 });
    assert.deepEqual(
      onStream(bus).map((k) => k.headers[EVENT_HEADERS.rig]),
      ["rig-a", "rig-a", "rig-a", "rig-a", "rig-a"],
    );
  });
});

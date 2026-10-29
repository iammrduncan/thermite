import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JetStreamApiError } from "@nats-io/jetstream";
import { errors } from "@nats-io/transport-node";
import {
  BUS_BATCH_MAX,
  BUS_CA_FILE_SETTING,
  BUS_CA_SETTING,
  BUS_READ_MAX,
  BUS_URL_SETTING,
  type BusMessage,
  busTrust,
  busUrl,
  type Outgoing,
  refusedForGood,
} from "../../src/common/bus/index.ts";
import { makeCa, makeServerCert } from "../../src/control/bus/cert.ts";
import {
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  eventMessage,
  readEventMessage,
} from "../../src/core/link/events.ts";
import { REPORT_STREAM_CONFIG, reportSubject } from "../../src/core/link/report.ts";
import { FakeBus } from "../helpers/fake-bus.ts";

describe("the message bus's setting", () => {
  test("not set or empty keeps the part to HTTP; a nats:// address is taken", () => {
    assert.equal(BUS_URL_SETTING, "THERMITE_NATS_URL");
    assert.equal(busUrl({}), undefined);
    assert.equal(busUrl({ THERMITE_NATS_URL: "" }), undefined);
    assert.equal(busUrl({ THERMITE_NATS_URL: "  " }), undefined);
    assert.equal(busUrl({ THERMITE_NATS_URL: "nats://nats:4222" }), "nats://nats:4222");
    assert.equal(busUrl({ THERMITE_NATS_URL: " nats://127.0.0.1:4222 " }), "nats://127.0.0.1:4222");
  });

  test("anything else stops the part at start, with the setting's name", () => {
    for (const bad of ["http://nats:4222", "nats:4222", "nats://", "tls://nats:4222", "nats"])
      assert.throws(
        () => busUrl({ THERMITE_NATS_URL: bad }),
        new RegExp(
          `^Error: THERMITE_NATS_URL takes a nats:// address, such as nats://nats:4222, not "${bad}"$`,
        ),
        bad,
      );
  });
});

describe("the authority a part trusts the bus's server through", () => {
  test("the certificate itself, or a file read at each connection; neither: the system's", () => {
    assert.equal(BUS_CA_SETTING, "THERMITE_NATS_CA");
    assert.equal(BUS_CA_FILE_SETTING, "THERMITE_NATS_CA_FILE");
    assert.equal(busTrust({}), undefined);
    assert.equal(busTrust({ THERMITE_NATS_CA: " ", THERMITE_NATS_CA_FILE: "" }), undefined);
    // The file need not be there yet: control may write it after the supervisor starts.
    assert.deepEqual(busTrust({ THERMITE_NATS_CA_FILE: " /keys/bus-ca.pem " }), {
      caFile: "/keys/bus-ca.pem",
    });
    const ca = makeCa(new Date(), 1).cert;
    assert.deepEqual(busTrust({ THERMITE_NATS_CA: ca }), { ca });
  });

  test("both, or a certificate that is not an authority's, stops the part at start", () => {
    const ca = makeCa(new Date(), 1);
    assert.throws(
      () => busTrust({ THERMITE_NATS_CA: ca.cert, THERMITE_NATS_CA_FILE: "/keys/bus-ca.pem" }),
      /^Error: set THERMITE_NATS_CA or THERMITE_NATS_CA_FILE, not both$/,
    );
    const server = makeServerCert(ca, ["nats"], new Date(), 1).cert;
    for (const bad of ["not a certificate", server])
      assert.throws(
        () => busTrust({ THERMITE_NATS_CA: bad }),
        /^Error: THERMITE_NATS_CA takes the PEM certificate of the authority that signed the bus's server's certificate$/,
      );
  });

  test("another setting that names the bus is read the same way, in its own name", () => {
    assert.equal(busUrl({ OTHER: "nats://bus:4222" }, "OTHER"), "nats://bus:4222");
    assert.throws(
      () => busUrl({ OTHER: "bus" }, "OTHER"),
      /^Error: OTHER takes a nats:\/\/ address/,
    );
  });
});

describe("a publish the server refused", () => {
  test("for good: its user may not publish there, or the stream refused the message itself", () => {
    const denied = new errors.PermissionViolationError(
      'Permissions Violation for Publish to "thermite.run.r1.live.planner"',
      "publish",
      "thermite.run.r1.live.planner",
    );
    // The library hands it over wrapped in the request's own error.
    assert.ok(refusedForGood(new errors.RequestError(denied.message, { cause: denied })));
    assert.ok(refusedForGood(denied));
    const tooLarge = new JetStreamApiError({
      code: 400,
      err_code: 10054,
      description: "message size exceeds maximum allowed",
    });
    assert.ok(refusedForGood(tooLarge));
  });

  test("not for good: no ack in time, no stream yet, a dropped connection", () => {
    assert.ok(!refusedForGood(new errors.TimeoutError()));
    const none = new Error(
      "no stream on the bus takes thermite.rig.rig-a.live.judge yet: control makes it",
    );
    assert.ok(!refusedForGood(none));
    assert.ok(!refusedForGood(new errors.ClosedConnectionError()));
    assert.ok(!refusedForGood("refused"));
  });
});

/** An event message for the fake bus's EVENTS stream: rig-a's ledger l-1, event `id`. */
const ev = (id: number, kind = "trial_started", run: string | null = "sort-3"): Outgoing =>
  eventMessage({
    rig: "rig-a",
    ledger: "l-1",
    event: {
      id,
      at: "2026-10-29T03:00:00.000Z",
      actor: "planner",
      kind,
      subject: null,
      body: {},
      run,
    },
    runIsTheRigs: true,
  });

/** A fake bus with the events stream, and a stream that takes no batch. */
async function eventsBus(): Promise<FakeBus> {
  const bus = new FakeBus();
  await bus.makeStream(EVENT_STREAM_CONFIG);
  await bus.makeStream(REPORT_STREAM_CONFIG);
  return bus;
}

const ids = (r: { messages: { header(k: string): string | undefined }[] }) =>
  r.messages.map((m) => m.header("Nats-Msg-Id"));

describe("the bus's batches, as the server takes them (the fake bus)", () => {
  test("a batch is stored whole, next to each other, in order", async () => {
    const bus = await eventsBus();
    await bus.publish(reportSubject("rig-a"), "{}", { id: "page-0" });
    const ack = await bus.publishBatch([ev(1), ev(2, "dev_run", null), ev(3, "experiment_added")]);
    assert.deepEqual(ack, { seq: 3, stored: 3, duplicate: false });
    assert.deepEqual(
      bus.kept.filter((m) => m.stream === EVENT_STREAM).map((m) => [m.seq, m.subject]),
      [
        [1, "thermite.run.sort-3.ev.trial_started"],
        [2, "thermite.rig.rig-a.ev.dev_run"],
        [3, "thermite.run.sort-3.queue.added"],
      ],
      "each stream counts its own places",
    );
  });

  test("a batch the stream has already is a duplicate, and one it has part of stores the rest", async () => {
    const bus = await eventsBus();
    await bus.publishBatch([ev(1), ev(2)]);
    assert.deepEqual(await bus.publishBatch([ev(1), ev(2)]), {
      seq: 2,
      stored: 0,
      duplicate: true,
    });
    assert.deepEqual(await bus.publishBatch([ev(2), ev(3), ev(4)]), {
      seq: 4,
      stored: 2,
      duplicate: false,
    });
    assert.deepEqual(
      bus.kept.map((m) => m.id),
      ["rig-a:l-1:1", "rig-a:l-1:2", "rig-a:l-1:3", "rig-a:l-1:4"],
    );
    // Once the window has passed, the stream takes the same ids again: the caller's place stops it.
    bus.forgetIds();
    assert.deepEqual(await bus.publishBatch([ev(1)]), { seq: 5, stored: 1, duplicate: false });
  });

  test("a batch refused part way stores nothing, and the refusal is for good", async () => {
    const bus = await eventsBus();
    bus.refuse = (s) => s.includes(".rig.");
    const refused = await bus.publishBatch([ev(1), ev(2, "dev_run", null), ev(3)]).catch((e) => e);
    assert.ok(refusedForGood(refused));
    bus.refuse = undefined;
    const tooLarge = { ...ev(2), data: "x".repeat(EVENT_STREAM_CONFIG.max_msg_size) };
    const big = await bus.publishBatch([ev(1), tooLarge, ev(3)]).catch((e) => e);
    assert.ok(big instanceof JetStreamApiError && refusedForGood(big));
    assert.equal(bus.kept.length, 0);
    // A stream that takes no batch refuses one; so does a batch over the server's limit or with an id twice.
    await assert.rejects(
      bus.publishBatch([{ subject: reportSubject("rig-a"), data: "{}", id: "p" }]),
      JetStreamApiError,
    );
    await assert.rejects(bus.publishBatch([]), /^Error: a batch holds 1 to 1000 messages, not 0$/);
    const many = Array.from({ length: BUS_BATCH_MAX + 1 }, (_, i) => ev(i + 1));
    await assert.rejects(bus.publishBatch(many), /a batch holds 1 to 1000 messages, not 1001/);
    await assert.rejects(bus.publishBatch([ev(1), ev(1)]), /a batch holds each message id once/);
    assert.equal(bus.kept.length, 0);
  });

  test("a full store refuses every publish, to any stream, and a failing one stores nothing", async () => {
    const bus = await eventsBus();
    bus.full = true;
    for (const p of [
      bus.publishBatch([ev(1)]),
      bus.publish(ev(2).subject, ev(2).data, { id: "rig-a:l-1:2" }),
      bus.publish(reportSubject("rig-a"), "{}", { id: "page-0" }),
    ]) {
      const err = await p.catch((e) => e);
      assert.ok(err instanceof JetStreamApiError && err.code === 10023, String(err));
      assert.ok(refusedForGood(err));
    }
    bus.full = false;
    bus.failing = true;
    const failed = await bus.publishBatch([ev(1), ev(2)]).catch((e) => e);
    assert.ok(!refusedForGood(failed));
    assert.equal(bus.kept.length, 0);
  });
});

describe("the bus's reads, as the server gives them (the fake bus)", () => {
  test("in order, from a place, on several subjects, up to a limit, with where the next starts", async () => {
    const bus = await eventsBus();
    await bus.publishBatch([
      ev(1),
      ev(2, "dev_run", null),
      ev(3, "experiment_added"),
      ev(4, "trial_finished"),
      ev(5, "journal_note", "sort-4"),
      ev(6),
    ]);
    const subjects = ["thermite.run.sort-3.ev.*", "thermite.rig.rig-a.ev.>"];
    const first = await bus.read(EVENT_STREAM, { subjects, limit: 2 });
    assert.deepEqual(ids(first), ["rig-a:l-1:1", "rig-a:l-1:2"]);
    assert.deepEqual([first.next, first.done], [3, false]);
    const rest = await bus.read(EVENT_STREAM, { subjects, from: first.next, limit: 10 });
    assert.deepEqual(ids(rest), ["rig-a:l-1:4", "rig-a:l-1:6"]);
    assert.deepEqual([rest.next, rest.done], [7, true]);
    // Nothing after: done, and the next read starts where it was.
    assert.deepEqual(await bus.read(EVENT_STREAM, { subjects, from: 7, limit: 10 }), {
      messages: [],
      next: 7,
      done: true,
    });
    // No subjects: the whole stream.
    assert.equal((await bus.read(EVENT_STREAM, { limit: 100 })).messages.length, 6);
  });

  test("a header test passes over what it does not hold, and the limit counts what it looked at", async () => {
    const bus = await eventsBus();
    const other = eventMessage({
      rig: "rig-a",
      ledger: "l-2",
      event: {
        id: 1,
        at: "2026-10-29T03:00:00.000Z",
        actor: "planner",
        kind: "trial_started",
        subject: null,
        body: {},
        run: "sort-3",
      },
      runIsTheRigs: true,
    });
    await bus.publishBatch([ev(1), other, ev(2)]);
    const r = await bus.read(EVENT_STREAM, { limit: 2, headers: { "Thermite-Ledger": "l-1" } });
    assert.deepEqual(ids(r), ["rig-a:l-1:1"]);
    assert.deepEqual([r.next, r.done], [3, false]);
  });

  test("its limits: a read looks at 1 to BUS_READ_MAX messages, from 1 on; a stream not made has none", async () => {
    const bus = await eventsBus();
    for (const limit of [0, BUS_READ_MAX + 1, 1.5])
      await assert.rejects(
        bus.read(EVENT_STREAM, { limit }),
        /^Error: a read looks at 1 to 5000 messages/,
      );
    await assert.rejects(
      bus.read(EVENT_STREAM, { limit: 1, from: 0 }),
      /a read starts at 1 or after/,
    );
    assert.deepEqual(await bus.read("NONE", { limit: 1, from: 4 }), {
      messages: [],
      next: 4,
      done: true,
    });
  });

  test("a message by its place, and a stream's last place", async () => {
    const bus = await eventsBus();
    assert.equal(await bus.lastSeq(EVENT_STREAM), 0);
    assert.equal(await bus.lastSeq("NONE"), 0);
    await bus.publishBatch([ev(1), ev(2)]);
    assert.equal(await bus.lastSeq(EVENT_STREAM), 2);
    const m = await bus.message(EVENT_STREAM, 2);
    assert.equal(m?.header("Nats-Msg-Id"), "rig-a:l-1:2");
    assert.equal(readEventMessage(m as BusMessage).event.id, 2);
    assert.equal(await bus.message(EVENT_STREAM, 3), undefined);
    assert.equal(await bus.message("NONE", 1), undefined);
  });
});

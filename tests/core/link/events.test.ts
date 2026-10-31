import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalJson } from "../../../src/core/canonical.ts";
import { EVENT_KINDS } from "../../../src/core/events/kinds.ts";
import { COMMAND_STREAM_CONFIG } from "../../../src/core/link/commands.ts";
import { CONFIG_STREAM_CONFIG } from "../../../src/core/link/config.ts";
import {
  EVENT_HEADERS,
  EVENT_MAX_BYTES,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  EVENT_SUBJECTS,
  eventFits,
  eventMessage,
  eventMessageId,
  eventSubject,
  QUEUE_OPS,
  readEventMessage,
} from "../../../src/core/link/events.ts";
import { LIVE_STREAM_CONFIG } from "../../../src/core/link/live.ts";
import {
  REPORT_MAX_BYTES,
  REPORT_STREAM_CONFIG,
  type ReportEvent,
} from "../../../src/core/link/report.ts";

/** A subject as a stream's pattern reads it: `*` stands for one token. */
const takes = (pattern: string, subject: string) =>
  new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`).test(subject);
const inEvents = (subject: string) => EVENT_SUBJECTS.some((p) => takes(p, subject));

/** An event of rig-a's ledger. */
const event = (o: Partial<ReportEvent> = {}): ReportEvent => ({
  id: 7,
  at: "2026-10-29T03:00:00.000Z",
  actor: "planner",
  kind: "trial_started",
  subject: "t-0123456789abcdef",
  body: { attempt: "a-0123456789abcdef", trial: "t-0123456789abcdef" },
  run: "sort-3",
  ...o,
});

/** A message as the bus hands it over, from an event message: its id among its headers. */
const asRead = (m: {
  subject: string;
  data: string;
  id: string | undefined;
  headers: Record<string, string>;
}) => {
  const headers: Record<string, string> = { ...m.headers };
  if (m.id !== undefined) headers["Nats-Msg-Id"] = m.id;
  return {
    subject: m.subject,
    data: new TextEncoder().encode(m.data),
    header: (k: string) => headers[k],
  };
};

describe("the events stream's contract", () => {
  test("a run's event goes on its run's subject by kind; a queue change, by what it did", () => {
    assert.equal(eventSubject("rig-a", event(), true), "thermite.run.sort-3.ev.trial_started");
    assert.equal(
      eventSubject("rig-a", event({ kind: "experiment_added" }), true),
      "thermite.run.sort-3.queue.added",
    );
    // The attempt's and trial's ids stay in the event: the subject names only the run and kind.
    assert.ok(!eventSubject("rig-a", event(), true).includes("t-0123456789abcdef"));
  });

  test("anything else goes on the rig's own subject by kind", () => {
    const own = "thermite.rig.rig-a.ev.trial_started";
    // No run; a run the registry gives another rig; a run named before goal 170.
    assert.equal(eventSubject("rig-a", event({ run: null }), true), own);
    assert.equal(eventSubject("rig-a", event({ run: undefined }), true), own);
    assert.equal(eventSubject("rig-a", event(), false), own);
    assert.equal(eventSubject("rig-a", event({ run: "Sort.3" }), true), own);
    // A queue change there keeps its whole kind.
    assert.equal(
      eventSubject("rig-a", event({ kind: "experiment_moved" }), false),
      "thermite.rig.rig-a.ev.experiment_moved",
    );
  });

  test("a name a subject can't hold is refused in words", () => {
    for (const rig of ["rig.a", "*", ">", "Rig-A", ""])
      assert.throws(
        () => eventSubject(rig, event(), true),
        /^Error: not a rig's name for an event subject/,
        rig,
      );
    for (const kind of ["trial.started", "trial_*", ">", "", "Trial", "a b", "x".repeat(65)])
      assert.throws(
        () => eventSubject("rig-a", event({ kind }), true),
        /^Error: not an event kind a subject can hold: .* \(a kind is up to 64 of a-z, 0-9 and _/,
        kind,
      );
  });

  test("every kind a ledger records maps to a subject the stream takes, by run and by rig", () => {
    const queue = new Set(QUEUE_OPS.map((op) => `experiment_${op}`));
    for (const kind of EVENT_KINDS) {
      const run = eventSubject("rig-a", event({ kind }), true);
      const rig = eventSubject("rig-a", event({ kind }), false);
      assert.ok(inEvents(run) && inEvents(rig), kind);
      assert.equal(rig, `thermite.rig.rig-a.ev.${kind}`);
      const op = kind.slice("experiment_".length);
      assert.equal(
        run,
        queue.has(kind) ? `thermite.run.sort-3.queue.${op}` : `thermite.run.sort-3.ev.${kind}`,
      );
    }
    // Each queue op is a kind the ledger records, and every experiment_ kind is a queue op.
    for (const k of queue) assert.ok((EVENT_KINDS as readonly string[]).includes(k), k);
    for (const k of EVENT_KINDS.filter((k) => k.startsWith("experiment_")))
      assert.ok(queue.has(k), k);
  });

  test("the stream's subjects are its own: no other stream takes one of them", () => {
    const others = [
      REPORT_STREAM_CONFIG,
      COMMAND_STREAM_CONFIG,
      LIVE_STREAM_CONFIG,
      CONFIG_STREAM_CONFIG,
    ].flatMap((s) => s.subjects);
    for (const s of [
      "thermite.run.sort-3.ev.trial_started",
      "thermite.run.sort-3.queue.added",
      "thermite.rig.rig-a.ev.dev_run",
    ]) {
      assert.ok(inEvents(s), s);
      assert.ok(!others.some((p) => takes(p, s)), s);
    }
    for (const s of [
      "thermite.rig.rig-a.report",
      "thermite.rig.rig-a.cmd",
      "thermite.run.sort-3.live.planner",
      "thermite.rig.rig-a.config.model-route",
    ])
      assert.ok(!inEvents(s), s);
  });

  test("a message: its id, its headers, and the event as the rig recorded it", () => {
    const m = eventMessage({
      rig: "rig-a",
      ledger: "4f1c2e3a-9b8d-4c7e-a6f5-0e1d2c3b4a59",
      event: event(),
      runIsTheRigs: true,
      report: "4f1c2e3a-9b8d-4c7e-a6f5-0e1d2c3b4a59:0-7",
    });
    assert.equal(m.subject, "thermite.run.sort-3.ev.trial_started");
    assert.equal(m.id, "rig-a:4f1c2e3a-9b8d-4c7e-a6f5-0e1d2c3b4a59:7");
    assert.equal(m.id, eventMessageId("rig-a", "4f1c2e3a-9b8d-4c7e-a6f5-0e1d2c3b4a59", 7));
    assert.deepEqual(m.headers, {
      "Thermite-Rig": "rig-a",
      "Thermite-Ledger": "4f1c2e3a-9b8d-4c7e-a6f5-0e1d2c3b4a59",
      "Thermite-Report": "4f1c2e3a-9b8d-4c7e-a6f5-0e1d2c3b4a59:0-7",
    });
    // Canonical JSON: keys sorted, no space; the run null when the event names none.
    assert.equal(m.data, canonicalJson(event()));
    assert.equal(m.data.indexOf('"actor"'), 1);
    const own = eventMessage({
      rig: "rig-a",
      ledger: "l-1",
      event: event({ run: undefined, body: undefined }),
      runIsTheRigs: true,
      seq: 41,
    });
    assert.deepEqual(JSON.parse(own.data), { ...event(), run: null, body: {} });
    assert.equal(own.headers[EVENT_HEADERS.seq], "41");
    assert.equal(own.headers[EVENT_HEADERS.report], undefined);
    // A row control copies from its table carries its place there, and no id.
    assert.equal(own.id, undefined);
  });

  test("a message's ledger, page and seq must be ones a header holds", () => {
    const o = { rig: "rig-a", ledger: "l-1", event: event(), runIsTheRigs: true };
    for (const ledger of ["", "l 1", "l:1", "l\n1", "x".repeat(129)])
      assert.throws(() => eventMessage({ ...o, ledger }), /^Error: not a ledger's id/, ledger);
    for (const report of ["", "p\r\n1"])
      assert.throws(() => eventMessage({ ...o, report }), /^Error: not a report's id/);
    for (const seq of [0, -1, 1.5, Number.NaN])
      assert.throws(() => eventMessage({ ...o, seq }), /^Error: not a place in control's events/);
  });

  test("a message read back gives its event, rig, ledger, page and seq", () => {
    const sent = eventMessage({
      rig: "rig-a",
      ledger: "l-1",
      event: event(),
      runIsTheRigs: false,
      report: "l-1:0-7",
      seq: 3,
    });
    assert.deepEqual(readEventMessage(asRead(sent)), {
      rig: "rig-a",
      ledger: "l-1",
      report: "l-1:0-7",
      seq: 3,
      event: event(),
      unknown: 0,
    });
    // A field this build does not know is dropped and counted (owner's decision 6).
    const newer = { ...sent, data: JSON.stringify({ ...JSON.parse(sent.data), lane: 2 }) };
    const read = readEventMessage(asRead(newer));
    assert.equal(read.unknown, 1);
    assert.equal("lane" in read.event, false);
  });

  test("a message whose headers and data disagree is refused, saying which", () => {
    const sent = eventMessage({ rig: "rig-a", ledger: "l-1", event: event(), runIsTheRigs: true });
    const refused = (m: typeof sent, why: RegExp) =>
      assert.throws(() => readEventMessage(asRead(m)), why);
    const h = sent.headers;
    refused({ ...sent, headers: { ...h, "Thermite-Rig": "" } }, /Thermite-Rig names no rig/);
    refused(
      { ...sent, headers: { ...h, "Thermite-Rig": "rig-b" } },
      /its id .* is not that of event 7/,
    );
    refused(
      { ...sent, headers: { ...h, "Thermite-Ledger": "l-2" } },
      /its id .* is not that of event 7/,
    );
    refused(
      { ...sent, headers: { ...h, "Thermite-Ledger": "a b" } },
      /Thermite-Ledger names no ledger/,
    );
    refused({ ...sent, id: "rig-a:l-1:8" }, /its id "rig-a:l-1:8" is not that of event 7/);
    refused({ ...sent, data: canonicalJson(event({ id: 8 })) }, /is not that of event 8/);
    refused(
      { ...sent, subject: "thermite.run.sort-4.ev.trial_started" },
      /not the subject of a trial_started event of rig rig-a/,
    );
    refused(
      { ...sent, data: canonicalJson(event({ kind: "dev_run" })) },
      /not the subject of a dev_run event/,
    );
    refused(
      { ...sent, headers: { ...h, "Thermite-Seq": "07" } },
      /Thermite-Seq is not a place: "07"/,
    );
    refused({ ...sent, headers: { ...h, "Thermite-Seq": "0" } }, /Thermite-Seq is not a place/);
    // An id or a seq, one at least: a row copied from control's table has its seq and no id.
    refused({ ...sent, id: undefined }, /it has neither an id nor a seq/);
    const copied = { ...sent, id: undefined, headers: { ...h, "Thermite-Seq": "12" } };
    assert.equal(readEventMessage(asRead(copied)).seq, 12);
    // The rig's own subject is the event's too, for a run the registry gives another rig.
    const own = { ...sent, subject: "thermite.rig.rig-a.ev.trial_started" };
    assert.equal(readEventMessage(asRead(own)).event.id, 7);
    // Data that is not an event at all.
    assert.throws(() => readEventMessage(asRead({ ...sent, data: "{}" })), /ZodError|invalid/i);
    assert.throws(() => readEventMessage(asRead({ ...sent, data: "not json" })), SyntaxError);
  });

  test("the largest message is the largest report's: an event a report on the bus carried fits", () => {
    assert.equal(EVENT_MAX_BYTES, REPORT_MAX_BYTES);
    assert.ok(eventFits(EVENT_MAX_BYTES - 4096));
    assert.ok(!eventFits(EVENT_MAX_BYTES - 4095));
    // Its headers, the longest a rig's name and a ledger's id make, fit in the room kept.
    const m = eventMessage({
      rig: "r".repeat(40),
      ledger: "l".repeat(128),
      event: event({ id: Number.MAX_SAFE_INTEGER }),
      runIsTheRigs: true,
      report: `${"l".repeat(128)}:${Number.MAX_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`,
      seq: Number.MAX_SAFE_INTEGER,
    });
    const batch = {
      "Nats-Batch-Id": "u".repeat(36),
      "Nats-Batch-Sequence": "1000",
      "Nats-Batch-Commit": "1",
    };
    // An id and a seq both, and the stream's last place a batch's first message expects.
    const id = eventMessageId("r".repeat(40), "l".repeat(128), Number.MAX_SAFE_INTEGER);
    const expects = { "Nats-Expected-Last-Sequence": String(Number.MAX_SAFE_INTEGER) };
    const bytes = Object.entries({ ...m.headers, ...batch, ...expects, "Nats-Msg-Id": id }).reduce(
      (n, [k, v]) => n + k.length + v.length + 4,
      12,
    );
    assert.ok(bytes < 4096, `${bytes} bytes of headers`);
  });

  test("the stream keeps every event for good, compressed, and takes a page as one batch", () => {
    const s = EVENT_STREAM_CONFIG;
    assert.equal(s.name, EVENT_STREAM);
    assert.deepEqual(s.subjects, EVENT_SUBJECTS);
    assert.equal(s.storage, "file");
    assert.equal(s.retention, "limits");
    assert.deepEqual(
      [s.max_msgs, s.max_bytes, s.max_age, s.max_msgs_per_subject],
      [-1, -1, 0, -1],
      "no limit on count, bytes or age",
    );
    assert.equal(s.discard, "new", "a full store refuses new events, never drops old ones");
    assert.equal(s.deny_delete, true);
    assert.equal(s.deny_purge, true);
    assert.equal(s.duplicate_window, 2 * 60 * 1e9);
    assert.equal(s.allow_atomic, true);
    assert.equal(s.allow_direct, true);
    assert.equal(s.compression, "s2");
    assert.equal(s.max_msg_size, EVENT_MAX_BYTES);
  });
});

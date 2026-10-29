import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInfo } from "../../src/common/build-info.ts";
import type { Bus, BusMessage } from "../../src/common/bus/index.ts";
import { foldReport, followReports, type Intake } from "../../src/control/ingest.ts";
import {
  REPORT_CONSUMER,
  REPORT_CONSUMER_CONFIG,
  REPORT_STREAM,
  REPORT_STREAM_CONFIG,
  reportMessageId,
  reportSubject,
} from "../../src/core/link/report.ts";
import { buildHeaders } from "../../src/core/version.ts";
import { busOf, controlStore, heldEvents } from "../helpers/control-store.ts";
import { FakeBus } from "../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

/** Control's store and what taking reports needs, with rig-a and rig-b given tokens. */
function intake(): Intake {
  const store = controlStore();
  store.enrollments.setConfiguredRigs(["rig-a", "rig-b"]);
  return { store, control: buildInfo(), requireKeyAcceptance: false };
}

let seq = 0;
/** A report as it comes off the bus: on `subject`, with the supervisor's build in its headers. */
function message(report: unknown, subject = reportSubject("rig-a")): BusMessage {
  const h = buildHeaders(buildInfo());
  return {
    subject,
    seq: ++seq,
    data: new TextEncoder().encode(JSON.stringify(report)),
    header: (name) => h[name],
  };
}

/** A harness of rig-a with `n` events, and its signed pages. */
function harness(n: number) {
  const env = makeHarnessEnv("rig-a");
  for (let i = 0; i < n; i++) appendOther(env.service.ledger, "t", "step", null, { i });
  const page = (cursor: number, limit: number) =>
    env.service.snapshot(cursor, limit) as {
      ledger_id: string;
      cursor: number;
      next: number;
      events: unknown[];
      generated_at: string;
    };
  return { env, page };
}

const kinds = async (t: Intake, rig = "rig-a") =>
  (await heldEvents(t.store, rig)).map((e) => e.kind);
const refusals = (t: Intake) =>
  t.store.auditLog
    .list(50)
    .filter((a) => a.action === "report_refused")
    .map((a) => (a.body as { reason: string }).reason);

describe("control folds rigs' reports from the message bus", () => {
  test("a stream of reports is folded through the ingest checks, each message acked", async () => {
    const t = intake();
    const { page } = harness(25);
    const pages = [page(0, 10), page(10, 10), page(20, 10)];
    const acked: number[] = [];
    let followed: { stream?: string; consumer?: string } = {};
    // The bus as followReports sees it: each message handed over in order, and acked after.
    const bus: Pick<Bus, "follow"> = {
      async follow(stream, consumer, handle) {
        const name = typeof stream === "string" ? stream : stream.name;
        followed = {
          stream: name,
          consumer: typeof consumer === "string" ? consumer : consumer.durable_name,
        };
        for (const p of pages) {
          const m = message(p);
          await handle(m);
          acked.push(m.seq);
        }
      },
    };
    await followReports(bus, t);
    assert.deepEqual(followed, { stream: REPORT_STREAM, consumer: REPORT_CONSUMER });
    assert.equal(acked.length, 3);
    assert.equal((await kinds(t)).length, 25);
    // The first report pinned the rig's key, and the supervisor's build came with the message.
    assert.ok(t.store.reportedRigs.key("rig-a").pubkey);
    assert.equal(t.store.builds.ofRig("rig-a", "supervisor")?.version, buildInfo().version);
    assert.equal(t.store.builds.ofRig("rig-a", "harness")?.version, buildInfo().version);
    assert.equal(t.store.reportedRigs.list()[0]?.last_cursor, 25);
  });

  test("a page the bus hands twice is skipped, and so is an older one", async () => {
    const t = intake();
    const { env, page } = harness(10);
    const first = page(0, 10);
    assert.deepEqual(await foldReport(t, message(first)), { folded: 10 });
    assert.deepEqual(await foldReport(t, message(first)), { skipped: "taken already" });
    // A newer report with nothing new is taken: it says the rig is alive.
    await new Promise((r) => setTimeout(r, 5));
    const alive = page(10, 10);
    assert.deepEqual(await foldReport(t, message(alive)), { folded: 0 });
    // The first page again, after a newer one was taken: skipped, never refused as old.
    assert.deepEqual(await foldReport(t, message(first)), { skipped: "taken already" });
    // A page that brings new events after a skip is folded.
    appendOther(env.service.ledger, "t", "late", null, {});
    assert.deepEqual(await foldReport(t, message(page(10, 10))), { folded: 1 });
    assert.equal((await kinds(t)).length, 11);
    assert.deepEqual(refusals(t), []);
  });

  test("a gap is refused and recorded as over HTTP, and the pages after it still fold", async () => {
    const t = intake();
    const { page } = harness(25);
    assert.deepEqual(await foldReport(t, message(page(0, 10))), { folded: 10 });
    const ahead = page(20, 10);
    assert.deepEqual(await foldReport(t, message(ahead)), { refused: "a gap in the event stream" });
    assert.deepEqual(refusals(t), ["a gap in the event stream"]);
    assert.equal((await kinds(t)).length, 10);
    // The page that closes the gap, from where control is, folds; then the one after it.
    assert.deepEqual(await foldReport(t, message(page(10, 10))), { folded: 10 });
    assert.deepEqual(await foldReport(t, message(page(20, 10))), { folded: 5 });
    assert.equal((await kinds(t)).length, 25);
  });

  test("a report whose signed rig is not the subject's rig is refused", async () => {
    const t = intake();
    const { page } = harness(3);
    const forRigA = page(0, 10);
    // Published on rig-b's subject: the signature says rig-a, so nothing is taken for either.
    const refused = await foldReport(t, message(forRigA, reportSubject("rig-b")));
    assert.deepEqual(refused, { refused: "rig mismatch" });
    assert.deepEqual(await kinds(t, "rig-a"), []);
    assert.deepEqual(await kinds(t, "rig-b"), []);
    assert.equal(t.store.reportedRigs.key("rig-b").pubkey, null, "no key is pinned for rig-b");
    // Its own subject takes it.
    assert.deepEqual(await foldReport(t, message(forRigA)), { folded: 3 });
  });

  test("a subject or rig control does not know, a retired rig and a forged report are refused", async () => {
    const t = intake();
    const { page } = harness(2);
    const report = page(0, 10);
    const refusedFor = async (m: BusMessage) =>
      ((await foldReport(t, m)) as { refused?: string }).refused;
    assert.equal(
      await refusedFor(message(report, "thermite.rig.rig-a.cmd")),
      "not a rig's report subject",
    );
    assert.equal(
      await refusedFor(message(report, reportSubject("rig-c"))),
      "no such rig: control has no token for it",
    );
    const notJson = { ...message(report), data: new TextEncoder().encode("{") };
    assert.equal(await refusedFor(notJson), "not a report");
    assert.equal(await refusedFor(message({ ...report, events: "none" })), "not a report");
    const forged = { ...report, next: report.next + 1 };
    assert.equal(await refusedFor(message(forged)), "bad report signature");
    const { signature: _s, ...unsigned } = report as typeof report & { signature: string };
    assert.equal(await refusedFor(message(unsigned)), "unsigned report");
    t.store.retired.add("rig-a", "owner:test");
    assert.equal(await refusedFor(message(report)), "this rig is retired in control");
    assert.deepEqual(await kinds(t), []);
  });

  test("a rig whose supervisor control cannot work with is refused, and its calls counted", async () => {
    const t = intake();
    const { page } = harness(2);
    // Its supervisor said so on a call over HTTP: it works with protocol 99 or later only.
    const newer = { version: "9.0.0", commit: null, protocol: 99, oldest_protocol: 99 };
    t.store.builds.setRig("rig-a", "supervisor", newer);
    const refused = ((await foldReport(t, message(page(0, 10)))) as { refused?: string }).refused;
    assert.match(refused ?? "", /^Control cannot work with this rig: its supervisor works with/);
    assert.equal(t.store.refusals.get("rig-a")?.calls, 1);
    assert.deepEqual(await kinds(t), []);
  });
});

describe("the reports stream is an inbox", () => {
  /** The reports stream as step 0 of goal 168 made it: every report kept for good. */
  const KEPT_FOR_GOOD = {
    ...REPORT_STREAM_CONFIG,
    description: "Every rig's signed reports, kept for good",
    retention: "limits",
    deny_delete: true,
    deny_purge: true,
  } as const;

  /** A report published as the supervisor publishes it: by its message id, with its build. */
  const publish = (bus: FakeBus, report: Parameters<typeof reportMessageId>[0]) =>
    bus.publish(reportSubject("rig-a"), JSON.stringify(report), {
      id: reportMessageId(report),
      headers: buildHeaders(buildInfo()),
    });
  const held = async (bus: FakeBus) => (await bus.streams([REPORT_STREAM]))[0]?.messages;

  test("a page taken or refused for good is gone; one refused for now is handed again, first", async () => {
    const t = intake();
    const { page } = harness(30);
    const bus = new FakeBus();
    await bus.makeStream(REPORT_STREAM_CONFIG);
    await publish(bus, page(0, 10));
    await followReports(bus, t);
    assert.equal(await held(bus), 0, "taken, and gone");
    assert.equal((await kinds(t)).length, 10);

    // A gap: refused for good, recorded as over HTTP, and gone from the stream.
    await publish(bus, page(25, 5));
    await followReports(bus, t);
    assert.equal(await held(bus), 0, "refused for good, and gone");
    assert.deepEqual(refusals(t), ["a gap in the event stream"]);

    // The events stream's store is full: the next page is refused for now and stays, before the
    // page after it; both are taken once the store has room.
    busOf(t.store).bus.full = true;
    await publish(bus, page(10, 10));
    await publish(bus, page(20, 10));
    await followReports(bus, t);
    await followReports(bus, t);
    assert.equal(await held(bus), 2, "handed again, and kept until taken");
    assert.equal((await kinds(t)).length, 10);
    busOf(t.store).bus.full = false;
    await followReports(bus, t);
    assert.equal(await held(bus), 0);
    assert.equal((await kinds(t)).length, 30);
    assert.deepEqual(refusals(t), ["a gap in the event stream"], "nothing else refused");
  });

  test("a stream kept for good is emptied by control's consumer first, then made again as an inbox", async () => {
    const t = intake();
    const { env, page } = harness(30);
    const bus = new FakeBus();
    // The control before this one followed the stream as step 0 made it, and took the first page.
    await bus.makeStream(KEPT_FOR_GOOD);
    await publish(bus, page(0, 10));
    await followReports({ follow: (_s, c, h) => bus.follow(KEPT_FOR_GOOD, c, h) }, t);
    await publish(bus, page(10, 10));
    await publish(bus, page(20, 10));
    assert.equal(await held(bus), 3, "kept for good");
    // Settings the server can't change in place.
    await assert.rejects(bus.makeStream(REPORT_STREAM_CONFIG), /can not change retention policy/);

    // This control: its consumer takes the two pages left, and a page the supervisor publishes
    // meanwhile finds no stream; then the stream is made again as an inbox.
    let meanwhile: unknown;
    const during: Pick<Bus, "follow"> = {
      follow: (s, c, h) =>
        bus.follow(s, c, async (m) => {
          meanwhile ??= await publish(bus, page(20, 10)).catch((err: unknown) => err);
          return await h(m);
        }),
    };
    await followReports(during, t);
    assert.match(
      String(meanwhile),
      /no stream on the bus takes thermite\.rig\.rig-a\.report yet: control makes it/,
    );
    assert.equal(bus.made.get(REPORT_STREAM)?.retention, "workqueue");
    assert.deepEqual(bus.made.get(REPORT_STREAM)?.subjects, REPORT_STREAM_CONFIG.subjects);
    assert.equal(await held(bus), 0, "every page taken; none kept");
    assert.equal((await kinds(t)).length, 30, "the old stream's pages, taken in order");
    assert.deepEqual(refusals(t), []);

    // The supervisor's next page goes into the inbox, and is taken.
    appendOther(env.service.ledger, "t", "late", null, {});
    await publish(bus, page(30, 10));
    await followReports(bus, t);
    assert.equal(await held(bus), 0);
    assert.equal((await kinds(t)).length, 31);
  });

  test("a stream kept for good that holds nothing control has yet to take is made again at once", async () => {
    const t = intake();
    const { page } = harness(5);
    const bus = new FakeBus();
    await bus.makeStream(KEPT_FOR_GOOD);
    await publish(bus, page(0, 10));
    await bus.follow(KEPT_FOR_GOOD, REPORT_CONSUMER_CONFIG, (m) =>
      foldReport(t, m).then(() => undefined),
    );
    assert.equal(await held(bus), 1);
    await followReports(bus, t);
    assert.equal(bus.made.get(REPORT_STREAM)?.retention, "workqueue");
    assert.equal(await held(bus), 0);
    assert.equal((await kinds(t)).length, 5);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Published } from "../../../src/common/bus/index.ts";
import {
  REPORT_MAX_BYTES,
  readReport,
  reportSignedBy,
  reportSubject,
} from "../../../src/core/link/report.ts";
import { BUILD_HEADERS } from "../../../src/core/version.ts";
import {
  type RelayBus,
  RelayError,
  type RelayState,
  relayOnce,
} from "../../../src/supervisor/relay/index.ts";
import { controlStack } from "../../helpers/control-stack.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { appendOther } from "../../helpers/kinds.ts";

/** A stand-in for the NATS server: it keeps each message id once, and can hold back its acks. */
class FakeBus implements RelayBus {
  readonly kept: { subject: string; id: string; data: string; headers: Record<string, string> }[] =
    [];
  /** Set: every publish fails, as when the server's ack never comes. */
  noAck = false;

  async publish(
    subject: string,
    data: string,
    o: { id: string; headers?: Record<string, string> | undefined },
  ): Promise<Published> {
    if (this.noAck) throw new Error("TimeoutError: no ack from the server");
    const at = this.kept.findIndex((m) => m.id === o.id);
    if (at >= 0) return { seq: at + 1, duplicate: true };
    this.kept.push({ subject, id: o.id, data, headers: o.headers ?? {} });
    return { seq: this.kept.length, duplicate: false };
  }

  async request(): Promise<Uint8Array> {
    throw new Error("no one serves control's asks here");
  }
}

/** Control, a rig's harness with `events` events, and the relay's settings for them with `bus`. */
function rig(events: number, bus: RelayBus) {
  const s = controlStack({ env: makeHarnessEnv("rig-a") });
  for (let i = 0; i < events; i++) appendOther(s.env.service.ledger, "t", "step", null, { i });
  // What the relay asked control for: the ingest route must stay out of it on the bus.
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "control") calls.push(url.pathname);
    return s.fetchImpl(input, init);
  };
  return { ...s, calls, cfg: { ...s.cfg, fetchImpl, bus } };
}

describe("the supervisor's reports on the message bus", () => {
  test("each page goes to the rig's subject with its id, and the cursor moves only on an ack", async () => {
    const bus = new FakeBus();
    const s = rig(25, bus);
    const ledger = s.env.service.ledger.ledgerId();
    let state: RelayState = await relayOnce(s.cfg, { cursor: 0, pageLimit: 10 });
    assert.equal(state.cursor, 25);
    assert.deepEqual(
      bus.kept.map((m) => m.id),
      [`${ledger}:0-10`, `${ledger}:10-20`, `${ledger}:20-25`],
    );
    for (const m of bus.kept) {
      assert.equal(m.subject, reportSubject("rig-a"));
      assert.ok(m.headers[BUILD_HEADERS.version], "it carries the supervisor's build");
      // The harness's signed report, as it made it: the supervisor cannot sign or change it.
      const raw = JSON.parse(m.data) as { rig_pubkey: string };
      assert.ok(reportSignedBy(readReport(raw).report, raw.rig_pubkey));
    }
    assert.deepEqual(s.calls, [], "nothing over HTTP to control");

    // The server's ack does not come: the round fails and the cursor stays where it was.
    for (let i = 0; i < 3; i++) appendOther(s.env.service.ledger, "t", "late", null, { i });
    bus.noAck = true;
    const failed = await relayOnce(s.cfg, state).catch((err: unknown) => err);
    assert.ok(failed instanceof RelayError);
    assert.match(failed.message, /no ack/);
    assert.equal(failed.state.cursor, 25);
    bus.noAck = false;
    state = await relayOnce(s.cfg, failed.state);
    assert.equal(state.cursor, 28);
    assert.equal(bus.kept.at(-1)?.id, `${ledger}:25-28`);

    // A page published again is kept once, and the cursor moves on past it.
    state = await relayOnce(s.cfg, { ...state, cursor: 25 });
    assert.equal(state.cursor, 28);
    assert.equal(bus.kept.length, 4);
    // With nothing new, a report still goes, to say the rig is alive: a message of its own.
    await relayOnce(s.cfg, state);
    assert.match(bus.kept.at(-1)?.id ?? "", new RegExp(`^${ledger}:28-28@`));
    assert.deepEqual(JSON.parse(bus.kept.at(-1)?.data ?? "{}").events, []);
  });

  test("a page over the bus's limit is halved, and one event over it stops the round", async () => {
    const bus = new FakeBus();
    // Four events of a quarter of the limit each: two fit in a message, four do not.
    const s = rig(0, bus);
    const quarter = "x".repeat(REPORT_MAX_BYTES / 4);
    for (let i = 0; i < 4; i++) appendOther(s.env.service.ledger, "t", "big", null, { quarter });
    const state = await relayOnce(s.cfg, { cursor: 0 });
    assert.equal(state.cursor, 4);
    assert.equal(state.pageLimit, 2);
    // The second page was full, so the round looked once more and found nothing new.
    assert.deepEqual(
      bus.kept.map((m) => (JSON.parse(m.data) as { events: unknown[] }).events.length),
      [2, 2, 0],
    );
    for (const m of bus.kept) assert.ok(Buffer.byteLength(m.data) < REPORT_MAX_BYTES);

    const huge = "x".repeat(REPORT_MAX_BYTES);
    appendOther(s.env.service.ledger, "t", "huge", null, { huge });
    const failed = await relayOnce(s.cfg, state).catch((err: unknown) => err);
    assert.ok(failed instanceof RelayError);
    assert.match(failed.message, /a report of 1 events is over the bus's 8388608 bytes/);
    assert.equal(failed.state.cursor, 4, "the cursor stays before the event");
    assert.equal(bus.kept.length, 3);
  });
});

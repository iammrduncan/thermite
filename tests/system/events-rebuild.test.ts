import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventsRebuild } from "../../src/control/events/index.ts";
import { streamEvent } from "../../src/control/views/index.ts";
import {
  EVENT_HEADERS,
  EVENT_REBUILD_STREAM,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  eventMessage,
} from "../../src/core/link/events.ts";
import { FakeBus } from "../helpers/fake-bus.ts";

/**
 * The `EVENTS` stream made again once (control/events/rebuild.ts; the owner's decision of
 * 2026-11-01): a stream made before v0.1.1 refuses every purge, which the server never undoes.
 * Copied to EVENTS_REBUILD, checked, deleted, made anew and copied back, each event at its own
 * place with its subject, id, headers, data and the time control first stored it; nothing lost
 * or doubled, and a stop part way goes on from where it was.
 */

/** A bus with an events stream as v0.1.0 made it, holding `n` events of rig-a and rig-b. */
async function oldBus(n: number) {
  const bus = new FakeBus();
  await bus.makeStream({ ...EVENT_STREAM_CONFIG, deny_delete: true, deny_purge: true });
  for (let i = 1; i <= n; i++) {
    const rig = i % 2 ? "rig-a" : "rig-b";
    const m = eventMessage({
      rig,
      ledger: `ledger-${rig}`,
      event: {
        id: i,
        at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
        actor: "harness",
        kind: i % 3 ? "verdict" : "run_created",
        subject: "r-1",
        body: { n: i },
        run: i % 4 ? "r-1" : null,
      },
      runIsTheRigs: true,
      // Some came from control's table of before, with their place there and no id.
      ...(i % 5 === 0 ? { seq: i } : {}),
    });
    await bus.publish(m.subject, m.data, { id: m.id as string, headers: m.headers });
  }
  // As the server stamped each when control first stored it.
  for (const [i, k] of bus.kept.entries())
    k.at = new Date(Date.UTC(2026, 9, 2) + i * 1000).toISOString();
  return bus;
}

/** What the stream holds, place for place, as a reader sees each event. */
async function contents(bus: FakeBus) {
  const r = await bus.read(EVENT_STREAM, { limit: 5000 });
  return r.messages.map((m) => {
    const e = streamEvent(m);
    return {
      seq: m.seq,
      subject: m.subject,
      id: m.header("Nats-Msg-Id") ?? null,
      seqHeader: m.header(EVENT_HEADERS.seq) ?? null,
      rig: e?.read.rig,
      event: e?.read.event.id,
      at: e?.at,
    };
  });
}

describe("the events stream made again once", () => {
  test("every event keeps its place, subject, id, headers and first time; purges work after", async () => {
    const bus = await oldBus(23);
    const before = await contents(bus);
    // The server refuses to let the old stream take purges again; today's settings put on it, as
    // the library puts them over its own, leave it refusing them.
    await assert.rejects(
      bus.makeStream({ ...EVENT_STREAM_CONFIG, deny_delete: false, deny_purge: false }),
      /can not cancel deny message deletes/,
    );
    await assert.rejects(
      bus.makeStream({ ...EVENT_STREAM_CONFIG, deny_delete: true, deny_purge: false }),
      /can not cancel deny purge/,
    );
    await bus.makeStream(EVENT_STREAM_CONFIG);
    assert.ok(bus.made.get(EVENT_STREAM)?.deny_purge, "it refuses purges still");
    await assert.rejects(
      bus.purge(EVENT_STREAM, { filter: "thermite.rig.rig-a.ev.*" }),
      /stream purge not permitted/,
    );
    let deletes = 0;
    const rebuild = new EventsRebuild({
      bus,
      retryMs: 1,
      allowDelete: async (work) => {
        deletes++;
        return await work();
      },
    });
    await rebuild.run();
    assert.equal(rebuild.stopped, null);
    assert.equal(rebuild.done, "rebuilt");
    assert.equal(deletes, 1, "control's user may delete it once, while it makes it again");
    assert.deepEqual(await contents(bus), before, "nothing lost, doubled or moved");
    assert.equal(bus.made.get(EVENT_REBUILD_STREAM), undefined, "the copy is gone");
    const now = bus.made.get(EVENT_STREAM);
    assert.equal(now?.deny_purge, undefined);
    assert.equal(now?.duplicate_window, EVENT_STREAM_CONFIG.duplicate_window);
    // It purges now, and the next event goes on after the last place.
    assert.ok((await bus.purge(EVENT_STREAM, { filter: "thermite.rig.rig-b.ev.*", seq: 10 })) > 0);
    const next = await bus.publish("thermite.rig.rig-a.ev.verdict", "{}", { id: "x" });
    assert.equal(next.seq, 24);
    // Started again on today's stream: nothing to do.
    const again = new EventsRebuild({ bus, retryMs: 1 });
    await again.run();
    assert.equal(again.done, "current");
  });

  test("a stop part way goes on from where it was, copying nothing twice", async () => {
    const bus = await oldBus(2500);
    const before = await contents(bus);
    // The bus goes away after two batches of the copy.
    bus.failAfter = 2;
    const first = new EventsRebuild({ bus, retryMs: 1 });
    const running = first.run();
    await new Promise((r) => setTimeout(r, 30));
    first.close();
    bus.failing = false;
    bus.failAfter = undefined;
    await running;
    assert.ok(bus.made.get(EVENT_REBUILD_STREAM), "the copy, part way");
    assert.ok(bus.made.get(EVENT_STREAM)?.deny_purge, "the stream, not deleted yet");
    const copied = bus.kept.filter((k) => k.stream === EVENT_REBUILD_STREAM).length;
    assert.ok(copied > 0 && copied < 2500, `part of it copied: ${copied}`);
    // Control starts again: the copy goes on after its last place, then the rest as before.
    const second = new EventsRebuild({ bus, retryMs: 1 });
    await second.run();
    assert.equal(second.done, "rebuilt");
    assert.deepEqual(await contents(bus), before);
  });

  test("a place with no message stops it in words, and nothing is deleted", async () => {
    const bus = await oldBus(5);
    // Not what a stream that refuses deletes can hold: here the fake removes one.
    bus.kept.splice(2, 1);
    const rebuild = new EventsRebuild({ bus, retryMs: 1 });
    await rebuild.run();
    assert.match(
      String(rebuild.stopped),
      /holds 4 messages from place 1 to 5: a place holds no message/,
    );
    assert.ok(bus.made.get(EVENT_STREAM)?.deny_purge, "the stream stays as it was");
  });

  test("a bus with no events stream yet has nothing to make again", async () => {
    const rebuild = new EventsRebuild({ bus: new FakeBus(), retryMs: 1 });
    await rebuild.run();
    assert.equal(rebuild.done, "none");
  });
});

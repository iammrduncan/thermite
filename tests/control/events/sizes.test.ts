import assert from "node:assert/strict";
import { test } from "node:test";
import type { BusMessage } from "../../../src/common/bus/index.ts";
import { EVENT_SIZES_WINDOW_MS, EventSizes } from "../../../src/control/events/index.ts";
import { eventKindOfSubject } from "../../../src/core/link/events.ts";

/** The events' sizes by kind over the last hour (goal 179), as control's apply hands them on. */

const message = (
  seq: number,
  subject: string,
  bytes: number,
  at: number,
  rig = "rig-a",
): BusMessage => ({
  seq,
  subject,
  data: new Uint8Array(bytes),
  at: new Date(at).toISOString(),
  header: (k) => (k === "Thermite-Rig" ? rig : undefined),
});

test("an event's kind from its subject: a run's, a queue change's and a rig's own", () => {
  assert.equal(eventKindOfSubject("thermite.run.r1.ev.trial_finished"), "trial_finished");
  assert.equal(eventKindOfSubject("thermite.run.r1.queue.added"), "experiment_added");
  assert.equal(eventKindOfSubject("thermite.rig.rig-a.ev.model_call"), "model_call");
  assert.equal(eventKindOfSubject("thermite.rig.rig-a.report"), undefined);
});

test("each kind's events, bytes and largest of the last hour; older messages are not counted", () => {
  const now = Date.parse("2026-11-02T04:00:00Z");
  const sizes = new EventSizes();
  sizes.take(
    [
      message(1, "thermite.run.r1.ev.trial_finished", 400, now - 10_000, "rig-a"),
      message(2, "thermite.run.r1.ev.trial_finished", 900, now - 5_000, "rig-b"),
      message(3, "thermite.rig.rig-a.ev.model_call", 50, now - 1_000),
      // Stored before the window: control read it at its start, and it is not counted.
      message(4, "thermite.rig.rig-a.ev.model_call", 5000, now - EVENT_SIZES_WINDOW_MS - 1),
    ],
    now,
  );
  const list = sizes.list(now);
  assert.deepEqual(
    list.map((k) => [k.kind, k.events, k.bytes, k.largest, k.largest_rig, k.largest_seq]),
    [
      ["trial_finished", 2, 1300, 900, "rig-b", 2],
      ["model_call", 1, 50, 50, "rig-a", 3],
    ],
  );
  // An hour later, all of it is out of the window.
  assert.deepEqual(sizes.list(now + EVENT_SIZES_WINDOW_MS + 60_000), []);
});

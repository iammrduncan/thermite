import assert from "node:assert/strict";
import { test } from "node:test";
import { BadInput } from "../../../src/common/errors.ts";
import {
  STREAM_LOOKUPS_MAX,
  streamMessage,
  streamPage,
  subjectFilter,
} from "../../../src/control/system/index.ts";
import { EVENT_STREAM_CONFIG } from "../../../src/core/link/events.ts";
import { REPORT_STREAM_CONFIG } from "../../../src/core/link/report.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * Metrics' stream inspector (goal 179): a stream's messages newest first, a page at a time, by
 * subject, read with the server's message lookup alone, so a work queue reads as any stream and
 * nothing is handed, acked or removed.
 */

async function events(
  n: number,
  subject = (i: number) => `thermite.run.r${i % 3}.ev.trial_finished`,
) {
  const bus = new FakeBus();
  await bus.makeStream(EVENT_STREAM_CONFIG);
  for (let i = 1; i <= n; i++)
    await bus.publish(subject(i), JSON.stringify({ i }), {
      id: `e-${i}`,
      headers: { "Thermite-Rig": "rig-a" },
    });
  return bus;
}

test("the newest page first, then older pages to the stream's start, and newer back", async () => {
  const bus = await events(60);
  const first = await streamPage(bus, "EVENTS", {}, 25);
  assert.deepEqual(first.messages.map((m) => m.seq).slice(0, 3), [60, 59, 58]);
  assert.equal(first.messages.length, 25);
  assert.equal(first.newer, null, "the newest page has no newer");
  assert.equal(first.older, 36);
  const second = await streamPage(bus, "EVENTS", { before: first.older ?? 0 }, 25);
  assert.deepEqual([second.messages[0]?.seq, second.messages.at(-1)?.seq], [35, 11]);
  const last = await streamPage(bus, "EVENTS", { before: second.older ?? 0 }, 25);
  assert.deepEqual(
    last.messages.map((m) => m.seq),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  );
  assert.equal(last.older, null, "the stream's start: no older page");
  const back = await streamPage(bus, "EVENTS", { after: last.messages[0]?.seq ?? 0 }, 25);
  assert.deepEqual([back.messages[0]?.seq, back.messages.at(-1)?.seq], [35, 11]);
  assert.equal(back.newer, 35);
  // Each row: its subject, size, headers and the start of its text, never its data.
  const row = first.messages[0];
  assert.equal(row?.subject, "thermite.run.r0.ev.trial_finished");
  assert.equal(row?.preview, '{"i":60}');
  assert.equal(row?.headers["Thermite-Rig"], "rig-a");
  assert.equal("data" in (row ?? {}), false);
});

test("a subject filter reads back in wider windows, and finds sparse messages", async () => {
  // One run's events in 300: every 50th.
  const bus = await events(300, (i) =>
    i % 50 === 0 ? "thermite.run.rare.ev.x" : "thermite.run.r1.ev.y",
  );
  const p = await streamPage(bus, "EVENTS", { subject: "thermite.run.rare.>" }, 25);
  assert.deepEqual(
    p.messages.map((m) => m.seq),
    [300, 250, 200, 150, 100, 50],
  );
  assert.equal(p.older, null);
  const star = await streamPage(bus, "EVENTS", { subject: "thermite.run.*.ev.x" }, 2);
  assert.deepEqual(
    star.messages.map((m) => m.seq),
    [300, 250],
  );
  assert.equal(star.older, 250);
});

test("a work queue's gaps are passed over, and reading it removes nothing", async () => {
  const bus = new FakeBus();
  await bus.makeStream(REPORT_STREAM_CONFIG);
  for (let i = 1; i <= 40; i++)
    await bus.publish(`thermite.rig.rig-${i % 2 ? "a" : "b"}.report`, "{}", { id: `r-${i}` });
  // Control took all but three: the places between are gone.
  for (let i = 1; i <= 40; i++)
    if (![7, 21, 39].includes(i))
      await bus.remove("REPORTS", `thermite.rig.rig-${i % 2 ? "a" : "b"}.report`, `r-${i}`);
  const p = await streamPage(bus, "REPORTS", {}, 25);
  assert.deepEqual(
    p.messages.map((m) => m.seq),
    [39, 21, 7],
  );
  assert.equal((await streamPage(bus, "REPORTS", {}, 25)).messages.length, 3, "nothing was taken");
});

test("a page that would need too many lookups stops at its last whole window, and says so", async () => {
  const bus = await events(STREAM_LOOKUPS_MAX + 200, (i) =>
    i === 1 ? "thermite.run.first.ev.x" : "thermite.run.r1.ev.y",
  );
  const p = await streamPage(bus, "EVENTS", {}, STREAM_LOOKUPS_MAX + 100);
  assert.ok(p.cut);
  assert.ok(p.older !== null, "Older goes on from where it stopped");
  const sorted = p.messages.map((m) => m.seq);
  assert.deepEqual(
    sorted,
    [...sorted].sort((a, b) => b - a),
  );
  // No gap: the places it shows run without a hole down to where it stopped.
  assert.equal((sorted[0] ?? 0) - (sorted.at(-1) ?? 0) + 1, sorted.length);
});

test("one message whole; a place it has not, a stream control does not make, a bad subject", async () => {
  const bus = await events(3);
  const m = await streamMessage(bus, "EVENTS", 2);
  assert.equal(new TextDecoder().decode(m?.data), '{"i":2}');
  assert.equal(await streamMessage(bus, "EVENTS", 99), undefined);
  await assert.rejects(streamPage(bus, "OTHER", {}), BadInput);
  await assert.rejects(streamMessage(bus, "EVENTS", 0), BadInput);
  assert.equal(subjectFilter(""), ">");
  assert.equal(subjectFilter(" thermite.rig.*.ev.> "), "thermite.rig.*.ev.>");
  assert.throws(() => subjectFilter("thermite.>.ev"), BadInput);
  assert.throws(() => subjectFilter("a b"), BadInput);
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  dueAt,
  dueNow,
  firstRunWords,
  nextDueAt,
  packItems,
  type RetentionItem,
  RetentionRule,
  RetentionSpec,
  removeWords,
  SPACE_ITEMS_MAX,
  unpackItems,
  wouldRemove,
} from "../../src/core/retention/index.ts";

/**
 * The one function that says what a retention policy removes (core/retention/), and when a
 * policy is due: every rule, every keep, each group, the size rule, and the schedule's once for
 * each due time.
 */

const NOW = new Date("2026-11-01T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** An item on `rig`, of `run`, `days` old. */
const item = (
  id: string,
  days: number,
  o: Partial<RetentionItem> & { bytes?: number } = {},
): RetentionItem => ({
  id,
  rig: "rig-1",
  run: "r-1",
  at: ago(days),
  bytes: 100,
  count: 1,
  ...o,
});

const rule = (o: Record<string, unknown>) => RetentionRule.parse({ kind: "builds", ...o });
const ids = (items: RetentionItem[]) => items.map((x) => x.id).sort();

describe("what a policy removes", () => {
  test("older than: by age, in days, weeks or months (30 days)", () => {
    const items = [item("a", 1), item("b", 8), item("c", 31), item("d", 400)];
    assert.deepEqual(ids(wouldRemove(rule({ rule: "older", older_n: 7 }), items, NOW).items), [
      "b",
      "c",
      "d",
    ]);
    const weeks = rule({ rule: "older", older_n: 2, older_unit: "weeks" });
    assert.deepEqual(ids(wouldRemove(weeks, items, NOW).items), ["c", "d"]);
    const months = rule({ rule: "older", older_n: 1, older_unit: "months" });
    assert.deepEqual(ids(wouldRemove(months, items, NOW).items), ["c", "d"]);
    assert.equal(wouldRemove(rule({ rule: "older", older_n: 1000 }), items, NOW).count, 0);
  });

  test("beyond the newest: per rig, per run, or in all", () => {
    const items = [
      item("a1", 1, { rig: "rig-a", run: "r-1" }),
      item("a2", 2, { rig: "rig-a", run: "r-2" }),
      item("a3", 3, { rig: "rig-a", run: "r-2" }),
      item("b1", 4, { rig: "rig-b", run: "r-1" }),
      item("b2", 5, { rig: "rig-b", run: "r-1" }),
    ];
    const perRig = rule({ rule: "newest", newest_n: 1, newest_per: "rig" });
    assert.deepEqual(ids(wouldRemove(perRig, items, NOW).items), ["a2", "a3", "b2"]);
    const perRun = rule({ rule: "newest", newest_n: 1, newest_per: "run" });
    // r-1's newest is a1 (on either rig), r-2's is a2.
    assert.deepEqual(ids(wouldRemove(perRun, items, NOW).items), ["a3", "b1", "b2"]);
    const inAll = rule({ rule: "newest", newest_n: 2, newest_per: "all" });
    assert.deepEqual(ids(wouldRemove(inAll, items, NOW).items), ["a3", "b1", "b2"]);
    // A kind kept on control has one group, whatever per says.
    const control = RetentionRule.parse({
      kind: "audit",
      rule: "newest",
      newest_n: 2,
      newest_per: "rig",
    });
    assert.deepEqual(ids(wouldRemove(control, items, NOW).items), ["a3", "b1", "b2"]);
  });

  test("over a size: the oldest go first until what is left fits, passing over what it keeps", () => {
    const gib = 2 ** 30;
    const items = [
      item("new", 1, { bytes: gib }),
      item("mid", 5, { bytes: gib, open: true }),
      item("old", 9, { bytes: gib }),
      item("oldest", 20, { bytes: gib }),
    ];
    const r = wouldRemove(rule({ rule: "size", size_gib: 2 }), items, NOW);
    // 4 GiB, under 2 wanted: oldest, old go; mid is kept (its run is open), so new stays too.
    assert.deepEqual(ids(r.items), ["old", "oldest"]);
    assert.equal(r.bytes, 2 * gib);
    const noKeep = rule({ rule: "size", size_gib: 1, keep: { open: false } });
    assert.deepEqual(ids(wouldRemove(noKeep, items, NOW).items), ["mid", "old", "oldest"]);
    assert.equal(wouldRemove(rule({ rule: "size", size_gib: 10 }), items, NOW).count, 0);
  });

  test("always keep: runs still open, champions' builds, the newest copy; each only where the kind has it", () => {
    const items = [
      item("open", 50, { open: true }),
      item("champ", 50, { champion: true }),
      item("plain", 50),
    ];
    const all = rule({ rule: "older", older_n: 1 });
    assert.deepEqual(ids(wouldRemove(all, items, NOW).items), ["plain"]);
    const none = rule({ rule: "older", older_n: 1, keep: { open: false, champions: false } });
    assert.deepEqual(ids(wouldRemove(none, items, NOW).items), ["champ", "open", "plain"]);
    // The advisors' records keep runs still open, and have no champions to keep.
    const records = RetentionRule.parse({ kind: "advisor_records", rule: "older", older_n: 1 });
    assert.deepEqual(ids(wouldRemove(records, items, NOW).items), ["champ", "plain"]);
    // The store's copies keep their newest, whatever its age.
    const copies = [item("c1", 40), item("c2", 30), item("c3", 20)];
    const copyRule = RetentionRule.parse({ kind: "store_copies", rule: "older", older_n: 1 });
    assert.deepEqual(ids(wouldRemove(copyRule, copies, NOW).items), ["c1", "c2"]);
    const noNewest = RetentionRule.parse({
      kind: "store_copies",
      rule: "older",
      older_n: 1,
      keep: { newest: false },
    });
    assert.deepEqual(ids(wouldRemove(noNewest, copies, NOW).items), ["c1", "c2", "c3"]);
  });

  test("what it removes is counted, summed and dated, in words", () => {
    const items = [
      item("a", 10, { rig: "rig-a", bytes: 1024 }),
      item("b", 20, { rig: "rig-b", bytes: 2048, count: 3 }),
    ];
    const r = wouldRemove(rule({ rule: "older", older_n: 1 }), items, NOW);
    assert.equal(r.count, 4);
    assert.equal(r.bytes, 3072);
    assert.equal(r.rigs, 2);
    assert.equal(r.oldest, ago(20));
    assert.equal(r.newest, ago(10));
    assert.equal(
      removeWords("builds", r),
      "4 builds on 2 rigs, 3.0 KiB, from 2026-10-12 to 2026-10-22",
    );
    assert.equal(removeWords("builds", wouldRemove(rule({ rule: "older" }), [], NOW)), "nothing");
  });

  test("a design is checked: a name, a known kind, numbers in range, a time of day", () => {
    assert.equal(RetentionSpec.safeParse({ kind: "builds", rule: "older" }).success, false);
    assert.equal(
      RetentionSpec.safeParse({ name: "x", kind: "ledgers", rule: "older" }).success,
      false,
      "no policy removes a rig's ledger",
    );
    assert.equal(
      RetentionSpec.safeParse({ name: "x", kind: "builds", rule: "older", older_n: 0 }).success,
      false,
    );
    assert.equal(
      RetentionSpec.safeParse({ name: "x", kind: "builds", rule: "older", time: "25:00" }).success,
      false,
    );
    const p = RetentionSpec.parse({ name: " Old builds ", kind: "builds", rule: "older" });
    assert.equal(p.name, "Old builds");
    assert.deepEqual(p.keep, { open: true, champions: true, newest: true }, "keeps on by default");
    assert.equal(p.when, "daily");
    assert.equal(p.time, "03:00");
  });
});

describe("when a policy runs", () => {
  const daily = { when: "daily" as const, time: "03:00", day: "sunday" as const };
  const weekly = { when: "weekly" as const, time: "03:00", day: "sunday" as const };

  test("its latest due time and its next, in UTC", () => {
    // 2026-11-01 is a Sunday.
    assert.equal(dueAt(daily, NOW)?.toISOString(), "2026-11-01T03:00:00.000Z");
    assert.equal(
      dueAt(daily, new Date("2026-11-01T02:59:00Z"))?.toISOString(),
      "2026-10-31T03:00:00.000Z",
    );
    assert.equal(nextDueAt(daily, NOW)?.toISOString(), "2026-11-02T03:00:00.000Z");
    assert.equal(dueAt(weekly, NOW)?.toISOString(), "2026-11-01T03:00:00.000Z");
    assert.equal(
      dueAt(weekly, new Date("2026-11-01T02:00:00Z"))?.toISOString(),
      "2026-10-25T03:00:00.000Z",
    );
    assert.equal(
      dueAt({ ...weekly, day: "wednesday" }, NOW)?.toISOString(),
      "2026-10-28T03:00:00.000Z",
    );
    assert.equal(nextDueAt(weekly, NOW)?.toISOString(), "2026-11-08T03:00:00.000Z");
    assert.equal(dueAt({ ...daily, when: "hand" }, NOW), null);
  });

  test("once for each due time, never before it was turned on, never while off", () => {
    const on = { ...daily, on: true, on_since: "2026-10-01T00:00:00Z", last_due: null };
    assert.equal(dueNow(on, NOW)?.toISOString(), "2026-11-01T03:00:00.000Z");
    // It ran for that time: not again, at any moment before the next.
    const ran = { ...on, last_due: "2026-11-01T03:00:00.000Z" };
    assert.equal(dueNow(ran, NOW), null);
    assert.equal(dueNow(ran, new Date("2026-11-02T02:59:59Z")), null);
    assert.equal(
      dueNow(ran, new Date("2026-11-02T03:00:00Z"))?.toISOString(),
      "2026-11-02T03:00:00.000Z",
    );
    // Control away for three days: once, for the latest time it missed.
    assert.equal(
      dueNow(ran, new Date("2026-11-04T09:00:00Z"))?.toISOString(),
      "2026-11-04T03:00:00.000Z",
    );
    // Turned on after today's time: tomorrow's is its first.
    const late = { ...on, on_since: "2026-11-01T10:00:00Z" };
    assert.equal(dueNow(late, NOW), null);
    assert.equal(
      dueNow(late, new Date("2026-11-02T03:00:00Z"))?.toISOString(),
      "2026-11-02T03:00:00.000Z",
    );
    assert.equal(dueNow({ ...on, on: false, on_since: null }, NOW), null);
    assert.equal(dueNow({ ...on, when: "hand" }, NOW), null);
  });

  test("when it first runs, in the form's words", () => {
    assert.equal(
      firstRunWords(daily, new Date("2026-11-01T01:00:00Z")),
      "Turned on, it first runs today at 03:00 UTC.",
    );
    assert.equal(firstRunWords(daily, NOW), "Turned on, it first runs tomorrow at 03:00 UTC.");
    assert.equal(
      firstRunWords(weekly, NOW),
      "Turned on, it first runs on Sunday 2026-11-08 at 03:00 UTC.",
    );
    assert.equal(
      firstRunWords({ ...daily, when: "hand" }, NOW),
      "Turned on, it still runs only when you press Run now.",
    );
  });
});

describe("a rig's report of its kinds", () => {
  test("items pack and unpack with their run, time, bytes and flags", () => {
    const items = [
      item("a", 1, { run: "r-1", open: true, bytes: 10 }),
      item("b", 2, { run: null, champion: true, bytes: 20 }),
      item("c", 3, { run: "r-2", bytes: 30 }),
    ];
    const packed = packItems(items);
    assert.equal(packed.bytes, 60);
    assert.deepEqual(packed.runs, ["r-1", "r-2"]);
    const back = unpackItems("rig-9", packed);
    assert.deepEqual(
      back.map((x) => [x.rig, x.run, x.bytes, x.open, x.champion, x.at.slice(0, 16)]),
      items.map((x) => [
        "rig-9",
        x.run,
        x.bytes,
        x.open === true,
        x.champion === true,
        x.at.slice(0, 16),
      ]),
    );
  });

  test("past the most it reports one by one, the oldest go in groups by run and day, bytes whole", () => {
    const many: RetentionItem[] = [];
    for (let i = 0; i < SPACE_ITEMS_MAX + 30; i++)
      many.push(
        item(`x${i}`, i < SPACE_ITEMS_MAX ? 0 : 400 + (i % 3), {
          bytes: 1,
          run: i % 2 ? "r-1" : "r-2",
        }),
      );
    const packed = packItems(many);
    assert.equal(packed.bytes, many.length);
    // The newest, one by one, then the 30 oldest in one group for each run and day: 6 groups.
    assert.equal(packed.items.length, SPACE_ITEMS_MAX + 6);
    const back = unpackItems("rig-1", packed);
    assert.equal(
      back.reduce((n, x) => n + x.count, 0),
      many.length,
    );
    assert.equal(
      back.reduce((n, x) => n + x.bytes, 0),
      many.length,
    );
  });
});

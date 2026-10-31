import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type SnapshotJob,
  Snapshotter,
  snapshotWaits,
} from "../../../../src/harness/broker/snapshot/index.ts";

/**
 * When the broker takes a snapshot (Snapshotter): one at a time, again after a failure, every few
 * minutes, not while a timed run is at work, and last at a stop.
 */

describe("when snapshots are taken (Snapshotter)", () => {
  /** A take that ends when told, and records its reasons. */
  function takes() {
    const reasons: string[] = [];
    const ends: ((ok: boolean) => void)[] = [];
    let aborted = 0;
    const take = (reason: string): SnapshotJob => {
      reasons.push(reason);
      let end: (ok: boolean) => void = () => undefined;
      const done = new Promise<boolean>((r) => {
        end = r;
      });
      ends.push(end);
      return {
        done,
        abort: () => {
          aborted++;
          end(false);
        },
      };
    };
    return { reasons, ends, take, aborted: () => aborted };
  }
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  test("one at a time; a request meanwhile is taken after it", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 3_600_000 });
    s.request("after enrollment");
    s.request("after an export");
    s.request("after an export");
    assert.deepEqual(t.reasons, ["after enrollment"]);
    t.ends[0]?.(true);
    await tick();
    assert.deepEqual(t.reasons, ["after enrollment", "after an export"]);
    t.ends[1]?.(true);
    await tick();
    assert.equal(t.reasons.length, 2);
  });

  test("a failed snapshot is tried again", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 3_600_000, retryMs: 30 });
    s.request("after an export");
    t.ends[0]?.(false);
    await tick(80);
    assert.deepEqual(t.reasons, ["after an export", "again, after a failure"]);
    t.ends[1]?.(true);
    await tick(80);
    assert.equal(t.reasons.length, 2, "not again once it worked");
  });

  test("every few minutes", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 40 });
    s.start();
    await tick(60);
    assert.deepEqual(t.reasons, ["every 0.04 seconds"]);
    t.ends[0]?.(true);
    await tick(60);
    assert.ok(t.reasons.length >= 2);
    await s.stop(10);
  });

  test("it waits while a timed run is at work, up to a limit", async () => {
    const t = takes();
    let busy = true;
    const s = new Snapshotter({
      take: t.take,
      everyMs: 3_600_000,
      busy: () => busy,
      pollMs: 10,
      deferMs: 10_000,
    });
    s.request("after an export");
    await tick(50);
    assert.deepEqual(t.reasons, [], "not while the judge times");
    busy = false;
    await tick(50);
    assert.deepEqual(t.reasons, ["after an export"]);
    t.ends[0]?.(true);
    // Busy for longer than it may wait: taken all the same.
    busy = true;
    const s2 = new Snapshotter({
      take: t.take,
      everyMs: 3_600_000,
      busy: () => busy,
      pollMs: 10,
      deferMs: 40,
    });
    s2.request("every 5 minutes");
    await tick(120);
    assert.deepEqual(t.reasons, ["after an export", "every 5 minutes"]);
  });

  test("at a stop: the one under way ends, then the last one; out of time, it is ended", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 3_600_000 });
    s.request("after an export");
    const stopped = s.stop(1000);
    s.request("after an export");
    await tick();
    assert.deepEqual(t.reasons, ["after an export"], "no new one but the stop's");
    t.ends[0]?.(true);
    await tick();
    assert.deepEqual(t.reasons, ["after an export", "at the stop"]);
    t.ends[1]?.(true);
    assert.equal(await stopped, "taken");

    const slow = takes();
    const s2 = new Snapshotter({ take: slow.take, everyMs: 3_600_000 });
    assert.equal(await s2.stop(30), "out of time");
    assert.equal(slow.aborted(), 1);
  });
});

describe("a snapshot at the rig's disk floor (goal 173)", () => {
  const GIB = 2 ** 30;
  test("it waits while its folder has less free space than the floor, and says why", () => {
    const free = (gib: number) => () => ({ free: gib * GIB, total: 100 * GIB });
    assert.equal(snapshotWaits("/snap", 5 * GIB, free(20)), undefined);
    assert.equal(
      snapshotWaits("/snap", 5 * GIB, free(3)),
      "the snapshot's folder has 3 GiB free, below the rig's disk floor of 5 GiB (THERMITE_DISK_FLOOR_GIB)",
    );
    // No floor; a folder it can't read (the snapshot itself then says what failed).
    assert.equal(snapshotWaits("/snap", 0, free(0)), undefined);
    const unreadable = () => {
      throw new Error("ENOENT");
    };
    assert.equal(snapshotWaits("/snap", 5 * GIB, unreadable), undefined);
  });
});

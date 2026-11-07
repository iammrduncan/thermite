import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GpuClock,
  RunnerClock,
  WaitTotals,
  whose,
} from "../../../src/harness/judge/runner-time.ts";

/**
 * Goal 231: how a runner spent its time, counted by the core at each change: held by the judge's
 * job, by each lane's run, free, or away; who waited for a runner, and how long; and its GPU's
 * use between its checks' reads.
 */

const T = Date.parse("2026-11-07T08:00:00Z");
const min = (n: number) => T + n * 60_000;

describe("a runner's time (goal 231)", () => {
  test("holds, frees and a time away add up to the runner's time, each to whom it went", () => {
    const c = new RunnerClock(T);
    // Free for 5 minutes, the judge's for 30, lane-2's for 10, away for 3, then free.
    c.tally({ up: true, holder: undefined }, min(5));
    c.tally({ up: true, holder: "executor-box-2-0" }, min(35));
    c.tally({ up: true, holder: "lane-2" }, min(45));
    c.tally({ up: false, holder: undefined }, min(48));
    const t = c.totals({ up: true, holder: undefined }, min(60));
    assert.deepEqual(t, {
      since: "2026-11-07T08:00:00.000Z",
      judge_ms: 30 * 60_000,
      lanes_ms: { "lane-2": 10 * 60_000 },
      free_ms: (5 + 12) * 60_000,
      away_ms: 3 * 60_000,
    });
    // Its totals count the time since its last change as what it does now, and keep none of it.
    const free = { up: true, holder: undefined };
    assert.equal(c.totals(free, min(70)).free_ms, (5 + 22) * 60_000);
    assert.equal(c.totals(free, min(60)).free_ms, (5 + 12) * 60_000);
    // Taken by lane-1 at 70: the free time until then is kept as free, and lane-1's begins.
    c.tally(free, min(70));
    const later = c.totals({ up: true, holder: "lane-1" }, min(75));
    assert.equal(later.free_ms, (5 + 22) * 60_000);
    assert.deepEqual(later.lanes_ms, { "lane-2": 10 * 60_000, "lane-1": 5 * 60_000 });
  });

  test("who waited: the judge's executors together, each lane on its own, the open waits up to now", () => {
    assert.equal(whose("executor-box-2-1"), "judge");
    assert.equal(whose("lane-3"), "lane-3");
    const w = new WaitTotals();
    w.end("executor-box-2-0", min(0), min(4));
    w.end("executor-box-2-1", min(10), min(12));
    w.end("lane-1", min(20), min(21));
    assert.deepEqual(w.totals([{ who: "lane-1", since: min(30) }], min(33)), {
      judge: { count: 2, ms: 6 * 60_000 },
      "lane-1": { count: 2, ms: 4 * 60_000 },
    });
  });

  test("a GPU's use between reads counts at their mean; a gap longer than three checks counts for nothing", () => {
    const g = new GpuClock(45_000);
    assert.equal(g.totals(), undefined, "not read yet");
    const at = (s: number) => T + s * 1000;
    g.saw({ util_pct: 0, mem_used_mib: null, mem_total_mib: null }, at(0));
    g.saw({ util_pct: 100, mem_used_mib: null, mem_total_mib: null }, at(15));
    g.saw({ util_pct: 100, mem_used_mib: null, mem_total_mib: null }, at(30));
    // The judge measured here for 10 minutes: not read, and that time counts for nothing.
    g.saw({ util_pct: 20, mem_used_mib: 9000, mem_total_mib: 16384 }, at(630));
    assert.deepEqual(g.totals(), {
      util_pct: 20,
      mem_used_mib: 9000,
      mem_total_mib: 16384,
      at: "2026-11-07T08:10:30.000Z",
      // 15 s at a mean of 50%, then 15 s at 100%.
      busy_ms: 7500 + 15_000,
      read_ms: 30_000,
    });
  });
});

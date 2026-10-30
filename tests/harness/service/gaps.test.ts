import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { AwakeWatch, GAP_MIN_MS, gapAtStart, gapSpans } from "../../../src/harness/service/gaps.ts";
import { appendOther } from "../../helpers/kinds.ts";

const T0 = Date.parse("2026-10-28T16:00:00.000Z");
const min = (m: number) => T0 + m * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A ledger whose events are written at the time `now` says. */
function ledgerAt() {
  let now = T0;
  const path = join(mkdtempSync(join(tmpdir(), "thermite-gaps-")), "ledger.db");
  const ledger = Ledger.open(path, () => new Date(now));
  const setNow = (ms: number) => {
    now = ms;
  };
  return { ledger, setNow };
}

describe("time the harness did not run", () => {
  test("the awake loop records a jump in its time as a gap, and nothing shorter", () => {
    const { ledger, setNow } = ledgerAt();
    const awake = new AwakeWatch(ledger, T0);
    // Its rounds come every few seconds: no gap.
    assert.equal(awake.note(T0 + 10_000), false);
    assert.equal(awake.note(T0 + 20_000), false);
    // A busy moment just short of the shortest gap: still running time.
    assert.equal(awake.note(T0 + 20_000 + GAP_MIN_MS - 1), false);
    assert.deepEqual(gapSpans(ledger), []);
    // The host sleeps for three and a half hours: the next round finds the time jumped.
    const since = T0 + 20_000 + GAP_MIN_MS - 1;
    const woke = min(240);
    setNow(woke);
    assert.equal(awake.note(woke), true);
    assert.deepEqual(gapSpans(ledger), [[since, woke]]);
    const e = ledger.events.newest("harness_gap");
    assert.deepEqual(e?.body, { since: iso(since), until: iso(woke), restarted: false });
    assert.equal(e?.subject, null, "a gap is the rig's, not one run's");
    // The rounds go on from there.
    assert.equal(awake.note(woke + 10_000), false);
    assert.equal(gapSpans(ledger).length, 1);
  });

  test("at start, the time since the newest event is a gap when it is long enough", () => {
    const { ledger, setNow } = ledgerAt();
    assert.equal(gapAtStart(ledger, min(600)), false, "an empty ledger: nothing ran before");
    appendOther(ledger, "t", "trial_started", "r-1", {});
    // A quick restart: running time.
    assert.equal(gapAtStart(ledger, T0 + GAP_MIN_MS - 1), false);
    assert.deepEqual(gapSpans(ledger), []);
    // Stopped overnight: the gap runs from the newest event to the start.
    setNow(min(600));
    assert.equal(gapAtStart(ledger, min(600)), true);
    assert.deepEqual(gapSpans(ledger), [[T0, min(600)]]);
    assert.deepEqual(ledger.events.newest("harness_gap")?.body, {
      since: iso(T0),
      until: iso(min(600)),
      restarted: true,
    });
  });
});

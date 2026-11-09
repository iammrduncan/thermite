import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeWaits } from "../../../src/control/run-lists.ts";
import { passedOverWords } from "../../../src/control/ui/operator/run.ts";

/**
 * The jobs the judge passes over for the confirmations and screens it takes first (goal 238):
 * each kind that waits with how many and since when, the longest waiting first, and the run's
 * page naming those of other kinds that have waited an hour or more.
 */

const job = (kind: string, run: string, queued_at: string) => ({ kind, run, queued_at });

test("a run's judge jobs that wait, by kind, the longest waiting first; another run's left out", () => {
  const u = {
    judge: {
      queued: [
        job("evaluate", "r-1", "2026-11-08T09:33:00.000Z"),
        job("parent_screen", "r-1", "2026-11-07T09:00:00.000Z"),
        job("parent_screen", "r-1", "2026-11-07T08:11:34.000Z"),
        job("calibrate", "r-1", "2026-11-08T08:04:33.000Z"),
        job("evaluate", "r-2", "2026-11-01T00:00:00.000Z"),
      ],
    },
  };
  assert.deepEqual(judgeWaits(u, "r-1"), [
    { kind: "parent_screen", count: 2, since: "2026-11-07T08:11:34.000Z" },
    { kind: "calibrate", count: 1, since: "2026-11-08T08:04:33.000Z" },
    { kind: "evaluate", count: 1, since: "2026-11-08T09:33:00.000Z" },
  ]);
  const now = Date.parse("2026-11-08T23:00:00.000Z");
  assert.equal(
    passedOverWords(u, "r-1", now),
    "2 parent screens have waited since 2026-11-07 08:11 UTC, and 1 calibration has waited since 2026-11-08 08:04 UTC: the judge takes the confirmations and screens first.",
  );
  // Screens that wait are the queue itself, and a job that waited less than an hour is not named.
  const fresh = { judge: { queued: [job("calibrate", "r-1", "2026-11-08T22:30:00.000Z")] } };
  assert.equal(passedOverWords(fresh, "r-1", now), "");
  assert.equal(passedOverWords(u, "r-2", now), "");
});

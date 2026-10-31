import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { doingsOf, workOf } from "../../../src/control/views/work.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import { ev, researchControl, researchRunEvents } from "../../helpers/research-reviews.ts";

/**
 * Goal 143: what each lane's trial is doing reaches get_run's and run_queue's at_work, from the
 * rig's report: when it last sent a line, its open model call and a streak of the same calls.
 */

const open = (trial: string, lane: string, more: Record<string, unknown> = {}) => ({
  trial,
  run: "s-1",
  lane,
  started_at: "2026-10-25T15:08:21.000Z",
  task: null,
  question: null,
  turns: 3,
  tool_calls: 5,
  tokens_in: 41_000,
  claims: 0,
  refused_again: null,
  ...more,
});

const QUIET = {
  last_line_at: "2026-10-25T15:08:24.000Z",
  reply: {
    since: "2026-10-25T15:09:00.000Z",
    text: 0,
    thinking: 1840,
    tool_args: 1_200_000,
    reported_at: "2026-10-25T19:32:00.000Z",
  },
  repeating: null,
};
const LOOP = {
  last_line_at: "2026-10-25T19:26:29.000Z",
  reply: null,
  repeating: {
    count: 812,
    since: "2026-10-25T19:04:13.000Z",
    different: 11,
    calls: [{ call: 'search_files {"text":"blockage"}', times: 148 }],
  },
};

describe("what each lane's trial is doing, in at_work (goal 143)", () => {
  test("get_run and run_queue give it with each lane's trial", async () => {
    const c = await researchControl();
    const events = [
      ...researchRunEvents(),
      ev("trial_started", { trial: "t-1", lane: "lane-1", family: "contradict", focus: "f1" }),
      ev("trial_started", { trial: "t-2", lane: "lane-2", family: "contradict", focus: "f2" }),
    ];
    await c.ingest(events);
    await ingestReport(c.store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: events.length,
      next: events.length,
      events: [],
      summary: {
        work: {
          trials: 2,
          judge_jobs: 0,
          draining: null,
          open: [open("t-1", "lane-1", LOOP), open("t-2", "lane-2", QUIET)],
        },
      },
    });
    const run = (await c.mcp("get_run", { run: "s-1" })) as {
      at_work: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(run.at_work["lane-2"], {
      trial: "t-2",
      family: "contradict",
      focus: "f2",
      since: run.at_work["lane-2"]?.since,
      ...QUIET,
      refused_again: null,
    });
    assert.deepEqual(run.at_work["lane-1"]?.repeating, LOOP.repeating);
    const queue = (await c.mcp("run_queue", { run: "s-1" })) as {
      at_work: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(queue.at_work["lane-2"]?.reply, QUIET.reply);
  });

  test("an older harness's report says nothing of it; a bad report reads as none", () => {
    const older = {
      work: { trials: 1, judge_jobs: 0, draining: null, open: [open("t-1", "lane-1")] },
    };
    assert.equal(workOf(older)?.open?.length, 1);
    // A harness from goal 136 says only a refused page asked for again.
    assert.deepEqual(doingsOf(older).get("t-1"), { refused_again: null });
    assert.equal(workOf({ work: { trials: "two" } }), undefined);
    assert.equal(doingsOf(null).size, 0);
  });
});

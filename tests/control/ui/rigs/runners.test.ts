import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  runnersBlock,
  runnersFields,
  runnersWanted,
} from "../../../../src/control/ui/rigs/runners.ts";
import type { RigView } from "../../../../src/control/views/index.ts";
import { readRunners } from "../../../../src/control/views/report.ts";
import type { RigSettings } from "../../../../src/core/rig-settings.ts";

/**
 * Goal 206, step 4: a rig's runners of other machines in control. Its core reports them; the
 * rig's page shows each runner, its pool, whether it answers and what it runs now, and who waits;
 * Edit rig changes their pools, takes one away or adds one, as the rig's `runners` setting.
 */

const reported = {
  processes: [
    {
      name: "box-2",
      pools: ["judge", "shared"],
      up: true,
      answered_at: "2026-11-04T19:59:50Z",
      away_since: null,
      runners: [
        { name: "box-2-0", pool: "judge", holder: "executor-box-2-0" },
        { name: "box-2-1", pool: "shared", holder: "lane-2" },
      ],
    },
    {
      name: "box-3",
      pools: ["lane-1"],
      up: false,
      why: "the runner box-3 stopped answering",
      answered_at: "2026-11-04T19:50:00Z",
      away_since: "2026-11-04T19:57:00Z",
      runners: [{ name: "box-3-0", pool: "lane-1", holder: null }],
    },
  ],
  waiting: ["lane-1", "executor-box-2-0", "lane-1"],
};

const view = (runners: unknown) =>
  ({
    id: "rig-a",
    runners: readRunners(runners),
    judge: {
      now: null,
      running: [
        {
          id: "7",
          kind: "evaluate",
          attempt: "a-9cd0123456789abc",
          run: "r-1",
          by: "executor-box-2-0",
          queued_at: "2026-11-04T19:58:00Z",
          started_at: "2026-11-04T19:58:10Z",
          finished_at: null,
          state: "running",
          result: {},
        },
      ],
      queued: [],
      jobs: [],
    },
    runs: [],
  }) as unknown as RigView;

const settings = {
  lanes: 2,
  runners: [
    { name: "box-2", pools: ["judge", "shared"] },
    { name: "box-3", pools: ["lane-1"] },
  ],
} as unknown as RigSettings;

describe("a rig's runners in control (goal 206)", () => {
  test("its report is read loosely; a rig without runners has none", () => {
    assert.equal(readRunners(undefined), null);
    assert.equal(readRunners({ processes: [] }), null);
    const r = readRunners(reported);
    assert.equal(r?.processes.length, 2);
    assert.equal(r?.processes[1]?.why, "the runner box-3 stopped answering");
    assert.deepEqual(r?.waiting, ["lane-1", "executor-box-2-0", "lane-1"]);
  });

  test("the rig's page: each runner, its pool, whether it answers, what it runs, and who waits", () => {
    assert.equal(runnersBlock(view(undefined), Date.now()), "");
    const html = runnersBlock(view(reported), Date.parse("2026-11-04T20:00:00Z"));
    assert.match(html, /<h2>Runners<\/h2><span class="n">3<\/span>/);
    assert.match(html, /box-2-0[\s\S]*the judge's[\s\S]*answers[\s\S]*The judge: /);
    assert.match(html, /Lane 2's run_experiment\. It never counts\./);
    assert.match(html, /away 3m[\s\S]*the runner box-3 stopped answering; its run was tried again/);
    assert.match(html, /Waiting for a runner:<\/b> lane 1's run_experiment, the judge\./);
    assert.match(html, /href="\/ui\/rigs\/rig-a\/edit#where"/);
  });

  test("Edit rig: each runner's pool, Take it away, and one added by its name", () => {
    const html = runnersFields(view(reported), settings);
    assert.match(html, /name="runner_pool__box-2__0"[^>]*>[\s\S]*value="judge" selected/);
    assert.match(html, /name="runner_pool__box-3__0"[\s\S]*value="lane-1" selected/);
    assert.match(html, /name="runner_remove__box-3"/);
    assert.match(html, /name="runner_add_name"/);
    // The form as it comes back: box-2's second runner moved to lane 2's pool, box-3 taken
    // away, and box-4 added with two runners.
    assert.deepEqual(
      runnersWanted(settings, {
        runner_pool__box_2__0: "ignored: not this form's name",
        "runner_pool__box-2__1": "lane-2",
        "runner_remove__box-3": "1",
        runner_add_name: " box-4 ",
        runner_add_pools: "judge, shared",
      }),
      [
        { name: "box-2", pools: ["judge", "lane-2"] },
        { name: "box-4", pools: ["judge", "shared"] },
      ],
    );
    assert.deepEqual(runnersWanted(settings, {}), settings.runners, "nothing asked: as it is");
  });
});

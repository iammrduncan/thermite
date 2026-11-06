import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runnersAdded } from "../../../../src/control/dashboard/rigs/runners.ts";
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
    assert.match(html, /<th scope="col">Its store<\/th>/);
    assert.match(html, /not said yet/);
    // An away runner says where its pool's runs go meanwhile.
    assert.match(
      html,
      /Nothing: lane-1&#39;s runs go to box-2-1 meanwhile, and come back once box-3 answers\.|Nothing: lane-1's runs go to box-2-1 meanwhile, and come back once box-3 answers\./,
    );
    // Who waits, by pool: the judge's jobs, and lane 1 once, whose own runner is away.
    assert.match(html, /<h3>Waiting for a runner<\/h3>/);
    assert.match(
      html,
      /The next free one of box-2-0 and box-2-1 takes the first, in turn with the lanes on box-2-1\./,
    );
    assert.equal(html.match(/Lane 1&#39;s run_experiment|Lane 1's run_experiment/g)?.length, 1);
    assert.match(
      html,
      /Its own box-3-0 is away; it takes the next free one of box-2-1, after lane 2(&#39;|')s run\./,
    );
    assert.match(html, /href="\/ui\/rigs\/rig-a\/edit#where"/);
    // With control's places and the runners' history lines.
    const more = runnersBlock(view(reported), Date.parse("2026-11-04T20:00:00Z"), {
      placed: {
        "box-3": { where: "box · over SSH", gpu: "GPU 0 · NVIDIA GB10", product: "NVIDIA GB10" },
      },
      lines: [
        { at: "2026-11-04T19:20:00Z", ok: true, text: "A runner answered the rig's core: box-3." },
        { at: "2026-11-04T19:57:00Z", ok: false, text: "A runner stopped answering: box-3." },
      ],
    });
    assert.match(
      more,
      /<b>box-3<\/b><br><span class="small muted">GPU 0 · NVIDIA GB10 · box · over SSH<\/span>/,
    );
    assert.match(
      more,
      /the runners(&#39;|')s? lines[\s\S]*19:57<\/span> A runner stopped answering[\s\S]*19:20/,
    );
  });

  test("a runner's store and each wait's start are read from the report", () => {
    const r = readRunners({
      processes: [
        {
          ...reported.processes[0],
          store: { total_gib: 200, free_gib: 160, builds: 3, kits: 1 },
        },
      ],
      waiting: ["lane-1"],
      waits: [{ who: "lane-1", since: "2026-11-04T19:59:20Z" }, { who: 7 }],
    });
    assert.deepEqual(r?.processes[0]?.store, {
      total_gib: 200,
      free_gib: 160,
      builds: 3,
      kits: 1,
    });
    assert.deepEqual(r?.waits, [{ who: "lane-1", since: "2026-11-04T19:59:20Z" }]);
    const html = runnersBlock(
      { ...view(undefined), runners: r } as RigView,
      Date.parse("2026-11-04T20:00:00Z"),
    );
    assert.match(html, /40 of 200 GB used · builds 3 · kits 1/);
    assert.match(html, /Lane 1(&#39;|')s run_experiment, waiting 40s\./);
  });

  test("Edit rig: each runner's pool, Remove, and one added by its name", () => {
    const html = runnersFields(view(reported), settings, {
      placed: {
        "box-3": {
          where: "k8s-a › slot-5",
          gpu: "NVIDIA GB10 · DRA class gb10",
          product: "NVIDIA GB10",
        },
      },
      add: [
        {
          value: "box-9=k8s-a|slot-5||dra%3Agb10",
          text: "box-9 · NVIDIA GB10 · a node of k8s-a",
          product: "NVIDIA GB10",
        },
      ],
      judgeOnRunners: true,
    });
    // Each runner: where it is, whether it answers, its GPU, and Remove, which marks it to leave
    // on Save changes; its row then says what happens to its run. No question of its own.
    assert.match(
      html,
      /<b>box-2<\/b> <span class="chip">started by you<\/span> <span class="chip ok"/,
    );
    assert.match(
      html,
      /<b>box-3<\/b> <span class="chip">k8s-a › slot-5<\/span> <span class="chip bad"/,
    );
    assert.match(html, /NVIDIA GB10 · DRA class gb10/);
    assert.match(
      html,
      /data-leaves="Leaves when you save: the judge(&#39;|')s job goes back to the judge(&#39;|')s queue and starts again on another of its runners; lane 2(&#39;|')s run_experiment stops, and lane 2 is told to run it again\. No verdict is lost/,
    );
    assert.match(html, /data-leaves="Leaves when you save\. Nothing runs there now\."/);
    assert.doesNotMatch(html, /data-ask/);
    assert.match(
      html,
      /<option value="box-9=k8s-a\|slot-5\|\|dra%3Agb10" data-product="NVIDIA GB10">/,
    );
    assert.match(html, /data-judge-on-runners="1"/);
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

  test("Edit rig: each runner added gets the volume Add a runner gives, or the default (goal 213)", () => {
    const sized = runnersAdded({
      runner_new__0: "sp-a=k8s-a|slot-5||dra%3Agb10",
      runner_new_pool__0: "lane-2",
      add_storage_gi: "300",
    });
    assert.deepEqual(
      sized.map((r) => [r.runner, r.pool, r.storageGi]),
      [["sp-a", "lane-2", 300]],
    );
    for (const given of ["", "0", "-5", "1.5", "lots"])
      assert.equal(
        runnersAdded({ runner_new__0: "sp-a=k8s-a|slot-5||dra%3Agb10", add_storage_gi: given })[0]
          ?.storageGi,
        undefined,
        `${JSON.stringify(given)}: the default`,
      );
  });

  test("Edit rig: the runners Add put in the list, and one chosen but not put there", () => {
    const added = runnersAdded({
      runner_new__0: "sp-a=k8s-a|slot-5||dra%3Agb10",
      runner_new_pool__0: "judge",
      runner_new__2: "box-7=@machine|box|1",
      runner_new_pool__2: "lane-1",
      add_at: "sp-a=k8s-a|slot-5||dra%3Agb10",
      add_pool: "shared",
    });
    assert.deepEqual(
      added.map((r) => [r.runner, r.pool, r.mode, r.at.kind]),
      [
        ["sp-a", "judge", "dra:gb10", "cluster"],
        ["box-7", "lane-1", "device-plugin", "machine"],
      ],
      "each name once, the first asked kept",
    );
    assert.deepEqual(runnersAdded({ add_at: "", add_pool: "judge" }), []);
  });
});

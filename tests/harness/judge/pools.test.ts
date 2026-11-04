import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunnerPools } from "../../../src/harness/judge/pools.ts";
import type { LaneRun, RemoteRunner } from "../../../src/harness/judge/remote-runner.ts";

/**
 * Goal 206, step 3a: the runners of a rig's other machines in their pools. A runner takes one run
 * at a time, first come, first served, between the judge and the lanes it serves; a lane takes its
 * own runner before a shared one; a lane's wait ends with its trial; a trial's workspaces go when
 * it ends.
 */

/** A runner whose lane runs end when the test says, and that notes what it was asked. */
function fake(name: string) {
  const said: string[] = [];
  let finish: (() => void) | undefined;
  const runner = {
    name,
    laneRun: async (r: LaneRun) => {
      said.push(`run ${r.lane} ${r.command}`);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ran: true, exit: 0 };
    },
    laneEnd: async (lane: string, trial: string) => {
      said.push(`end ${lane} ${trial}`);
    },
  } as unknown as RemoteRunner;
  return { runner, said, finish: () => finish?.() };
}

const run = (lane: string, command = "make"): LaneRun => ({
  lane,
  trial: "t-0123456789abcdef",
  repo: "seed",
  parent: "a".repeat(40),
  patch: Buffer.alloc(0),
  command,
  limits: { rssMib: 1024, diskMib: 1024 },
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("a rig's runners in their pools (goal 206)", () => {
  test("the judge measures on its own and the shared runners; a lane runs on its own or a shared one", () => {
    const j = fake("box-2-0");
    const s = fake("box-2-1");
    const l = fake("box-3-0");
    const pools = new RunnerPools([
      { runner: j.runner, pool: "judge" },
      { runner: s.runner, pool: "shared" },
      { runner: l.runner, pool: "lane-2" },
    ]);
    assert.deepEqual(
      pools.judges().map((x) => [x.runner.name, x.shared]),
      [
        ["box-2-0", false],
        ["box-2-1", true],
      ],
    );
    assert.equal(pools.serves("lane-2"), true);
    assert.equal(pools.serves("lane-1"), true, "the shared runner serves every lane");
    assert.equal(
      new RunnerPools([{ runner: j.runner, pool: "judge" }]).serves("lane-1"),
      false,
      "a lane no runner serves runs on the core's own machine",
    );
  });

  test("one run at a time on a runner, first come, first served, between the judge and a lane", async () => {
    const s = fake("box-2-0");
    const pools = new RunnerPools([{ runner: s.runner, pool: "shared" }]);
    const releaseJudge = await pools.holdForJudge(s.runner, "executor-box-2-0");
    const lane = pools.laneRun(run("lane-1"));
    await tick();
    assert.deepEqual(s.said, [], "the lane waits while the judge holds the runner");
    assert.equal(pools.busy(s.runner), true);
    releaseJudge();
    await tick();
    assert.deepEqual(s.said, ["run lane-1 make"]);
    // The judge asks again: it waits for the lane's run to end.
    let judgeHeld = false;
    const judge = pools.holdForJudge(s.runner, "executor-box-2-0").then((release) => {
      judgeHeld = true;
      return release;
    });
    await tick();
    assert.equal(judgeHeld, false);
    s.finish();
    assert.deepEqual(await lane, { ran: true, exit: 0, runner: "box-2-0" });
    (await judge)();
    assert.equal(judgeHeld, true);
  });

  test("a lane takes its own runner before a shared one", async () => {
    const shared = fake("box-2-0");
    const own = fake("box-3-0");
    const pools = new RunnerPools([
      { runner: shared.runner, pool: "shared" },
      { runner: own.runner, pool: "lane-2" },
    ]);
    const r = pools.laneRun(run("lane-2"));
    await tick();
    assert.deepEqual(own.said, ["run lane-2 make"]);
    assert.deepEqual(shared.said, []);
    own.finish();
    await r;
  });

  test("a lane's wait ends with its trial, and the trial's workspaces go when it ends", async () => {
    const s = fake("box-2-0");
    const pools = new RunnerPools([{ runner: s.runner, pool: "shared" }]);
    const releaseJudge = await pools.holdForJudge(s.runner, "executor-box-2-0");
    const stop = new AbortController();
    const waiting = pools.laneRun(run("lane-1"), stop.signal);
    stop.abort();
    assert.deepEqual(await waiting, {
      ran: false,
      reason: "the trial ended before a runner was free",
    });
    releaseJudge();
    const ran = pools.laneRun(run("lane-1"));
    await tick();
    s.finish();
    await ran;
    await pools.trialEnded("t-0123456789abcdef");
    assert.deepEqual(s.said, ["run lane-1 make", "end lane-1 t-0123456789abcdef"]);
  });
});

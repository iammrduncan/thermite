import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunnerPools } from "../../../src/harness/judge/pools.ts";
import type { LaneRun, RemoteRunner } from "../../../src/harness/judge/remote-runner.ts";
import { RunnerAway } from "../../../src/harness/judge/runner-link.ts";

/**
 * Goal 206, step 3a: the runners of a rig's other machines in their pools. A runner takes one run
 * at a time, first come, first served, between the judge and the lanes it serves; a lane takes its
 * own runner before the lanes' one (goal 229) and a shared one last; a lane's wait ends with its
 * trial; a trial's workspaces go when it ends. Runners come and go (step 3c): one added takes runs once it is up, one away takes none
 * until it is up again, and one taken away ends the waits for it.
 */

/** A runner whose lane runs end when the test says, and that notes what it was asked. */
function fake(name: string) {
  const said: string[] = [];
  let finish: (() => void) | undefined;
  let away: ((err: Error) => void) | undefined;
  const runner = {
    name,
    laneRun: async (r: LaneRun) => {
      said.push(`run ${r.lane} ${r.command}`);
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        away = reject;
      });
      return { ran: true, exit: 0 };
    },
    laneEnd: async (lane: string, trial: string) => {
      said.push(`end ${lane} ${trial}`);
    },
  } as unknown as RemoteRunner;
  return {
    runner,
    said,
    finish: () => finish?.(),
    /** Its link fails its run under way, as when it leaves the rig. */
    leave: (why: string) => away?.(new RunnerAway(why)),
  };
}

/** Pools with these runners, each up. */
function poolsOf(...runners: [RemoteRunner, string][]): RunnerPools {
  const pools = new RunnerPools();
  for (const [runner, pool] of runners) pools.add(runner, pool as "judge", true);
  return pools;
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
  test("a lane runs on its own runner or a shared one; one no runner serves runs on the core", () => {
    const j = fake("box-2-0");
    const s = fake("box-2-1");
    const l = fake("box-3-0");
    const pools = poolsOf([j.runner, "judge"], [s.runner, "shared"], [l.runner, "lane-2"]);
    assert.equal(pools.serves("lane-2"), true);
    assert.equal(pools.serves("lane-1"), true, "the shared runner serves every lane");
    assert.equal(
      poolsOf([j.runner, "judge"]).serves("lane-1"),
      false,
      "a lane no runner serves runs on the core's own machine",
    );
  });

  test("one run at a time on a runner, first come, first served, between the judge and a lane", async () => {
    const s = fake("box-2-0");
    const pools = poolsOf([s.runner, "shared"]);
    const releaseJudge = await pools.holdForJudge(s.runner, "executor-box-2-0");
    const lane = pools.laneRun(run("lane-1"));
    await tick();
    assert.deepEqual(s.said, [], "the lane waits while the judge holds the runner");
    assert.equal(pools.busy(s.runner), true);
    releaseJudge?.();
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
    // It waited for the judge's job: its answer says how long, in seconds (goal 229).
    const { waited_s, ...answer } = (await lane) as { waited_s?: unknown };
    assert.equal(typeof waited_s, "number");
    assert.deepEqual(answer, { ran: true, exit: 0, runner: "box-2-0" });
    (await judge)?.();
    assert.equal(judgeHeld, true);
  });

  test("a lane takes its own runner before a shared one", async () => {
    const shared = fake("box-2-0");
    const own = fake("box-3-0");
    const pools = poolsOf([shared.runner, "shared"], [own.runner, "lane-2"]);
    const r = pools.laneRun(run("lane-2"));
    await tick();
    assert.deepEqual(own.said, ["run lane-2 make"]);
    assert.deepEqual(shared.said, []);
    own.finish();
    await r;
  });

  test("a lane takes its own runner, then the lanes' one, then a shared one; lanes take turns on the lanes' (goal 229)", async () => {
    const shared = fake("box-2-0");
    const lanes = fake("box-4-0");
    const own = fake("box-3-0");
    const pools = poolsOf(
      [shared.runner, "shared"],
      [lanes.runner, "lanes"],
      [own.runner, "lane-2"],
    );
    assert.equal(pools.serves("lane-5"), true, "the lanes' runner serves every lane");
    assert.equal(poolsOf([lanes.runner, "lanes"]).serves("lane-1"), true);
    const a = pools.laneRun(run("lane-2"));
    const b = pools.laneRun(run("lane-2", "make b"));
    const c = pools.laneRun(run("lane-1", "make c"));
    await tick();
    assert.deepEqual(own.said, ["run lane-2 make"]);
    assert.deepEqual(lanes.said, ["run lane-2 make b"], "its own runner busy: the lanes' one");
    assert.deepEqual(shared.said, ["run lane-1 make c"], "the lanes' busy too: a shared one");
    own.finish();
    lanes.finish();
    shared.finish();
    await Promise.all([a, b, c]);
    // Two lanes with the lanes' runner alone take turns, first come, first served.
    const one = fake("box-4-0");
    const turns = poolsOf([one.runner, "lanes"]);
    const told: string[] = [];
    const first = turns.laneRun(run("lane-1", "make 1"), undefined, (held) => told.push(held));
    const second = turns.laneRun(run("lane-2", "make 2"), undefined, (held) => told.push(held));
    await tick();
    assert.deepEqual(one.said, ["run lane-1 make 1"]);
    assert.deepEqual(turns.waiting(), ["lane-2"]);
    // The one that waits is told who holds its runner, once; the one that ran at once is not.
    assert.deepEqual(told, ["box-4-0: lane-1's run"]);
    one.finish();
    assert.deepEqual(await first, { ran: true, exit: 0, runner: "box-4-0" });
    await tick();
    assert.deepEqual(one.said, ["run lane-1 make 1", "run lane-2 make 2"]);
    one.finish();
    // Its answer says how long it waited, in seconds.
    const answer = (await second) as { runner?: string; waited_s?: unknown };
    assert.equal(answer.runner, "box-4-0");
    assert.equal(typeof answer.waited_s, "number");
  });

  test("a lane's wait ends with its trial, and the trial's workspaces go when it ends", async () => {
    const s = fake("box-2-0");
    const pools = poolsOf([s.runner, "shared"]);
    const releaseJudge = await pools.holdForJudge(s.runner, "executor-box-2-0");
    const stop = new AbortController();
    const before = Date.now();
    const waiting = pools.laneRun(run("lane-1"), stop.signal);
    // The rig's page says who waits, and since when.
    assert.deepEqual(pools.waiting(), ["lane-1"]);
    assert.ok((pools.waits()[0]?.since ?? 0) >= before);
    stop.abort();
    assert.deepEqual(await waiting, {
      ran: false,
      reason: "the trial ended before a runner was free",
    });
    releaseJudge?.();
    const ran = pools.laneRun(run("lane-1"));
    await tick();
    s.finish();
    await ran;
    await pools.trialEnded("t-0123456789abcdef");
    assert.deepEqual(s.said, ["run lane-1 make", "end lane-1 t-0123456789abcdef"]);
  });

  test("a runner added takes runs once it is up; one away takes none until it is up again (3c)", async () => {
    const s = fake("box-2-0");
    const pools = new RunnerPools();
    pools.add(s.runner, "shared");
    assert.equal(pools.serves("lane-1"), true, "a lane's runs go to it, and wait for it");
    const lane = pools.laneRun(run("lane-1"));
    await tick();
    assert.deepEqual(s.said, [], "a run waits while no runner of its pool is up");
    pools.setUp(s.runner, true);
    await tick();
    assert.deepEqual(s.said, ["run lane-1 make"]);
    // It stops answering: its run under way fails through its link, and the lane is told.
    pools.setUp(s.runner, false);
    s.leave("the runner box-2 stopped answering");
    assert.deepEqual(await lane, {
      ran: false,
      reason: "the runner box-2 stopped answering while your command ran: run it again",
    });
    const next = pools.laneRun(run("lane-1", "make again"));
    await tick();
    assert.equal(s.said.length, 1, "nothing goes to a runner away");
    pools.setUp(s.runner, true);
    await tick();
    assert.deepEqual(s.said.at(-1), "run lane-1 make again");
    s.finish();
    await next;
  });

  test("a runner taken away: the waits for it end, and its run under way fails (3c)", async () => {
    const s = fake("box-2-0");
    const own = fake("box-3-0");
    const pools = poolsOf([s.runner, "shared"], [own.runner, "lane-2"]);
    // The judge holds the shared runner; a lane-1 run waits for it.
    const releaseJudge = await pools.holdForJudge(s.runner, "executor-box-2-0");
    const waiting = pools.laneRun(run("lane-1"));
    // lane-2's run runs on its own runner.
    const ownRun = pools.laneRun(run("lane-2"));
    await tick();
    pools.remove(s.runner);
    assert.deepEqual(await waiting, {
      ran: false,
      reason: "no runner serves lane-1 now: run it again, and it runs on the core's machine",
    });
    assert.equal(pools.serves("lane-1"), false);
    assert.equal(
      await pools.holdForJudge(s.runner, "executor-box-2-0"),
      undefined,
      "the judge's executor on it holds nothing",
    );
    releaseJudge?.();
    // lane-2's own runner leaves while its command runs.
    pools.remove(own.runner);
    own.leave("the runner box-3 left the rig");
    assert.deepEqual(await ownRun, {
      ran: false,
      reason: "the runner box-3 left the rig while your command ran: run it again",
    });
    assert.equal(pools.serves("lane-2"), false);
  });

  test("a run whose memory no one set gets the machine's on the lane's own runner or the lanes' (goals 219, 229)", async () => {
    const seen: LaneRun["limits"][] = [];
    const capture = (name: string) =>
      ({
        name,
        laneRun: async (r: LaneRun) => {
          seen.push(r.limits);
          return { ran: true, exit: 0 };
        },
        laneEnd: async () => undefined,
      }) as unknown as RemoteRunner;
    const limits = { rssMib: 4096, diskMib: 1024, rssDefault: true };
    await poolsOf([capture("box-3-0"), "lane-2"]).laneRun({ ...run("lane-2"), limits });
    await poolsOf([capture("box-2-0"), "shared"]).laneRun({ ...run("lane-1"), limits });
    await poolsOf([capture("box-4-0"), "lanes"]).laneRun({ ...run("lane-1"), limits });
    assert.deepEqual(
      seen.map((l) => l.rssDefault),
      [true, false, true],
      "a shared runner, which the judge uses too, keeps the default; the lanes' one, which no judge's job shares, does not",
    );
  });

  test("each runner's time goes to whoever held it, and each wait to whose it was (goal 231)", async () => {
    const s = fake("box-2-0");
    const pools = poolsOf([s.runner, "shared"]);
    const releaseJudge = await pools.holdForJudge(s.runner, "executor-box-2-0");
    const lane = pools.laneRun(run("lane-1"));
    await tick();
    releaseJudge?.();
    await tick();
    s.finish();
    await lane;
    await tick();
    const use = pools.use();
    const t = use.runners["box-2-0"];
    assert.ok(t);
    assert.ok(t.judge_ms > 0, "the judge's job held it first");
    assert.ok((t.lanes_ms["lane-1"] ?? 0) > 0, "then lane-1's run");
    assert.ok(t.free_ms > 0, "and it is free now");
    assert.equal(t.away_ms, 0);
    assert.equal(use.waited.judge, undefined, "the judge never waited");
    assert.equal(use.waited["lane-1"]?.count, 1, "lane-1 waited once, behind the judge's job");
    assert.ok((use.waited["lane-1"]?.ms ?? 0) > 0);
  });

  test("the run's model files begin on the runners that serve lanes, not the judge's (goal 217)", () => {
    const begun: string[] = [];
    const named = (name: string, fails = false) =>
      ({
        name,
        prefetch: async (run: string) => {
          begun.push(`${name} ${run}`);
          if (fails) throw new Error("away");
        },
      }) as unknown as RemoteRunner;
    const failed: string[] = [];
    const pools = new RunnerPools();
    pools.add(named("judge-0"), "judge", true);
    pools.add(named("lane-0"), "lane-1" as never, true);
    pools.add(named("shared-0", true), "shared", true);
    pools.add(named("lanes-0"), "lanes", true);
    pools.add(named("down-0"), "lane-2" as never, false);
    pools.prefetch("r-1", (runner) => failed.push(runner));
    assert.deepEqual(
      begun,
      ["lane-0 r-1", "shared-0 r-1", "lanes-0 r-1"],
      "the lanes' too (goal 229); not the judge's, nor one that is down",
    );
  });
});

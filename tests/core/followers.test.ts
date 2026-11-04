import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { followerGpuEnv, leaderEnv, poolsRefusal } from "../../src/core/followers.ts";
import { followersOf } from "../../src/harness/controller/judges.ts";

/**
 * Goal 205, step 2d: each machine's GPUs in the judge's pool or the workers', as control writes
 * them for the leader's and a follower's harness, and as the leader's harness reads them back.
 */

describe("a rig's pools over its machines (goal 205)", () => {
  test("the leader is told each follower's judge's and workers' GPUs, and its own GPUs' pool", () => {
    const env = leaderEnv(
      [
        { machine: "spark-02", pools: { judge: 1, workers: 0 } },
        { machine: "spark-03", pools: { judge: 0, workers: 1 } },
        { machine: "box-4", pools: { judge: 2, workers: 2 } },
        { machine: "cpu-5", pools: { judge: 0, workers: 0, cpu: "workers" } },
        { machine: "cpu-6", pools: { judge: 0, workers: 0 } },
      ],
      "judge",
    );
    assert.deepEqual(env, {
      THERMITE_FOLLOWERS: "spark-02=1,spark-03=0+1,box-4=2+2,cpu-5=0+1,cpu-6=1",
      THERMITE_LOCAL_LANES: "0",
    });
    // What control writes, the harness reads.
    assert.deepEqual(followersOf(env), [
      { machine: "spark-02", cards: 1, workers: 0 },
      { machine: "spark-03", cards: 0, workers: 1 },
      { machine: "box-4", cards: 2, workers: 2 },
      { machine: "cpu-5", cards: 0, workers: 1 },
      { machine: "cpu-6", cards: 1, workers: 0 },
    ]);
    assert.equal(
      leaderEnv([{ machine: "a-1", pools: { judge: 1, workers: 0 } }], "workers")
        .THERMITE_LOCAL_JUDGE,
      "0",
    );
    assert.deepEqual(leaderEnv([], "judge"), {});
  });

  test("a follower's container numbers the judge's GPUs first, then the workers'", () => {
    assert.deepEqual(followerGpuEnv({ judge: 2, workers: 0 }), { THERMITE_GPU_INDEX: "0,1" });
    assert.deepEqual(followerGpuEnv({ judge: 0, workers: 1 }), { THERMITE_GPU_INDEX: "0" });
    assert.deepEqual(followerGpuEnv({ judge: 1, workers: 2 }), {
      THERMITE_GPU_INDEX: "0",
      THERMITE_DEV_GPU_INDEX: "1,2",
    });
    assert.deepEqual(followerGpuEnv({ judge: 0, workers: 0, cpu: "workers" }), {});
  });

  test("pools that leave the judge or the lanes nowhere are refused in words", () => {
    const judgeOnly = [{ machine: "spark-02", pools: { judge: 1, workers: 0 } }];
    assert.equal(poolsRefusal("shared", judgeOnly), undefined);
    assert.equal(poolsRefusal("workers", judgeOnly), undefined);
    assert.match(String(poolsRefusal("judge", judgeOnly)), /give the workers a follower's GPU/);
    const workersOnly = [{ machine: "spark-03", pools: { judge: 0, workers: 1 } }];
    assert.equal(poolsRefusal("judge", workersOnly), undefined);
    assert.match(String(poolsRefusal("workers", workersOnly)), /give the judge a follower's GPU/);
    assert.match(
      String(poolsRefusal("shared", [{ machine: "box-4", pools: { judge: 0, workers: 2 } }])),
      /box-4 gives the workers 2 GPUs and the judge none/,
    );
  });
});

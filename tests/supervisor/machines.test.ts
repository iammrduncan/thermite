import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CallInput } from "../../src/common/api/call.ts";
import type { HarnessClient } from "../../src/common/api/harness.ts";
import { DEVICE, DEVICE_ASKS } from "../../src/core/api/harness/device.ts";
import type { Route } from "../../src/core/api/route.ts";
import { FollowerLink } from "../../src/harness/judge/link.ts";
import { answerLeaderAsks, carryFollowerAsks } from "../../src/supervisor/machines/index.ts";
import { FakeBus } from "../helpers/fake-bus.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

/**
 * Goal 205, step 1c: the leader's supervisor carries its harness's asks of a follower on the bus,
 * and the follower's supervisor answers each from its harness. A git bundle or an answer larger
 * than one message goes in parts.
 */

describe("a follower reached over the bus (goal 205)", () => {
  test("a run judged on the follower, through both supervisors and the bus", async () => {
    const env = makeJudgeEnv({ follower: "bus" });
    try {
      await env.start();
      const id = (
        await env.service.submitAttempt(
          {
            run: "js-1",
            patch_base64: env.patch(FAST_KERNEL),
            hypothesis: "drop the wasted inner loop",
            known_flaws: [],
          },
          "proposer",
        )
      ).attempt;
      await env.drain();
      const verdicts = env.ledger.db
        .prepare("select verdict from verdict where attempt = ? order by id")
        .all(id)
        .map((r) => r.verdict);
      assert.deepEqual(verdicts, ["win_screened", "win_confirmed"], env.explain(id));
    } finally {
      env.stop();
    }
  });

  /** A leader's link carried on a bus to a follower whose harness answers with `device`. */
  function wired(device: {
    ask?: (body: unknown) => Promise<unknown>;
    git?: (bytes: Uint8Array) => Promise<unknown>;
  }) {
    const bus = new FakeBus();
    const outboxDir = mkdtempSync(join(tmpdir(), "thermite-carry-"));
    const link = new FollowerLink({ outboxDir });
    let stopped = false;
    const leader = {
      call: async (route: Route, input?: CallInput<Route>) =>
        route.path === DEVICE_ASKS.path
          ? { asks: await link.take(50) }
          : { ok: link.answer(String(input?.params?.id), (input?.body ?? {}) as object) },
    } as unknown as HarnessClient;
    const follower = {
      call: async (route: Route, input?: CallInput<Route>) =>
        route.path === DEVICE.path
          ? device.ask?.(input?.body)
          : device.git?.(input?.bytes ?? new Uint8Array()),
    } as unknown as HarnessClient;
    void answerLeaderAsks({
      rig: "rig-a",
      machine: "spark-02",
      bus,
      harness: follower,
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-answer-")),
    });
    void carryFollowerAsks({
      rig: "rig-a",
      bus,
      harness: leader,
      outboxDir,
      stopping: () => stopped,
    });
    return {
      to: link.to("spark-02"),
      stop: () => {
        stopped = true;
      },
    };
  }

  test("an answer longer than one message comes in parts, whole", async () => {
    const long = "x".repeat(9 * 1024 * 1024);
    const w = wired({ ask: async () => ({ long }) });
    try {
      const got = (await w.to.ask({ op: "info" })) as { long: string };
      assert.equal(got.long.length, long.length);
    } finally {
      w.stop();
    }
  });

  test("a bundle larger than one message goes in parts, whole and in order", async () => {
    let took: Uint8Array | undefined;
    const w = wired({
      git: async (bytes) => {
        took = bytes;
        return { ok: true };
      },
    });
    try {
      const bundle = Buffer.alloc(7 * 1024 * 1024);
      for (let i = 0; i < bundle.length; i++) bundle[i] = i % 251;
      await w.to.sendGit("proj", "a".repeat(40), bundle);
      assert.ok(took && Buffer.from(took).equals(bundle), "the follower's harness has it whole");
    } finally {
      w.stop();
    }
  });

  test("a follower's refusal reaches the leader's judge in its words", async () => {
    const w = wired({
      ask: async () => {
        throw new Error("this follower has no judge card 3");
      },
    });
    try {
      await assert.rejects(w.to.ask({ op: "throttle" }), /no judge card 3/);
    } finally {
      w.stop();
    }
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CallInput } from "../../src/common/api/call.ts";
import type { HarnessClient } from "../../src/common/api/harness.ts";
import { RUN, RUN_ASKS } from "../../src/core/api/harness/runs.ts";
import type { Route } from "../../src/core/api/route.ts";
import { RunnerAway, RunnerLink } from "../../src/harness/judge/runner-link.ts";
import { answerCoreAsks, carryRunnerAsks } from "../../src/supervisor/runners/index.ts";
import { FakeBus } from "../helpers/fake-bus.ts";

/**
 * No judge's job waits for ever on a lost answer (goal 227, item 4): while a long ask waits, the
 * core's supervisor asks the runner where it stands; a reply the runner kept ends the wait as the
 * lost reply would have, and an ask the runner does not know fails as a runner away, so the judge
 * queues its job again.
 */

/**
 * A core's link carried to a runner on a bus that loses the reply of the first ask: `deliver`
 * false loses the ask itself on its way, so the runner never runs it.
 */
function wired(deliver: boolean) {
  const bus = new FakeBus();
  let asks = 0;
  const lossy = {
    request: (
      subject: string,
      data: string | Uint8Array,
      timeoutMs: number,
      o?: { reply?: string },
    ) => {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (JSON.parse(text).kind === "ask" && asks++ === 0) {
        // Its reply goes nowhere, as one published while the core's link to the bus was down.
        if (deliver) void bus.request(subject, data, timeoutMs, o).catch(() => undefined);
        return new Promise<Uint8Array>(() => {});
      }
      return bus.request(subject, data, timeoutMs, o);
    },
  };
  const link = new RunnerLink({ outboxDir: mkdtempSync(join(tmpdir(), "thermite-lost-")) });
  let stopped = false;
  const core = {
    call: async (route: Route, input?: CallInput<Route>) =>
      route.path === RUN_ASKS.path
        ? { asks: await link.take(500) }
        : { ok: link.answer(String(input?.params?.id), (input?.body ?? {}) as object) },
  } as unknown as HarnessClient;
  const runner = {
    call: async (route: Route) => (route.path === RUN.path ? { built: "out" } : { ok: true }),
  } as unknown as HarnessClient;
  void answerCoreAsks({
    rig: "rig-a",
    runner: "spark-02",
    bus,
    harness: runner,
    scratchDir: mkdtempSync(join(tmpdir(), "thermite-lost-answer-")),
  });
  void carryRunnerAsks({
    rig: "rig-a",
    bus: lossy,
    harness: core,
    outboxDir: mkdtempSync(join(tmpdir(), "thermite-lost-carry-")),
    stopping: () => stopped,
    stateMs: 50,
  });
  return {
    to: link.to("spark-02"),
    stop: () => {
      stopped = true;
    },
  };
}

test("a reply lost on the bus is had from the runner, which kept it", async () => {
  const w = wired(true);
  try {
    assert.deepEqual(await w.to.ask({ op: "info" }), { built: "out" });
  } finally {
    w.stop();
  }
});

test("an ask the runner never got fails as a runner away, not after hours", async () => {
  const w = wired(false);
  try {
    await assert.rejects(
      () => w.to.ask({ op: "info" }),
      (err: unknown) =>
        err instanceof RunnerAway &&
        /no longer holds the ask: its answer was lost, or the runner started again/.test(
          (err as Error).message,
        ),
    );
  } finally {
    w.stop();
  }
});

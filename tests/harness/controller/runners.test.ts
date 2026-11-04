import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { QueuedRun } from "../../../src/core/api/harness/runs.ts";
import { runnersOf } from "../../../src/harness/controller/judges.ts";
import { RunnerHub } from "../../../src/harness/controller/runners.ts";
import type { RemoteRunner } from "../../../src/harness/judge/remote-runner.ts";
import { RunnerAway, RunnerLink } from "../../../src/harness/judge/runner-link.ts";
import type { HarnessService } from "../../../src/harness/service/index.ts";

/**
 * Goal 206, step 3c: the core's runners of other machines come and go as the rig's `runners`
 * setting says, while it works. A process added joins its pools, with an executor of the judge's
 * for each runner of the judge's or the shared pool, and takes runs once it answers its check and
 * fits the rig; one that fails two checks in a row is away, and its run under way fails; one
 * taken away leaves, and its run under way fails.
 */

/** The core's link, with its supervisor played by `reply`: each ask taken is answered by it. */
function linked(reply: (q: QueuedRun) => { answer?: unknown; error?: string } | undefined) {
  const link = new RunnerLink({ outboxDir: mkdtempSync(join(tmpdir(), "thermite-hub-")) });
  const asked: QueuedRun[] = [];
  let on = true;
  void (async () => {
    while (on)
      for (const q of await link.take(20)) {
        asked.push(q);
        const r = reply(q);
        if (r) link.answer(q.id, r);
      }
  })();
  return { link, asked, stop: () => (on = false) };
}

const service = {
  ledger: {},
  mirrorFor: (repo: string) => `/mirrors/${repo}`,
  paths: { scratchDir: "/scratch" },
} as unknown as HarnessService;

const core = { type: "cpu", separated: false };
const fits = { answer: { type: "cpu", separated: false, cards: 2 } };
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** The judge's executors as the hub makes and stops them, by runner. */
function executors() {
  const now: string[] = [];
  const runners = new Map<string, RemoteRunner>();
  return {
    now,
    runners,
    add: (r: RemoteRunner, shared: boolean) => {
      runners.set(r.name, r);
      now.push(`${r.name}${shared ? " shared" : ""}`);
    },
    remove: (r: { name: string }) => {
      const i = now.findIndex((n) => n.split(" ")[0] === r.name);
      if (i >= 0) now.splice(i, 1);
    },
  };
}

describe("the core's runners as they come and go (goal 206)", () => {
  test("a process joins, takes runs once it answers, and leaves with its run under way failed", async () => {
    const sup = linked((q) => (q.kind === "ask" && q.ask.op === "info" ? fits : undefined));
    const hub = new RunnerHub({ service, link: sup.link, core });
    const ex = executors();
    hub.executors = ex;
    hub.apply([{ name: "box-2", pools: ["judge", "lane-2"] }]);
    assert.deepEqual(
      ex.now,
      ["box-2-0"],
      "an executor for the judge's runner, none for the lane's",
    );
    assert.equal(hub.pools.serves("lane-2"), true);
    assert.equal(hub.pools.serves("lane-1"), false);
    await wait();
    assert.equal(sup.asked[0]?.runner, "box-2", "its check, at once");
    // Up: a lane-2 run goes there, as an ask of the process; it waits for its answer.
    const ran = hub.pools.laneRun({
      lane: "lane-2",
      trial: "t-0123456789abcdef",
      repo: "seed",
      parent: "a".repeat(40),
      patch: Buffer.alloc(0),
      command: "make",
      limits: { rssMib: 1024, diskMib: 1024 },
    });
    await wait();
    assert.ok(sup.asked.some((q) => q.kind === "ask" && q.ask.op === "lane_run"));
    // The same list again changes nothing; a list without it takes it away.
    hub.apply([{ name: "box-2", pools: ["judge", "lane-2"] }]);
    assert.deepEqual(ex.now, ["box-2-0"]);
    hub.apply([]);
    assert.deepEqual(await ran, {
      ran: false,
      reason: "the runner box-2 left the rig while your command ran: run it again",
    });
    assert.deepEqual(ex.now, [], "its executor stops");
    assert.equal(hub.pools.serves("lane-2"), false);
    // A job under way on it that asks again fails at once, as a runner away: the judge queues it.
    await assert.rejects(
      ex.runners.get("box-2-0")?.throttle() ?? Promise.resolve(),
      (err: unknown) =>
        err instanceof RunnerAway && err.message === "the runner box-2 left the rig",
    );
    sup.stop();
  });

  test("new pools for a process: it leaves and joins again, with an executor for its shared runner", async () => {
    const sup = linked((q) => (q.kind === "ask" && q.ask.op === "info" ? fits : undefined));
    const hub = new RunnerHub({ service, link: sup.link, core });
    const ex = executors();
    // Joined before the judge's loops ran: its executor comes when they do.
    hub.apply([{ name: "box-2", pools: ["lane-1"] }]);
    hub.executors = ex;
    assert.deepEqual(ex.now, []);
    hub.apply([{ name: "box-2", pools: ["shared", "judge"] }]);
    assert.deepEqual(ex.now, ["box-2-0 shared", "box-2-1"]);
    sup.stop();
  });

  test("a process that answers but does not fit the rig takes no runs", async () => {
    const sup = linked((q) =>
      q.kind === "ask" && q.ask.op === "info"
        ? { answer: { type: "cuda-gpu", separated: false, cards: 2 } }
        : undefined,
    );
    const hub = new RunnerHub({ service, link: sup.link, core });
    hub.executors = executors();
    hub.apply([{ name: "box-2", pools: ["judge"] }]);
    await wait();
    assert.deepEqual(hub.state(), [
      {
        name: "box-2",
        pools: ["judge"],
        up: false,
        why: "it measures on cuda-gpu, and the rig's core on cpu",
      },
    ]);
    hub.apply([]);
    sup.stop();
  });

  test("a process that fails two checks in a row is away: its run under way fails; it comes back", async () => {
    let answering = true;
    const sup = linked((q) =>
      q.kind === "ask" && q.ask.op === "info"
        ? answering
          ? fits
          : { error: "no responders available for request" }
        : undefined,
    );
    const hub = new RunnerHub({ service, link: sup.link, core, checkEveryMs: 30 });
    hub.executors = executors();
    hub.apply([{ name: "box-2", pools: ["shared"] }]);
    const stop = hub.start();
    await wait();
    // A run under way on it: an ask its supervisor never answers.
    const link = sup.link.to("box-2");
    const asked = link.ask({ op: "throttle" }).then(
      () => "answered",
      (err: unknown) => (err instanceof RunnerAway ? err.message : String(err)),
    );
    answering = false;
    assert.equal(await asked, "the runner box-2 stopped answering");
    assert.equal(hub.state()[0]?.up, false);
    answering = true;
    await wait(120);
    assert.equal(hub.state()[0]?.up, true, "it answers again: it takes runs");
    stop();
    hub.apply([]);
    sup.stop();
  });

  test("THERMITE_RUNNERS gives the setting's value at the start, or the harness says what is wrong", () => {
    assert.deepEqual(runnersOf({}), []);
    assert.deepEqual(runnersOf({ THERMITE_RUNNERS: "box-2=judge+shared, box-3=lane-2" }), [
      { name: "box-2", pools: ["judge", "shared"] },
      { name: "box-3", pools: ["lane-2"] },
    ]);
    assert.throws(() => runnersOf({ THERMITE_RUNNERS: "box-2=gpu" }), /"box-2=gpu" is not/);
    assert.throws(() => runnersOf({ THERMITE_RUNNERS: "box-2=lane-17" }), /is not <name>=<pool>/);
    assert.throws(
      () => runnersOf({ THERMITE_RUNNERS: "box-2=judge,box-2=shared" }),
      /each named once/,
    );
  });
});

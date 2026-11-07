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
  // A lane's run here belongs to no run with model files (goal 213), and no run is running to
  // fetch them for (goal 217).
  ledger: { trials: { get: () => undefined }, runs: { list: () => [] } },
  mirrorFor: (repo: string) => `/mirrors/${repo}`,
  paths: { scratchDir: "/scratch" },
} as unknown as HarnessService;

const core = { type: "cpu", separated: false, judges: true };
const fits = {
  answer: {
    type: "cpu",
    separated: false,
    cards: 2,
    store: { total_gib: 200, free_gib: 159.5, builds: 3, kits: 1 },
  },
};
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
    // It has every commit: a lane's run asks for its change's parent first.
    const sup = linked((q) =>
      q.kind !== "ask"
        ? undefined
        : q.ask.op === "info"
          ? fits
          : q.ask.op === "git_has"
            ? { answer: { has: true, heads: [] } }
            : undefined,
    );
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
    // Its report to control: it answers, and lane-2 holds its second runner.
    const report = hub.report();
    assert.equal(report.processes[0]?.up, true);
    assert.ok(report.processes[0]?.answered_at);
    assert.deepEqual(
      report.processes[0]?.runners.map(({ name, pool, holder }) => ({ name, pool, holder })),
      [
        { name: "box-2-0", pool: "judge", holder: null },
        { name: "box-2-1", pool: "lane-2", holder: "lane-2" },
      ],
    );
    assert.deepEqual(report.waiting, []);
    assert.deepEqual(report.waits, []);
    // What it keeps, as its check's answer said, for the rig's page.
    assert.deepEqual(report.processes[0]?.store, {
      total_gib: 200,
      free_gib: 159.5,
      builds: 3,
      kits: 1,
    });
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
    // The lanes' pool (goal 229): no executor of the judge's, so the judge never measures there.
    hub.apply([{ name: "box-2", pools: ["lanes", "judge"] }]);
    assert.deepEqual(ex.now, ["box-2-1"]);
    sup.stop();
  });

  test("each check reads the GPUs the judge does not measure on; the report gives each runner's time and its GPU's (goal 231)", async () => {
    let reads = 0;
    const sup = linked((q) =>
      q.kind === "ask" && q.ask.op === "info"
        ? {
            answer: {
              ...fits.answer,
              cards: 3,
              gpus: [{ card: 0, util_pct: 40 + 10 * (reads++ % 2), mem_used_mib: null }],
            },
          }
        : undefined,
    );
    const hub = new RunnerHub({ service, link: sup.link, core, checkEveryMs: 25 });
    const ex = executors();
    hub.executors = ex;
    hub.apply([{ name: "box-2", pools: ["lanes", "shared", "judge"] }]);
    const stop = hub.start();
    await wait(200);
    // The judge measures on the shared box-2-1: its card is read no more.
    const judged = ex.runners.get("box-2-1");
    assert.ok(judged);
    const release = await hub.pools.holdForJudge(judged, "executor-box-2-1");
    // A check asked before the hold may still be on its way.
    await wait(100);
    const before = sup.asked.length;
    await wait(200);
    stop();
    const asked = (from: number) =>
      sup.asked
        .slice(from)
        .flatMap((q) => (q.kind === "ask" && q.ask.op === "info" ? [q.ask.gpus] : []));
    assert.ok(
      asked(0).some((g) => JSON.stringify(g) === "[0,1]"),
      "the lanes' and the shared card, while the judge measured on neither; never the judge's own",
    );
    assert.ok(asked(0).every((g) => !g?.includes(2)));
    assert.ok(asked(before).length > 0);
    assert.ok(
      asked(before).every((g) => JSON.stringify(g) === "[0]"),
      "the judge's card is never read while it measures",
    );
    const report = hub.report();
    const [lanes, judge] = report.processes[0]?.runners ?? [];
    assert.equal(report.processes[0]?.runners.length, 3);
    assert.ok(lanes?.use && judge?.use);
    assert.ok(judge.use.judge_ms > 0, "the judge's time on its runner");
    assert.equal(lanes.use.judge_ms, 0, "the lanes' runner is never the judge's");
    assert.ok(lanes.use.free_ms > 0);
    assert.ok([40, 50].includes(lanes.gpu?.util_pct ?? -1), "its newest read");
    assert.equal(lanes.gpu?.mem_used_mib, null, "a GPU that shares the machine's memory");
    assert.equal(typeof lanes.gpu?.read_ms, "number");
    assert.equal(judge.gpu, undefined, "a card the answer never gave");
    assert.deepEqual(report.waited, {});
    assert.ok(Date.parse(report.waited_since) <= Date.now());
    release?.();
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

  test("a core on a CPU machine judges on GPU runners: the rig measures on theirs, all of one kind", async () => {
    const kinds: Record<string, string> = { "box-2": "cuda-gpu", "box-3": "cpu" };
    const gb10 = { type: "cuda-gpu", class: "cuda-gpu", id: "GPU-1", details: {} };
    const sup = linked((q) =>
      q.kind === "ask" && q.ask.op === "info"
        ? { answer: { type: kinds[q.runner], separated: true, cards: 1 } }
        : q.kind === "ask" && q.ask.op === "driver"
          ? { answer: { answer: gb10 } }
          : undefined,
    );
    const hardware = { target: { type: "cpu", class: "generic-cpu", id: "cpu-0" } };
    const own = { ...service, targetType: "cpu", hardware } as unknown as HarnessService;
    const hub = new RunnerHub({
      service: own,
      link: sup.link,
      core: { type: "cpu", separated: false, judges: false },
    });
    const ex = executors();
    hub.executors = ex;
    hub.apply([{ name: "box-2", pools: ["judge"] }]);
    await wait();
    assert.equal(hub.state()[0]?.up, true);
    assert.equal(own.targetType, "cuda-gpu", "an assigned kit measures on the runners' kind");
    // What the rig reports measuring on, for control's check that a campaign's kit fits it.
    for (let i = 0; i < 50 && hardware.target.id !== "GPU-1"; i++) await wait(20);
    assert.deepEqual(hardware.target, { type: "cuda-gpu", class: "cuda-gpu", id: "GPU-1" });
    const runner = ex.runners.get("box-2-0");
    assert.equal(runner?.driver.type, "cuda-gpu");
    assert.equal(runner?.separated, true);
    hub.apply([
      { name: "box-2", pools: ["judge"] },
      { name: "box-3", pools: ["shared"] },
    ]);
    await wait();
    assert.deepEqual(hub.state()[1], {
      name: "box-3",
      pools: ["shared"],
      up: false,
      why: "it measures on cpu, and the rig's other runners on cuda-gpu",
    });
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

  test("a ledger that can't be read leaves the checks going: the runner still comes up", async () => {
    let answering = false;
    const sup = linked((q) =>
      q.kind === "ask" && q.ask.op === "info"
        ? answering
          ? fits
          : { error: "no responders available for request" }
        : undefined,
    );
    const closed = {
      ...service,
      ledger: {
        ...service.ledger,
        runs: {
          list: () => {
            throw new Error("The database connection is not open");
          },
        },
      },
    } as unknown as HarnessService;
    const hub = new RunnerHub({ service: closed, link: sup.link, core, checkEveryMs: 30 });
    hub.executors = executors();
    hub.apply([{ name: "box-2", pools: ["shared"] }]);
    const stop = hub.start();
    await wait();
    assert.equal(hub.state()[0]?.up, false);
    answering = true;
    await wait(120);
    assert.equal(hub.state()[0]?.up, true, "a later check, after the ledger's error, brings it up");
    stop();
    hub.apply([]);
    sup.stop();
  });

  test("THERMITE_RUNNERS gives the setting's value at the start, or the harness says what is wrong", () => {
    assert.deepEqual(runnersOf({}), []);
    assert.deepEqual(runnersOf({ THERMITE_RUNNERS: "box-2=judge+shared, box-3=lane-2+lanes" }), [
      { name: "box-2", pools: ["judge", "shared"] },
      { name: "box-3", pools: ["lane-2", "lanes"] },
    ]);
    assert.throws(() => runnersOf({ THERMITE_RUNNERS: "box-2=gpu" }), /"box-2=gpu" is not/);
    assert.throws(() => runnersOf({ THERMITE_RUNNERS: "box-2=lane-17" }), /is not <name>=<pool>/);
    assert.throws(
      () => runnersOf({ THERMITE_RUNNERS: "box-2=judge,box-2=shared" }),
      /each named once/,
    );
  });
});

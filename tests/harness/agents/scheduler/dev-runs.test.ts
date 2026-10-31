/**
 * Dev runs: none once their trial has ended, on a dedicated development card or on a device the
 * judge shares, their time limits, and a pool of development cards.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/** A scheduler with no model, for its registry. */
function scheduler0(env: ReturnType<typeof makeJudgeEnv>) {
  return new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    owner: "s0",
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
  });
}

describe("agent scheduler", () => {
  test("a dev run that waited past its trial's end never runs", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    const { DevRuns } = await import("../../../../src/harness/agents/devrun.ts");
    const runner = new LocalRunner(env.paths.scratchDir);
    const dev = new DevRuns({
      runner,
      ledger: env.ledger,
      scratchDir: env.paths.scratchDir,
      gpu: false,
    });
    const registry = scheduler0(env).registry;
    registry.startTrial({
      id: "t-x",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "tok",
    });
    registry.finishTrial(
      "t-x",
      { stopped: "wall", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "t",
    );
    const { mkdirSync } = await import("node:fs");
    const cwd = `${env.paths.scratchDir}/lanes/lane-1/ws/repo`;
    mkdirSync(cwd, { recursive: true });
    const r = (await dev.run({ lane: "lane-1", command: "echo ran", cwd }, "t-x")) as {
      ran: boolean;
      reason: string;
    };
    assert.equal(r.ran, false);
    assert.match(r.reason, /ended/);
    await dev.settle("lane-1");
  });

  test("a dev run behind another lane's waits with no time limit, and gives up when its trial ends (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.start();
    const { DevRuns } = await import("../../../../src/harness/agents/devrun.ts");
    const dev = new DevRuns({
      runner: new LocalRunner(env.paths.scratchDir),
      ledger: env.ledger,
      scratchDir: env.paths.scratchDir,
      gpu: false,
      dedicated: true,
    });
    const registry = scheduler0(env).registry;
    const { mkdirSync } = await import("node:fs");
    const cwd = (lane: string) => {
      const d = `${env.paths.scratchDir}/lanes/${lane}/ws/repo`;
      mkdirSync(d, { recursive: true });
      return d;
    };
    for (const lane of ["lane-1", "lane-2"])
      registry.startTrial({
        id: `t-${lane}`,
        run: "js-1",
        lane,
        epoch: 1,
        family: "f",
        parent: env.seed,
        token: `tok-${lane}`,
      });
    const long = dev.run({ lane: "lane-1", command: "sleep 1", cwd: cwd("lane-1") }, "t-lane-1");
    let settled = false;
    const behind = dev
      .run({ lane: "lane-2", command: "echo ran", cwd: cwd("lane-2") }, "t-lane-2")
      .then((r) => {
        settled = true;
        return r as { ran: boolean; reason: string };
      });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, "it waits: no time limit of its own");
    // Its trial ends: it gives up at once, and the trial's end does not wait behind lane-1.
    const t0 = Date.now();
    await dev.settle("lane-2");
    assert.ok(Date.now() - t0 < 500);
    const r = await behind;
    assert.equal(r.ran, false);
    assert.match(r.reason, /the trial ended before a device was free/);
    assert.equal(((await long) as { ran: boolean }).ran, true);
  });

  test("with a dedicated development card, dev runs and the judge do not wait for each other", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    // A judge job that nothing drains here: the judge is busy throughout.
    env.ledger.jobs.enqueue({ kind: "calibrate", priority: 10, spec: { run: "js-1" }, actor: "t" });
    const { DevRuns } = await import("../../../../src/harness/agents/devrun.ts");
    const runner = new LocalRunner(env.paths.scratchDir);
    scheduler0(env).registry.startTrial({
      id: "t-d",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "tok",
    });
    const { mkdirSync } = await import("node:fs");
    const cwd = `${env.paths.scratchDir}/lanes/lane-1/ws/repo`;
    mkdirSync(cwd, { recursive: true });
    const make = (opts: { dedicated?: boolean; unavailable?: string }) =>
      new DevRuns({
        runner,
        ledger: env.ledger,
        scratchDir: env.paths.scratchDir,
        gpu: false,
        maxWaitMs: 300,
        ...opts,
      });
    type Result = { ran: boolean; reason?: string; stdout?: string };
    const shared = (await make({}).run(
      { lane: "lane-1", command: "echo ran", cwd },
      "t-d",
    )) as Result;
    assert.equal(shared.ran, false);
    assert.match(String(shared.reason), /judge kept the device busy/);
    const dedicated = make({ dedicated: true });
    const pending = dedicated.run({ lane: "lane-1", command: "sleep 0.2; echo ran", cwd }, "t-d");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dedicated.active, false, "the judge never waits for a dev run on its own card");
    const ran = (await pending) as Result;
    assert.equal(ran.ran, true);
    assert.match(String(ran.stdout), /ran/);
    const ev = env.ledger.db
      .prepare("select body from event where kind = 'dev_run' order by id desc limit 1")
      .get() as { body: string };
    const body = JSON.parse(ev.body) as { command: string; peak_rss_mib: number };
    assert.equal(body.command, "sleep 0.2; echo ran");
    assert.equal(typeof body.peak_rss_mib, "number");
    const off = (await make({ unavailable: "the dedicated development card is not set up: x" }).run(
      { lane: "lane-1", command: "echo ran", cwd },
      "t-d",
    )) as Result;
    assert.equal(off.ran, false);
    assert.match(String(off.reason), /not set up/);
  });

  test("a dev run's time limit: none on a dedicated card, the shared default otherwise; a run stuck behind another lane's gives up", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.start();
    const { DevRuns } = await import("../../../../src/harness/agents/devrun.ts");
    const { SHARED_DEV_RUN_S } = await import("../../../../src/core/contract.ts");
    const inner = new LocalRunner(env.paths.scratchDir);
    const seen: (number | undefined)[] = [];
    const runner = Object.assign(Object.create(inner), {
      run: (req: Parameters<LocalRunner["run"]>[0]) => {
        seen.push(req.timeoutMs);
        return inner.run(req);
      },
    }) as LocalRunner;
    const registry = scheduler0(env).registry;
    for (const lane of ["lane-1", "lane-2"]) {
      registry.startTrial({
        id: `t-${lane}`,
        run: "js-1",
        lane,
        epoch: 1,
        family: "f",
        parent: env.seed,
        token: `tok-${lane}`,
      });
    }
    const { mkdirSync } = await import("node:fs");
    const cwd = (lane: string) => {
      const d = `${env.paths.scratchDir}/lanes/${lane}/ws/repo`;
      mkdirSync(d, { recursive: true });
      return d;
    };
    const make = (dedicated: boolean, maxWaitMs = 10_000) =>
      new DevRuns({
        runner,
        ledger: env.ledger,
        scratchDir: env.paths.scratchDir,
        gpu: false,
        dedicated,
        maxWaitMs,
      });
    const limits: { rssMib: number; diskMib: number; timeoutS?: number } = {
      rssMib: 512,
      diskMib: 512,
    };
    const one = (dev: InstanceType<typeof DevRuns>, extra: Record<string, unknown>, l = limits) =>
      dev.run({ lane: "lane-1", command: "true", cwd: cwd("lane-1"), ...extra }, "t-lane-1", l);
    await one(make(true), {});
    await one(make(false), {});
    await one(make(false), { timeout_s: 60 });
    await one(make(true), { timeout_s: 9000 }, { ...limits, timeoutS: 1800 });
    assert.deepEqual(seen, [undefined, SHARED_DEV_RUN_S * 1000, 60_000, 1_800_000]);
    // Lane-1's long dev run holds the card; lane-2's, waiting longer than maxWaitMs, is told so.
    const dev = make(true, 300);
    const long = dev.run(
      { lane: "lane-1", command: "sleep 1.5", cwd: cwd("lane-1") },
      "t-lane-1",
      limits,
    );
    const behind = (await dev.run(
      { lane: "lane-2", command: "echo ran", cwd: cwd("lane-2") },
      "t-lane-2",
      limits,
    )) as { ran: boolean; reason: string };
    assert.equal(behind.ran, false);
    assert.match(behind.reason, /another lane's dev run held the device/);
    const settled = Date.now();
    await dev.settle("lane-2"); // lane-2's trial end does not wait behind lane-1
    assert.ok(Date.now() - settled < 500);
    assert.equal(((await long) as { ran: boolean }).ran, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 5, "the one that gave up never ran");
  });

  test("development cards are a pool: any free card, a wait only when all are busy, one dev run per lane at a time", async () => {
    const env = makeJudgeEnv({ lanes: { count: 3, trials_per_epoch: 1 } });
    await env.start();
    const { DevRuns } = await import("../../../../src/harness/agents/devrun.ts");
    const registry = scheduler0(env).registry;
    for (const lane of ["lane-1", "lane-2", "lane-3"]) {
      registry.startTrial({
        id: `t-${lane}`,
        run: "js-1",
        lane,
        epoch: 1,
        family: "f",
        parent: env.seed,
        token: `tok-${lane}`,
      });
    }
    const { mkdirSync } = await import("node:fs");
    const cwd = (lane: string) => {
      const d = `${env.paths.scratchDir}/lanes/${lane}/ws/repo`;
      mkdirSync(d, { recursive: true });
      return d;
    };
    // A device stand-in: each dev run holds its card for a while; which card and when are kept.
    const log: { lane: string; card: number; start: number; end: number }[] = [];
    const t0 = Date.now();
    const runner = {
      separated: false,
      run: async (req: { role: string; devCard?: number; gpu?: boolean }) => {
        assert.equal(req.gpu, true);
        const start = Date.now() - t0;
        await new Promise((r) => setTimeout(r, 300));
        log.push({ lane: req.role, card: req.devCard ?? 0, start, end: Date.now() - t0 });
        return { exitCode: 0, signal: null, wallMs: 300, peakRssBytes: 0, stdout: "", stderr: "" };
      },
      killRole: async () => 0,
    } as unknown as LocalRunner;
    const dev = new DevRuns({
      runner,
      ledger: env.ledger,
      scratchDir: env.paths.scratchDir,
      gpu: true,
      dedicated: true,
      cards: 2,
      maxWaitMs: 10_000,
    });
    const go = (lane: string) =>
      dev.run({ lane, command: "true", cwd: cwd(lane) }, `t-${lane}`) as Promise<{
        ran: boolean;
        card?: number;
      }>;
    const out = await Promise.all([go("lane-1"), go("lane-2"), go("lane-3"), go("lane-1")]);
    assert.ok(out.every((o) => o.ran));
    // Two at once on the two cards; the third waited for a card.
    const first = log.filter((x) => x.start < 150);
    assert.deepEqual(first.map((x) => x.card).sort(), [0, 1]);
    assert.equal(log.length, 4);
    // Lane-1's second dev run started only after its first ended.
    const l1 = log.filter((x) => x.lane === "lane-1").sort((a, b) => a.start - b.start);
    assert.ok((l1[1] as { start: number }).start >= (l1[0] as { end: number }).end - 5);
    // Never two dev runs on one card at once.
    for (const a of log)
      for (const b of log)
        if (a !== b && a.card === b.card)
          assert.ok(a.end <= b.start + 5 || b.end <= a.start + 5, "a card ran two at once");
    assert.ok(
      out.every((o) => o.card === 1 || o.card === 2),
      "the answer names the card",
    );
  });
});

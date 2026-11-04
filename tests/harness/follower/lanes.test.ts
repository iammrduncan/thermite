import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { DeviceAsk } from "../../../src/core/api/harness/device.ts";
import { AwayLane } from "../../../src/harness/agents/away.ts";
import type { TrialLink } from "../../../src/harness/agents/programs.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import type { TrialResult, TrialSpec } from "../../../src/harness/agents/worker/index.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { followersOf } from "../../../src/harness/controller/judges.ts";
import { followerApi } from "../../../src/harness/follower/api.ts";
import { DeviceServer } from "../../../src/harness/follower/device.ts";
import { LaneHost } from "../../../src/harness/follower/lanes.ts";
import type { DeviceLink } from "../../../src/harness/judge/index.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * A lane's trial on a follower (goal 205, step 2): the leader's scheduler hands it to the
 * follower's lane, which sends the parent commit and starts it there; the follower makes the
 * workspace and runs the program, whose lane commands run there, and whose submission goes to the
 * leader's API with the trial's token; what the program reports reaches the leader's records.
 */

const route = {
  baseUrl: "http://127.0.0.1:9",
  model: "m",
  apiKey: "k",
  contextWindow: 1,
  maxTokens: 1,
};

const servers: { close(): void }[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** A follower in a folder of its own, its API on loopback, and the leader's link to it. */
async function followerFor(
  env: ReturnType<typeof makeJudgeEnv>,
  program: (spec: TrialSpec, link: TrialLink, api: string) => Promise<TrialResult>,
) {
  const paths = {
    stateDir: join(env.root, "f-lanes", "state"),
    scratchDir: join(env.root, "f-lanes", "scratch"),
    inboxDir: join(env.root, "f-lanes", "inbox"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  let app: Hono | undefined;
  const server = serve({ fetch: (r) => (app as Hono).fetch(r), hostname: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const runner = new LocalRunner(paths.scratchDir);
  let device: DeviceServer | undefined;
  const host = new LaneHost({
    runner,
    scratchDir: paths.scratchDir,
    mirror: (repo) => (device as DeviceServer).mirror(repo),
    port,
    runTrial: (spec, link) => program(spec, link, `http://127.0.0.1:${port}`),
  });
  device = new DeviceServer({
    runner,
    drivers: [],
    paths,
    ledger: Ledger.open(join(paths.stateDir, "ledger", "ledger.db")),
    lanes: host,
  });
  app = followerApi(device, { supervisor: "s".repeat(40) }, "rig-1", {
    host,
    lanes: { runner, scratchDir: paths.scratchDir, laneTool: ["false"] },
  });
  const server2 = device;
  // Every ask passes through JSON, as it does over the bus.
  const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const link: DeviceLink = {
    ask: async (a) => wire(await server2.ask(DeviceAsk.parse(wire(a)))),
    sendGit: (repo, commit, bundle) => server2.takeGit(repo, commit, Buffer.from(bundle)),
    fetchModels: async () => undefined,
  };
  return { host, link, port, paths };
}

/** The leader's lane on that follower, with a trial's link that reports to the leader's records. */
function awayLane(env: ReturnType<typeof makeJudgeEnv>, link: DeviceLink, goneMs?: number) {
  const api = createHarnessApi(env.service, { supervisor: "s".repeat(40) });
  const runner = new LocalRunner(env.paths.scratchDir);
  return new AwayLane({
    machine: "spark-03",
    link,
    mirrorFor: (repo) => env.service.mirrorFor(repo),
    scratchDir: env.paths.scratchDir,
    modelFor: () => route,
    trialLink: (spec, m, signal) => {
      const trial = { id: spec.trialId, run: spec.run, lane: spec.lane };
      return {
        runner,
        model: m,
        apiUrl: "",
        scratchDir: env.paths.scratchDir,
        port: 0,
        live: (entries) => env.service.trialReport(trial, { entries }),
        progress: (progress) => env.service.trialReport(trial, { progress }),
        messages: env.service.trialInbox(trial),
        handOver: () => () => undefined,
        signal,
      };
    },
    api: (req) => api.fetch(req),
    proxySaw: () => undefined,
    goneMs,
  });
}

/** One call of the follower's API with the trial's token. */
async function call(api: string, spec: TrialSpec, path: string, body: unknown) {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer trial.${spec.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("a lane's trial on a follower (goal 205, step 2)", () => {
  test("its workspace and commands are the follower's; its submission and lines reach the leader", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    const seen: { workspace: string; apiUrl: string } = { workspace: "", apiUrl: "" };
    const f = await followerFor(env, async (spec, link, api) => {
      seen.workspace = spec.workspace;
      seen.apiUrl = link.apiUrl;
      link.live([{ kind: "status", text: "working on the follower" }]);
      link.progress({ turns: 2, tool_calls: 3, tokens_in: 40, tokens_out: 5 });
      // The lane's commands run in the workspace here.
      const write = await call(api, spec, "/v1/lane/run", {
        role: spec.lane,
        argv: ["sh", "-c", "cat > src/kernel/work.mjs"],
        cwd: spec.workspace,
        stdin: FAST_KERNEL,
      });
      assert.equal(write.status, 200, JSON.stringify(write.body));
      const diff = await call(api, spec, "/v1/lane/run", {
        role: spec.lane,
        argv: ["sh", "-c", "git add -A && git diff --cached --binary"],
        cwd: spec.workspace,
      });
      const patch = Buffer.from(String(diff.body.stdout)).toString("base64");
      // A command outside the workspace is refused here.
      const outside = await call(api, spec, "/v1/lane/run", {
        role: spec.lane,
        argv: ["sh", "-c", "true"],
        cwd: "/tmp",
      });
      assert.equal(outside.status, 401);
      // The submission goes to the leader, which records it for the trial.
      const sub = await call(api, spec, "/v1/attempts", {
        patch_base64: patch,
        hypothesis: "a faster kernel, from the follower",
        known_flaws: [],
      });
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      assert.equal(link.submitted?.()?.attempt, sub.body.attempt);
      return {
        stopped: "submitted",
        turns: 2,
        toolCalls: 3,
        tokensIn: 40,
        tokensOut: 5,
        submitted: { attempt: String(sub.body.attempt), lifecycle: String(sub.body.lifecycle) },
      };
    });
    const away = awayLane(env, f.link);
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: route,
      owner: "s",
      runTrial: async () => {
        throw new Error("lane-1's trials run on its follower");
      },
      laneAway: (lane) => (lane === "lane-1" ? away : undefined),
    });
    assert.equal(await scheduler.tick(), true);
    await scheduler.idle();
    f.host.close();

    assert.ok(seen.workspace.startsWith(join(f.paths.scratchDir, "lanes", "lane-1")));
    assert.equal(seen.apiUrl, `http://127.0.0.1:${f.port}`);
    const trial = env.ledger.db.prepare("select id, attempt, stopped from trial").get() as {
      id: string;
      attempt: string | null;
      stopped: string;
    };
    assert.equal(trial.stopped, "submitted");
    assert.ok(trial.attempt, "the leader linked the follower's submission to its trial");
    assert.equal(
      env.ledger.attempts.get(trial.attempt)?.hypothesis,
      "a faster kernel, from the follower",
    );
    const lines = env.service.live
      .since(0, 1000)
      .entries.filter((e) => e.source === `trial:${trial.id}`)
      .map((e) => e.text);
    assert.ok(lines.includes("the trial runs on spark-03"), lines.join("\n"));
    assert.ok(lines.includes("working on the follower"), lines.join("\n"));
    assert.ok(lines.includes("a trial on a follower runs headless"), lines.join("\n"));
  });

  test("a call without one of its trials' tokens is refused, and never reaches the leader", async () => {
    const env = makeJudgeEnv({});
    const f = await followerFor(env, async () => {
      throw new Error("no trial runs");
    });
    const res = await fetch(`http://127.0.0.1:${f.port}/v1/attempts`, {
      method: "POST",
      headers: { authorization: `Bearer trial.${"0".repeat(64)}` },
      body: "{}",
    });
    assert.equal(res.status, 401);
    f.host.close();
  });

  test("a stop is passed on: the follower's trial ends, interrupted", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    let started = false;
    const f = await followerFor(env, async (_spec, link) => {
      started = true;
      await new Promise<void>((resolve) => link.signal?.addEventListener("abort", () => resolve()));
      return { stopped: "interrupted", turns: 1, toolCalls: 0, tokensIn: 1, tokensOut: 1 };
    });
    const away = awayLane(env, f.link);
    const champion = env.ledger.champions.current("js-1").commit_sha;
    const abort = new AbortController();
    const run = away.run(
      {
        spec: {
          trialId: "t-0123456789abcdef",
          token: "a".repeat(64),
          run: "js-1",
          lane: "lane-1",
          parentCommit: champion,
          editablePaths: [],
          brief: "work",
        } as never,
        repo: String(env.ledger.runs.get("js-1")?.seed_repo),
      },
      abort.signal,
    );
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(started);
    abort.abort();
    const r = await run;
    f.host.close();
    assert.equal(r.stopped, "interrupted");
  });

  test("a follower that stops answering ends its trial, interrupted", async () => {
    const env = makeJudgeEnv({});
    let asks = 0;
    const link: DeviceLink = {
      ask: async (a) => {
        asks++;
        if (a.op === "git_has") return { has: true, heads: [] };
        if (a.op === "trial_start") return { ok: true };
        throw new Error("no responders");
      },
      sendGit: async () => undefined,
      fetchModels: async () => undefined,
    };
    const r = await awayLane(env, link, 50).run(
      {
        spec: {
          trialId: "t-0123456789abcdef",
          token: "a".repeat(64),
          run: "js-1",
          lane: "lane-1",
          parentCommit: "0".repeat(40),
          editablePaths: [],
          brief: "work",
        } as never,
        repo: "seed",
      },
      new AbortController().signal,
    );
    assert.equal(r.stopped, "interrupted");
    assert.match(String(r.error), /spark-03 stopped answering: no responders/);
    assert.ok(asks >= 3);
  });
});

describe("the rig's followers, with their workers' GPUs (goal 205, step 2)", () => {
  test("THERMITE_FOLLOWERS names each follower's judge and workers' GPUs", () => {
    assert.deepEqual(followersOf({ THERMITE_FOLLOWERS: "spark-02=1,spark-03=0+1,spark-04=2+2" }), [
      { machine: "spark-02", cards: 1, workers: 0 },
      { machine: "spark-03", cards: 0, workers: 1 },
      { machine: "spark-04", cards: 2, workers: 2 },
    ]);
    assert.throws(() => followersOf({ THERMITE_FOLLOWERS: "spark-02=0+0" }), /not both 0/);
    assert.throws(() => followersOf({ THERMITE_FOLLOWERS: "spark-02=9" }), /each 0 to 8/);
  });
});

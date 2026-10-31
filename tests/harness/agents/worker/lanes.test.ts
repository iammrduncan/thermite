/**
 * A worker's lane: its commands through the harness API, held to the contract's lane limits; the
 * lane tool; and the isolation selftest's refusal of a busy rig.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { prepareWorkspace } from "../../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { laneTool } from "./setup.ts";

describe("worker trial", () => {
  test("a worker's lane work goes through the API: its own lane, its own workspace, tool or shell only", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const { Registry } = await import("../../../../src/harness/agents/registry.ts");
    const { createHarnessApi } = await import("../../../../src/harness/api/index.ts");
    new Registry(env.ledger).startTrial({
      id: "t-lane",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "lane-token",
    });
    env.service.trialWorkspaces.set("t-lane", { lane: "lane-1", repo: ws.repo, root: ws.dir });
    const api = createHarnessApi(env.service, { supervisor: "s" }, { lanes: { runner, laneTool } });
    const run = (body: Record<string, unknown>) =>
      api.request("/v1/lane/run", {
        method: "POST",
        headers: { authorization: "Bearer trial.lane-token", "content-type": "application/json" },
        body: JSON.stringify({ role: "lane-1", cwd: ws.repo, timeoutMs: 20_000, ...body }),
      });
    const ok = await run({
      argv: ["lanetool", "read", JSON.stringify({ path: "src/kernel/work.mjs" })],
    });
    assert.equal(ok.status, 200);
    assert.match(((await ok.json()) as { stdout: string }).stdout, /"ok":true/);
    const shell = await run({ argv: ["sh", "-c", "echo hi"] });
    assert.match(((await shell.json()) as { stdout: string }).stdout, /hi/);
    assert.equal((await run({ argv: ["node", "-e", "1"] })).status, 401, "only tool or shell");
    assert.equal((await run({ role: "lane-2", argv: ["sh", "-c", "id"] })).status, 401, "own lane");
    assert.equal(
      (await run({ cwd: `${ws.dir}/../..`, argv: ["sh", "-c", "ls"] })).status,
      401,
      "own workspace",
    );
    env.service.trialWorkspaces.delete("t-lane");
    assert.equal((await run({ argv: ["sh", "-c", "echo"] })).status, 404);
  });

  /** A trial's lane API over a recording runner, under the given lane limits. */
  async function laneApi(limits?: Record<string, number>) {
    const env = makeJudgeEnv({
      contract: { lanes: { count: 2, trials_per_epoch: 1, ...(limits ? { limits } : {}) } },
    });
    await env.service.applyCommand(env.assign);
    const inner = new LocalRunner(env.paths.scratchDir);
    const seen: {
      timeoutMs?: number;
      rssLimitBytes?: number;
      disk?: { limitBytes: number };
      env?: Record<string, string>;
      keepBackground?: boolean;
      nproc?: number;
    }[] = [];
    const runner = Object.assign(Object.create(inner), {
      run: (req: Parameters<LocalRunner["run"]>[0]) => {
        seen.push(req);
        return inner.run(req);
      },
    }) as LocalRunner;
    const ws = await prepareWorkspace({
      runner: inner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const { Registry } = await import("../../../../src/harness/agents/registry.ts");
    const { createHarnessApi } = await import("../../../../src/harness/api/index.ts");
    new Registry(env.ledger).startTrial({
      id: "t-lim",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "lim-token",
    });
    env.service.trialWorkspaces.set("t-lim", { lane: "lane-1", repo: ws.repo, root: ws.dir });
    const devRequests: { input: { timeout_s?: number }; limits: unknown }[] = [];
    const devRuns = {
      run: async (input: unknown, _trial: string, limits?: unknown) => {
        devRequests.push({ input: input as { timeout_s?: number }, limits });
        return { ran: true };
      },
    };
    const api = createHarnessApi(
      env.service,
      { supervisor: "s" },
      { lanes: { runner, laneTool }, devRuns },
    );
    const headers = { authorization: "Bearer trial.lim-token", "content-type": "application/json" };
    const run = (body: Record<string, unknown>) =>
      api.request("/v1/lane/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "lane-1", cwd: ws.repo, argv: ["sh", "-c", "true"], ...body }),
      });
    const dev = (body: Record<string, unknown>) =>
      api.request("/v1/dev-runs", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: "true", cwd: ws.repo, ...body }),
      });
    return { env, ws, seen, devRequests, run, dev };
  }

  test("lane commands and dev runs are held to the contract's lane limits", async () => {
    const { env, ws, seen, devRequests, run, dev } = await laneApi({
      run_timeout_s: 30,
      run_rss_mib: 512,
      workspace_mib: 1024,
      dev_run_timeout_s: 45,
      processes: 1024,
    });
    const r = await run({
      timeoutMs: 3_600_000,
      rssLimitBytes: 64 * 1024 ** 3,
      disk: { path: ws.dir, limitBytes: 64 * 1024 ** 3 },
      nproc: 65_536,
    });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 30_000);
    assert.equal(seen.at(-1)?.rssLimitBytes, 512 * 1024 ** 2);
    assert.equal(seen.at(-1)?.disk?.limitBytes, 1024 * 1024 ** 2);
    // The process limit is the contract's, whatever the worker asks for.
    assert.equal(seen.at(-1)?.nproc, 1024);
    // A command that asks for no limit still gets the contract's.
    assert.equal((await run({})).status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 30_000);
    // The lane's cache: created with its first workspace, kept across trials, named to its commands.
    const cache = `${env.paths.scratchDir}/lanes/lane-1/cache`;
    assert.ok(existsSync(cache));
    assert.equal(seen.at(-1)?.env?.CCACHE_DIR, cache);
    assert.equal(seen.at(-1)?.env?.THERMITE_LANE_CACHE, cache);
    const d = await dev({ timeout_s: 3600 });
    assert.equal(d.status, 200);
    // The dev-run queue applies the limit (it alone knows whether the judge shares the device).
    assert.equal(devRequests.at(-1)?.input.timeout_s, 3600);
    assert.deepEqual(devRequests.at(-1)?.limits, {
      rssMib: 4096,
      diskMib: 1024,
      processes: 1024,
      timeoutS: 45,
    });
  });

  test("without a time limit in the contract, a lane command has none, and its background work runs on", async () => {
    const { seen, devRequests, run, dev } = await laneApi();
    assert.equal((await run({})).status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, undefined);
    assert.equal(seen.at(-1)?.keepBackground, true);
    // No process limit in the contract: the lane's users keep the default.
    assert.equal(seen.at(-1)?.nproc, 256);
    assert.equal((await run({ timeoutMs: 90_000 })).status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 90_000, "an agent may still set its own");
    assert.equal((await dev({})).status, 200);
    assert.equal(devRequests.at(-1)?.input.timeout_s, undefined);
    assert.deepEqual(devRequests.at(-1)?.limits, { rssMib: 4096, diskMib: 2048, processes: 256 });
  });

  test("the isolation selftest refuses a rig with open trials or judge jobs", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const { busyReason } = await import("../../../../src/harness/selftest/index.ts");
    const { Registry } = await import("../../../../src/harness/agents/registry.ts");
    const jobs = Number(
      (
        env.ledger.db
          .prepare("select count(*) as n from job where state in ('queued','leased')")
          .get() as { n: number }
      ).n,
    );
    if (!jobs) assert.equal(busyReason(env.paths.stateDir), undefined);
    new Registry(env.ledger).startTrial({
      id: "t-busy",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "busy-token",
    });
    assert.match(String(busyReason(env.paths.stateDir)), /1 open trial/);
  });

  test("the lane tool searches the whole tree and keeps each reply small", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(`${tmpdir()}/thermite-lanetool-`);
    // 600 files (more than a listing shows), the match in the last one.
    for (let i = 0; i < 600; i++) {
      mkdirSync(`${dir}/d${String(i).padStart(3, "0")}`);
      writeFileSync(
        `${dir}/d${String(i).padStart(3, "0")}/f.c`,
        i === 599 ? "PQ2_0 here\n" : "x\n",
      );
    }
    writeFileSync(
      `${dir}/long.c`,
      Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const tool = (op: string, args: unknown) =>
      JSON.parse(
        execFileSync(laneTool[0] as string, [...laneTool.slice(1), op, JSON.stringify(args)], {
          cwd: dir,
          encoding: "utf8",
        }),
      ) as Record<string, unknown>;
    const found = tool("search", { pattern: "PQ2_0" }).matches as string[];
    assert.deepEqual(found, ["d599/f.c:1: PQ2_0 here"]);
    const read = tool("read", { path: "long.c" }) as unknown as {
      content: string;
      total_lines: number;
    };
    assert.equal(read.total_lines, 1000);
    assert.match(read.content, /^1\tline 1\n/);
    assert.match(
      read.content,
      /\n400\tline 400\n… lines 401–1000 not shown: read again with offset 400$/,
    );
    const more = tool("read", { path: "long.c", offset: 400, limit: 1000 }) as unknown as {
      content: string;
    };
    assert.match(more.content, /^401\tline 401/);
    assert.match(more.content, /1000\tline 1000$/);
  });

  test("the lane tool never leaves the workspace", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const tool = async (op: string, args: unknown, stdin?: string) =>
      JSON.parse(
        (
          await runner.run({
            role: "lane-1",
            argv: [...laneTool, op, JSON.stringify(args)],
            cwd: ws.repo,
            timeoutMs: 20_000,
            ...(stdin ? { stdin } : {}),
          })
        ).stdout,
      );
    assert.equal((await tool("read", { path: "../../../../etc/hosts" })).ok, false);
    assert.equal((await tool("write", { path: "/tmp/escape" }, "x")).ok, false);
    assert.equal((await tool("read", { path: "src/kernel/work.mjs" })).ok, true);
  });
});

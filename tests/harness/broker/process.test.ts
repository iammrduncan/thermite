import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  diskUsage,
  killScope,
  listProcesses,
  members,
  runSupervised,
} from "../../../src/harness/broker/process.ts";
import { insideRoot, LocalRunner } from "../../../src/harness/broker/runner.ts";

const node = process.execPath;
const scratch = () => mkdtempSync(join(tmpdir(), "thermite-proc-"));

describe("supervised processes", () => {
  test("wall time is measured outside the child and output is captured", async () => {
    const r = await runSupervised({
      argv: [node, "-e", "setTimeout(() => console.log('done'), 200)"],
      cwd: scratch(),
      env: {},
      timeoutMs: 10_000,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.killedFor, null);
    assert.ok(r.wallMs >= 190, `wall ${r.wallMs}`);
    assert.match(r.stdout, /done/);
  });

  test("a run past its time limit is killed", async () => {
    const r = await runSupervised({
      argv: [node, "-e", "setInterval(() => {}, 1000)"],
      cwd: scratch(),
      env: {},
      timeoutMs: 300,
    });
    assert.equal(r.killedFor, "timeout");
    assert.ok(r.wallMs < 5000);
  });

  test("a run over its memory limit is killed", async () => {
    const r = await runSupervised({
      argv: [
        node,
        "-e",
        "const keep = []; setInterval(() => keep.push(Buffer.alloc(32 << 20, 1)), 20)",
      ],
      cwd: scratch(),
      env: {},
      timeoutMs: 20_000,
      rssLimitBytes: 200 << 20,
    });
    assert.equal(r.killedFor, "memory");
    assert.ok(r.peakRssBytes > 200 << 20);
  });

  // Telling the processes apart needs /proc (Linux).
  const procfs = existsSync("/proc/self/cmdline") ? false : "needs /proc (Linux)";

  test("over its memory limit, a run that holds a program spares the program and itself", {
    skip: procfs,
  }, async () => {
    // The run's root (node, as the terminal host is) starts the program (sh), which runs a
    // command that grows, then waits.
    const grow = "const keep = []; setInterval(() => keep.push(Buffer.alloc(32 << 20, 1)), 20)";
    const root = `const p = require('child_process').spawn('/bin/sh', ['-c', '"$0" -e "$1"; sleep 2', process.execPath, ${JSON.stringify(grow)}], { stdio: 'inherit' }); p.on('exit', (c) => process.exit(c ?? 1))`;
    const run = (spareRoot: boolean) =>
      runSupervised({
        argv: [node, "-e", root],
        cwd: scratch(),
        env: {},
        timeoutMs: 20_000,
        rssLimitBytes: 250 << 20,
        spareExe: "/bin/sh",
        spareRoot,
      });
    const spared = await run(true);
    assert.equal(spared.killedFor, null);
    assert.equal(spared.exitCode, 0, JSON.stringify(spared));
    assert.ok((spared.memoryKills ?? 0) >= 1, JSON.stringify(spared));
    // The root runs as node, as an agent's command may: without its pid, it is not spared.
    const not = await run(false);
    assert.equal(not.signal, "SIGKILL", JSON.stringify(not));
  });

  test("a run that fills its directory is killed for disk", async () => {
    const dir = scratch();
    const r = await runSupervised({
      argv: [
        node,
        "-e",
        "const fs = require('fs'); const b = Buffer.alloc(1 << 20, 7); setInterval(() => fs.appendFileSync('fill.bin', b), 5)",
      ],
      cwd: dir,
      env: {},
      timeoutMs: 20_000,
      disk: { path: dir, limitBytes: 16 << 20 },
    });
    assert.equal(r.killedFor, "disk");
  });

  test("nothing a run started outlives it", async () => {
    const r = await runSupervised({
      argv: [
        node,
        "-e",
        "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref(); console.log(process.pid)",
      ],
      cwd: scratch(),
      env: {},
      timeoutMs: 10_000,
    });
    assert.equal(r.exitCode, 0);
    const pgid = Number(r.stdout.trim());
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(
      listProcesses().filter((p) => p.pgid === pgid),
      [],
    );
  });

  test("with no time limit, a run lasts as long as its command", async () => {
    const r = await runSupervised({
      argv: [node, "-e", "setTimeout(() => console.log('done'), 1200)"],
      cwd: scratch(),
      env: {},
    });
    assert.equal(r.killedFor, null);
    assert.equal(r.exitCode, 0);
    assert.ok(r.wallMs >= 1100, `wall ${r.wallMs}`);
  });

  test("left in the background, what a run started outlives it until its group is killed", async () => {
    const started = Date.now();
    // The background sleep holds the output pipe: the run ends all the same.
    const r = await runSupervised({
      argv: ["sh", "-c", "sleep 30 & echo started"],
      cwd: scratch(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      leaveBackground: true,
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /started/);
    // Well short of the background sleep's 30 s: the run did not wait for it. (Not tighter:
    // on a loaded machine without /proc, the per-tick process listing slows the timers.)
    assert.ok(Date.now() - started < 25_000, `${Date.now() - started} ms`);
    assert.ok(r.leftovers >= 1);
    const pgid = Number(r.pgid);
    assert.ok(
      listProcesses().some((p) => p.pgid === pgid),
      "the sleep runs on",
    );
    killScope({ pgid });
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(
      listProcesses().filter((p) => p.pgid === pgid),
      [],
    );
  });

  test("one user's runs under different groups are told apart", () => {
    const proc = (pid: number, uid: number, gids: number[]) => ({
      pid,
      pgid: pid,
      uid,
      gids,
      rssBytes: 1,
    });
    const procs = [
      proc(1, 10101, [10101, 10101, 10101, 10101]), // the lane's plain work
      proc(2, 10101, [10500, 10500, 10500, 10500]), // its dev run on the device
      proc(3, 10101, [10500, 10101, 10101, 10101]), // a dev process that ran a setgid file
      proc(4, 10102, [10500, 10500, 10500, 10500]), // another lane's dev run
    ];
    const pids = (scope: Parameters<typeof members>[0]) => members(scope, procs).map((p) => p.pid);
    assert.deepEqual(pids({ uid: 10101, gid: 10101 }), [1, 3]);
    assert.deepEqual(pids({ uid: 10101, gid: 10500 }), [2, 3]);
    assert.deepEqual(pids({ uid: 10101 }), [1, 2, 3]);
  });

  test("a lane's background work runs on until its role is killed; other roles leave none", async () => {
    const dir = scratch();
    const cwd = join(dir, "ws");
    mkdirSync(cwd);
    const runner = new LocalRunner(dir);
    const pgidOf = (r: { stdout: string }) => Number(r.stdout.trim());
    const alive = (pgid: number) => listProcesses().some((p) => p.pgid === pgid);
    const argv = ["sh", "-c", "sleep 30 & echo $$"];
    const lane = await runner.run({ role: "lane-1", argv, cwd, keepBackground: true });
    const builder = await runner.run({ role: "builder", argv, cwd, keepBackground: true });
    const dev = await runner.run({ role: "lane-1", argv, cwd, keepBackground: true, gpu: true });
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(alive(pgidOf(lane)), "the lane's sleep runs on");
    assert.ok(!alive(pgidOf(builder)), "a builder's does not");
    assert.ok(!alive(pgidOf(dev)), "nor does a dev run's");
    assert.ok((await runner.killRole("lane-1")) > 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(!alive(pgidOf(lane)), "the trial's end takes it");
  });

  test("the disk walk is capped in depth and entries", () => {
    const root = scratch();
    let p = root;
    for (let i = 0; i < 40; i++) {
      p = join(p, "d");
      mkdirSync(p);
    }
    assert.equal(diskUsage(root, 1000, 16).truncated, true);
    assert.equal(diskUsage(root, 10, 128).truncated, true);
    assert.equal(diskUsage(root).truncated, false);
  });

  test("the local runner refuses paths outside scratch, including through symlinks", async () => {
    const root = scratch();
    mkdirSync(join(root, "ok"));
    symlinkSync("/etc", join(root, "escape"));
    const runner = new LocalRunner(root);
    assert.ok(insideRoot(root, join(root, "ok")));
    assert.throws(() => insideRoot(root, join(root, "escape")), /outside scratch/);
    await assert.rejects(
      runner.run({ role: "run", argv: ["true"], cwd: "/tmp", timeoutMs: 1000 }),
      /outside scratch/,
    );
    await assert.rejects(runner.remove(join(root, "escape")), /outside scratch/);
  });
});

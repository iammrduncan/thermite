import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RunAsk } from "../../../src/core/api/harness/runs.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { RemoteRunner } from "../../../src/harness/judge/remote-runner.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { machineRssMib, RunHost } from "../../../src/harness/runner/host.ts";
import { CpuDriver } from "../../../src/harness/targets/cpu.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * Goal 206, step 2b: a runner process serves the core's runs. The core's judge builds and
 * measures through a RemoteRunner whose asks reach a RunHost in a folder of its own, through a
 * link that passes every ask and answer through JSON, as the bus does. A hill climb's start and a
 * candidate's judging go through it: the builds are on the runner, none on the core, the core
 * keeps their records and the baseline's files, and the verdict comes as on the core's own.
 */

describe("a runner process (goal 206)", () => {
  test("the core judges on it: its builds there, their records and the baseline's files on the core", async () => {
    let runnerRoot = "";
    const env = makeJudgeEnv({
      wrapRunner: (_core, made) => {
        runnerRoot = join(made.root, "runner");
        const paths = {
          stateDir: join(runnerRoot, "state"),
          scratchDir: join(runnerRoot, "scratch"),
          inboxDir: join(runnerRoot, "inbox"),
        };
        for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
        const host = new RunHost({
          runner: new LocalRunner(paths.scratchDir),
          drivers: [new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY })],
          paths,
          ledger: Ledger.open(join(paths.stateDir, "ledger", "ledger.db")),
        });
        // Every ask and answer through JSON, as the bus carries them.
        const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
        return new RemoteRunner({
          name: "box-2",
          link: {
            ask: async (a) => wire(await host.ask(RunAsk.parse(wire(a)))),
            sendGit: (repo, commit, bundle) => host.takeGit(repo, commit, Buffer.from(bundle)),
            fetchModels: async () => {
              throw new Error("this test's runner fetches no model files");
            },
          },
          card: 0,
          info: { type: "cpu", separated: false },
          ledger: made.ledger,
          mirrorFor: (repo) => made.service.mirrorFor(repo),
          scratchDir: made.service.paths.scratchDir,
        });
      },
    });
    await env.start();
    const r = await env.service.submitAttempt(
      { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "faster", known_flaws: [] },
      "proposer",
    );
    await env.drain();
    assert.ok(env.ledger.verdicts.current(r.attempt), env.explain(r.attempt));
    const builds = (root: string) => {
      try {
        return readdirSync(join(root, "state", "builds")).length;
      } catch {
        return 0;
      }
    };
    assert.ok(builds(runnerRoot) >= 2, "the runner built the seed and the candidate");
    assert.equal(builds(env.root), 0, "the core built nothing");
    const recorded = env.ledger.db.prepare("select count(*) as n from build").get() as {
      n: number;
    };
    assert.ok(recorded.n >= 2, "the core keeps the builds' records");
    const kept = readdirSync(join(env.paths.stateDir, "baselines", "js-1"));
    assert.equal(kept.length, 1, "the core keeps the run's baseline");
  });

  test("a lane's command on its change: the change on its parent, a workspace kept for the trial, gone at its end (step 3a)", async () => {
    let made: RemoteRunner | undefined;
    let runnerRoot = "";
    const env = makeJudgeEnv({
      wrapRunner: (core, m) => {
        runnerRoot = join(m.root, "runner-lanes");
        const paths = {
          stateDir: join(runnerRoot, "state"),
          scratchDir: join(runnerRoot, "scratch"),
          inboxDir: join(runnerRoot, "inbox"),
        };
        for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
        const host = new RunHost({
          runner: new LocalRunner(paths.scratchDir),
          drivers: [new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY })],
          paths,
          ledger: Ledger.open(join(paths.stateDir, "ledger", "ledger.db")),
        });
        const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
        made = new RemoteRunner({
          name: "box-3-0",
          link: {
            ask: async (a) => wire(await host.ask(RunAsk.parse(wire(a)))),
            sendGit: (repo, commit, bundle) => host.takeGit(repo, commit, Buffer.from(bundle)),
            fetchModels: async () => undefined,
          },
          card: 0,
          info: { type: "cpu", separated: false },
          ledger: m.ledger,
          mirrorFor: (repo) => m.service.mirrorFor(repo),
          scratchDir: m.service.paths.scratchDir,
        });
        return core;
      },
    });
    await env.start();
    const runner = made as RemoteRunner;
    const repo = String(env.ledger.runs.get("js-1")?.seed_repo);
    const parent = env.ledger.champions.current("js-1").commit_sha;
    // A change that adds one file, as a lane's workspace gives it.
    const change = (text: string) =>
      Buffer.from(
        `diff --git a/note.txt b/note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+${text}\n`,
      );
    const lane = {
      lane: "lane-1",
      trial: "t-0123456789abcdef",
      repo,
      parent,
      limits: { rssMib: 1024, diskMib: 1024 },
    };
    const first = (await runner.laneRun({
      ...lane,
      patch: change("first"),
      command: "cat note.txt; ls src/kernel",
    })) as { ran: boolean; stdout: string; note: string };
    assert.equal(first.ran, true, JSON.stringify(first));
    assert.match(first.stdout, /first/);
    assert.match(first.stdout, /work\.mjs/, "the workspace is the parent's tree");
    assert.match(first.note, /never counts/);
    // The next run of the trial: the workspace kept, set to the parent with the new change.
    const second = (await runner.laneRun({
      ...lane,
      patch: change("second"),
      command: "cat note.txt",
    })) as { stdout: string };
    assert.equal(second.stdout.trim(), "second");
    const lanes = join(runnerRoot, "scratch", "lanes", "lane-1");
    const workspaces = () => readdirSync(lanes).filter((n) => n !== "cache");
    assert.equal(workspaces().length, 1, "one workspace for the trial");
    await runner.laneEnd("lane-1", "t-0123456789abcdef");
    assert.equal(workspaces().length, 0, "it went when the trial ended");
  });

  test("on a lane's own runner, a run whose memory no one set gets the machine's less a margin (goal 219)", () => {
    // A 128 GB machine with no container limit: its memory less a tenth, about 107 GiB.
    assert.equal(machineRssMib(4096, 128e9, 0), 109_863);
    // In a container limited to 108 GiB on that machine: the container's, less a tenth.
    assert.equal(machineRssMib(4096, 128e9, 108 * 2 ** 30), 99_532);
    // A container limit above the machine's memory: the machine's.
    assert.equal(machineRssMib(4096, 16 * 2 ** 30, 2 ** 62), 12_288);
    // A small machine: less 4 GiB at the least; never less than the default the core sent.
    assert.equal(machineRssMib(4096, 16 * 2 ** 30, 0), 12_288);
    assert.equal(machineRssMib(8192, 8 * 2 ** 30, 0), 8192);
  });
});

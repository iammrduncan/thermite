import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RunAsk } from "../../../src/core/api/harness/runs.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { RemoteRunner } from "../../../src/harness/judge/remote-runner.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { RunHost } from "../../../src/harness/runner/host.ts";
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
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CallInput } from "../../src/common/api/call.ts";
import type { HarnessClient } from "../../src/common/api/harness.ts";
import { RUN, RUN_ASKS, RunAsk } from "../../src/core/api/harness/runs.ts";
import type { Route } from "../../src/core/api/route.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { RemoteRunner } from "../../src/harness/judge/remote-runner.ts";
import { RunnerLink } from "../../src/harness/judge/runner-link.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { RunHost } from "../../src/harness/runner/host.ts";
import { CpuDriver } from "../../src/harness/targets/cpu.ts";
import { answerCoreAsks, carryRunnerAsks } from "../../src/supervisor/runners/index.ts";
import { FakeBus } from "../helpers/fake-bus.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

/**
 * Goal 206, step 2c: the core's supervisor carries its harness's asks of a runner process on the
 * bus, and the runner's supervisor answers each from its harness. A git bundle, a long ask or an
 * answer larger than one message goes in parts.
 */

describe("a runner process reached over the bus (goal 206)", () => {
  test("a hill climb judged on the runner, through both supervisors and the bus", async () => {
    let stopped = false;
    const env = makeJudgeEnv({
      wrapRunner: (_core, made) => {
        const root = join(made.root, "runner");
        const paths = {
          stateDir: join(root, "state"),
          scratchDir: join(root, "scratch"),
          inboxDir: join(root, "inbox"),
        };
        for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
        const host = new RunHost({
          runner: new LocalRunner(paths.scratchDir),
          drivers: [new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY })],
          paths,
          ledger: Ledger.open(join(paths.stateDir, "ledger", "ledger.db")),
        });
        const bus = new FakeBus();
        const outboxDir = made.service.paths.outboxDir;
        const link = new RunnerLink({ outboxDir });
        const core = {
          call: async (route: Route, input?: CallInput<Route>) =>
            route.path === RUN_ASKS.path
              ? { asks: await link.take(2000) }
              : { ok: link.answer(String(input?.params?.id), (input?.body ?? {}) as object) },
        } as unknown as HarnessClient;
        const runner = {
          call: async (route: Route, input?: CallInput<Route>) => {
            if (route.path === RUN.path) return host.ask(RunAsk.parse(input?.body));
            const { repo, commit } = input?.params ?? {};
            await host.takeGit(String(repo), String(commit), Buffer.from(input?.bytes ?? []));
            return { ok: true };
          },
        } as unknown as HarnessClient;
        void answerCoreAsks({
          rig: "rig-a",
          runner: "box-2",
          bus,
          harness: runner,
          scratchDir: root,
        });
        void carryRunnerAsks({
          rig: "rig-a",
          bus,
          harness: core,
          outboxDir,
          stopping: () => stopped,
        });
        return new RemoteRunner({
          name: "box-2-0",
          link: link.to("box-2"),
          card: 0,
          info: { type: "cpu", separated: false },
          ledger: made.ledger,
          mirrorFor: (repo) => made.service.mirrorFor(repo),
          scratchDir: made.service.paths.scratchDir,
        });
      },
    });
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
      assert.ok(env.ledger.verdicts.current(id), env.explain(id));
    } finally {
      stopped = true;
    }
  });

  /** A core's link carried on a bus to a runner whose harness answers with `device`. */
  function wired(device: {
    ask?: (body: unknown) => Promise<unknown>;
    git?: (bytes: Uint8Array) => Promise<unknown>;
    inboxDir?: string;
    fetchImpl?: typeof fetch;
  }) {
    const bus = new FakeBus();
    const outboxDir = mkdtempSync(join(tmpdir(), "thermite-carry-"));
    const link = new RunnerLink({ outboxDir });
    let stopped = false;
    const core = {
      call: async (route: Route, input?: CallInput<Route>) =>
        route.path === RUN_ASKS.path
          ? { asks: await link.take(2000) }
          : { ok: link.answer(String(input?.params?.id), (input?.body ?? {}) as object) },
    } as unknown as HarnessClient;
    const runner = {
      call: async (route: Route, input?: CallInput<Route>) =>
        route.path === RUN.path
          ? device.ask?.(input?.body)
          : device.git?.(input?.bytes ?? new Uint8Array()),
    } as unknown as HarnessClient;
    void answerCoreAsks({
      rig: "rig-a",
      runner: "spark-02",
      bus,
      harness: runner,
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-answer-")),
      inboxDir: device.inboxDir,
      fetchImpl: device.fetchImpl,
    });
    void carryRunnerAsks({
      rig: "rig-a",
      bus,
      harness: core,
      outboxDir,
      stopping: () => stopped,
    });
    return {
      to: link.to("spark-02"),
      outboxDir,
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

  test("an ask longer than one message goes in parts, whole", async () => {
    let took: unknown;
    const w = wired({
      ask: async (body) => {
        took = body;
        return { ok: true };
      },
    });
    try {
      // A kept baseline of 6 MiB, in base64: longer than one message.
      const base64 = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");
      const ask = {
        op: "baseline_put" as const,
        run: "js-1",
        job: 3,
        files: [{ path: "baseline/out.bin", base64 }],
      };
      assert.deepEqual(await w.to.ask(ask), { ok: true });
      assert.deepEqual(took, ask, "the runner's harness has it whole");
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
      // The supervisor's outbox is read-only to it: it reads the bundle, and the harness, which
      // owns the outbox, removes it once the ask is answered.
      await w.to.sendGit("proj", "a".repeat(40), bundle);
      assert.ok(took && Buffer.from(took).equals(bundle), "the runner's harness has it whole");
      assert.deepEqual(readdirSync(join(w.outboxDir, ".runs")), [], "the bundle is gone");
    } finally {
      w.stop();
    }
  });

  test("a supervisor that starts again takes again the asks it took and never answered", async () => {
    const outboxDir = mkdtempSync(join(tmpdir(), "thermite-again-"));
    const link = new RunnerLink({ outboxDir });
    const bundle = Buffer.from("a bundle");
    const sent = link.to("spark-02").sendGit("proj", "b".repeat(40), bundle);
    const asked = link.to("spark-02").ask({ op: "info" });
    // A supervisor takes both, then stops before it answers.
    const first = await link.take(0);
    assert.equal(first.length, 2);
    assert.deepEqual(await link.take(0), [], "taken: not offered again on a later take");
    // The next one's first take has them again, the bundle's file still there to read.
    const again = await link.take(0, 16, true);
    assert.deepEqual(
      again.map((a) => a.id),
      first.map((a) => a.id),
    );
    const git = again.find((a) => a.kind === "git");
    assert.ok(git?.kind === "git" && existsSync(join(outboxDir, git.file)));
    for (const a of again) link.answer(a.id, { answer: { ok: true } });
    assert.deepEqual(await asked, { ok: true });
    await sent;
    assert.ok(git?.kind === "git" && !existsSync(join(outboxDir, git.file)));
  });

  test("a runner's supervisor fetches a run's model file from its source, and its harness takes it in", async () => {
    const bytes = Buffer.from("model weights");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const inboxDir = mkdtempSync(join(tmpdir(), "thermite-inbox-"));
    let took: unknown;
    const w = wired({
      inboxDir,
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
      ask: async (body) => {
        took = body;
        return { ok: true };
      },
    });
    try {
      const model = {
        name: "m",
        path: "models/m.bin",
        sha256,
        url: "https://models.example.com/m.bin",
      };
      await w.to.fetchModels([model]);
      assert.deepEqual(readFileSync(join(inboxDir, model.path)), bytes);
      assert.deepEqual(took, { op: "models_take", models: [{ path: model.path, sha256 }] });
    } finally {
      w.stop();
    }
  });

  test("a runner's refusal reaches the core's judge in its words", async () => {
    const w = wired({
      ask: async () => {
        throw new Error("this runner process has no runner 3");
      },
    });
    try {
      await assert.rejects(w.to.ask({ op: "throttle" }), /no runner 3/);
    } finally {
      w.stop();
    }
  });
});

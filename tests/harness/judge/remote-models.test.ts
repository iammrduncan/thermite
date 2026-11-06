import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ModelFetch,
  ModelFetchState,
  ModelPoll,
  RunAsk,
} from "../../../src/core/api/harness/runs.ts";
import { RemoteRunner } from "../../../src/harness/judge/remote-runner.ts";
import type { Ledger } from "../../../src/harness/ledger/index.ts";

/**
 * Goal 213: a run's model files on a runner of another machine, however large. The core begins
 * the runner's fetch and asks how it stands in turns, waiting as long as bytes come; a fetch that
 * stalls or a file that fails ends in words; a lane's run is told the files are on their way
 * instead of waiting for them.
 */

const A = "a".repeat(64);
const B = "b".repeat(64);
const MODELS = [
  { name: "tensors/model-1.safetensors", path: "m/1", sha256: A, url: "https://example.com/1" },
  { name: "tensors/model-2.safetensors", path: "m/2", sha256: B, url: "https://example.com/2" },
];

/** A runner whose fetch answers each turn from `turns`, the last repeated; and what it was asked. */
function runner(turns: ModelFetchState[][], o: { stallMs?: number } = {}) {
  const polls: ModelPoll[] = [];
  const asks: string[] = [];
  const ledger = {
    commands: { modelsOf: () => MODELS },
    trials: { get: () => ({ run: "r-1" }) },
  } as unknown as Ledger;
  const r = new RemoteRunner({
    name: "spark-2-0",
    link: {
      ask: async (a: RunAsk) => {
        asks.push(a.op);
        if (a.op === "models_have") return { missing: [A, B] };
        if (a.op === "git_has") return { has: true, heads: [] };
        if (a.op === "build") return { ok: true, cached: true, manifest: { key: "k" } };
        if (a.op === "lane_run") return { ran: true, exit: 0 };
        throw new Error(`not asked in this test: ${a.op}`);
      },
      sendGit: async () => undefined,
      fetchModels: async (files: ModelFetch[], poll: ModelPoll) => {
        assert.deepEqual(
          files.map((f) => f.sha256),
          [A, B],
        );
        polls.push(poll);
        return turns[Math.min(polls.length - 1, turns.length - 1)];
      },
    },
    card: 0,
    info: { type: "cuda-gpu", separated: true },
    ledger,
    mirrorFor: () => "/nonexistent",
    scratchDir: "/nonexistent",
    modelPollMs: 1,
    modelStallMs: o.stallMs ?? 60_000,
  });
  return { r, polls, asks };
}

const st = (sha256: string, state: ModelFetchState["state"], bytes: number, error?: string) => ({
  sha256,
  state,
  bytes,
  total: 100,
  ...(error ? { error } : {}),
});

const build = (r: RemoteRunner) =>
  r.build({
    repo: "proj",
    mirror: "/nonexistent",
    commit: "c".repeat(40),
    kit: {} as never,
    kitDir: "/nonexistent",
    kitRepo: "kit-x",
    kitCommit: "d".repeat(40),
    actor: "owner",
    run: "r-1",
  });

describe("a run's model files on a runner of another machine (goal 213)", () => {
  test("the judge's build waits through the fetch's turns as long as bytes come, then builds", async () => {
    const { r, polls, asks } = runner([
      [st(A, "fetching", 10), st(B, "queued", 0)],
      [st(A, "fetching", 60), st(B, "queued", 0)],
      [st(A, "done", 100), st(B, "fetching", 40)],
      [st(A, "done", 100), st(B, "done", 100)],
    ]);
    const b = await build(r);
    assert.equal(b.ok, true);
    assert.deepEqual(polls, ["start", "status", "status", "status"]);
    assert.deepEqual(asks, ["models_have", "git_has", "git_has", "build"]);
    // Held now: the next build asks for none.
    await build(r);
    assert.equal(polls.length, 4);
  });

  test("a fetch with no new byte for the stall time ends in words", async () => {
    const { r } = runner([[st(A, "fetching", 30), st(B, "queued", 0)]], { stallMs: 20 });
    await assert.rejects(
      build(r),
      /spark-2-0's fetch of the model files stopped at 0 of 2 files, 0\.0 of 0\.0 GiB: nothing came for/,
    );
  });

  test("a file that fails ends the fetch in words", async () => {
    const { r } = runner([[st(A, "failed", 0, "HTTP 404"), st(B, "queued", 0)]]);
    await assert.rejects(
      build(r),
      /runner spark-2-0 could not fetch the model file tensors\/model-1\.safetensors: HTTP 404/,
    );
  });

  test("a lane's run is told the files are on their way, and runs once they are there", async () => {
    const { r, polls } = runner([
      [st(A, "done", 100), st(B, "fetching", 50, "HTTP 503")],
      [st(A, "done", 100), st(B, "done", 100)],
    ]);
    const run = {
      lane: "lane-2",
      trial: "t-1",
      repo: "proj",
      parent: "c".repeat(40),
      patch: Buffer.from(""),
      command: "make && ./serve",
      limits: { rssMib: 1024, diskMib: 1024 },
    };
    const first = (await r.laneRun(run)) as { ran: boolean; reason?: string };
    assert.equal(first.ran, false);
    assert.match(
      first.reason ?? "",
      /on their way to this machine \(1 of 2 files, 0\.0 of 0\.0 GiB; the last try of tensors\/model-2\.safetensors failed: HTTP 503\); run again in a few minutes/,
    );
    assert.deepEqual(await r.laneRun(run), { ran: true, exit: 0 });
    // Each lane run begins (or goes on with) the fetch; none waits for it.
    assert.deepEqual(polls, ["start", "start"]);
  });
});

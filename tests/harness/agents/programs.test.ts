/**
 * The table of agent programs (goal 125, T7): one entry for each program a rig's agents may run
 * in, which the harness consults wherever it picks one.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CliCompacted } from "../../../src/agents/compaction/cli.ts";
import type { ModelConfig } from "../../../src/agents/model/index.ts";
import { HARNESSES, PROVIDER_TYPES, programForApi } from "../../../src/core/agents.ts";
import {
  AGENT_PROGRAMS,
  isCliProgram,
  programOf,
  researchProgramOf,
  researchRefusal,
  type TrialLink,
} from "../../../src/harness/agents/programs.ts";
import type { Runner, RunOutcome, RunRequest } from "../../../src/harness/broker/runner.ts";
import { fakeProgramRunner } from "../../helpers/fake-program.ts";

const route = (o: Partial<ModelConfig> = {}): ModelConfig => ({
  baseUrl: "https://p.example/v1",
  model: "m-1",
  apiKey: "k",
  contextWindow: 0,
  maxTokens: 0,
  ...o,
});

/** A trial's link to a stand-in harness: what it was told of usage and compactions. */
function link(runner: Runner, m: ModelConfig | undefined, scratchDir: string) {
  const usage: string[] = [];
  const compacted: { harness: string; c: CliCompacted }[] = [];
  const l: TrialLink = {
    runner,
    model: m,
    apiUrl: "http://127.0.0.1:8700",
    scratchDir,
    port: 8700,
    live: () => undefined,
    progress: () => undefined,
    submitted: () => undefined,
    compacted: (harness, c) => compacted.push({ harness, c }),
    handOver: (harness) => {
      usage.push(`open ${harness}`);
      return () => usage.push("close");
    },
    pollMs: 5,
  };
  return { link: l, usage, compacted };
}

describe("the agent programs", () => {
  test("one entry for each program: its name, whether it runs research, and whether a planner follows the workers there", () => {
    assert.deepEqual(Object.keys(AGENT_PROGRAMS), [...HARNESSES]);
    const rows = HARNESSES.map((h) => {
      const p = AGENT_PROGRAMS[h];
      return [p.id, p.name, p.research, p.plannerFollows, isCliProgram(h), p.ask !== undefined];
    });
    assert.deepEqual(rows, [
      ["pi", "Pi", true, true, false, false],
      ["opencode", "OpenCode", true, false, true, true],
      ["claude-code", "Claude Code", false, true, true, true],
      ["codex", "Codex", false, true, true, true],
    ]);
    // Each reaches what the route table says (core/agents.ts).
    assert.ok(AGENT_PROGRAMS["claude-code"].reaches("claude"));
    assert.ok(!AGENT_PROGRAMS.pi.reaches("opencode"));
    assert.ok(AGENT_PROGRAMS.codex.reaches(undefined));
    assert.equal(AGENT_PROGRAMS.pi.runsAs("lane-2"), "agent-2");
    assert.equal(AGENT_PROGRAMS.opencode.runsAs("lane-2"), "lane-2");
  });

  test("a route's trials run in the program it names, and its research trials in OpenCode or Pi", () => {
    assert.equal(programOf(undefined).id, "pi");
    for (const h of HARNESSES) assert.equal(programOf(route({ harness: h })).id, h);
    const research = HARNESSES.map((h) => researchProgramOf(route({ harness: h })).id);
    assert.deepEqual(research, ["pi", "opencode", "pi", "pi"]);
  });

  test("a model no research program can serve is refused in words", () => {
    assert.equal(
      researchRefusal(undefined),
      "this rig has no model for its agents: give it one on its Edit rig page",
    );
    assert.equal(
      researchRefusal(route({ api: "claude", harness: "claude-code" })),
      "research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research",
    );
    for (const harness of ["pi", "codex"] as const)
      assert.equal(
        researchRefusal(route({ api: "opencode", harness, model: "glm-free" })),
        "glm-free is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page",
      );
    assert.equal(researchRefusal(route({ api: "opencode", harness: "opencode" })), undefined);
    assert.equal(researchRefusal(route({ api: "chatgpt", harness: "codex" })), undefined);
    for (const h of HARNESSES) assert.equal(researchRefusal(route({ harness: h })), undefined, h);
    // Those two are the only kinds of provider neither Pi nor OpenCode reaches.
    const missed = PROVIDER_TYPES.filter(
      (t) => !AGENT_PROGRAMS.pi.reaches(t) && !AGENT_PROGRAMS.opencode.reaches(t),
    );
    assert.deepEqual(missed.map(programForApi), ["claude-code"]);
  });

  test("a trial in Pi runs its worker as the lane's agent user, with its model usage handed over while it runs", async () => {
    const runs: RunRequest[] = [];
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        // The worker's result, as its last line.
        return {
          exitCode: 0,
          signal: null,
          killedFor: null,
          stdout: JSON.stringify({
            stopped: "finished",
            turns: 1,
            toolCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
          }),
          stderr: "",
        } as RunOutcome;
      },
      handOver: async () => undefined,
      killRole: async () => 0,
      remove: async () => undefined,
    } as unknown as Runner;
    const scratch = mkdtempSync(join(tmpdir(), "thermite-programs-"));
    const l = link(runner, route(), scratch);
    const folder = { root: join(scratch, "folder"), work: join(scratch, "work") };
    const r = await AGENT_PROGRAMS.pi.runTrial(
      {
        mode: "research",
        spec: { trialId: "t-p", run: "r-1", lane: "lane-1", brief: "b" },
        folder,
      },
      l.link,
    );
    assert.equal(r.stopped, "finished");
    assert.deepEqual(l.usage, ["open pi", "close"]);
    assert.equal(runs[0]?.role, "agent-1");
    const handed = JSON.parse(readFileSync(join(scratch, "agents", "t-p", "trial.json"), "utf8"));
    assert.deepEqual([handed.kind, handed.spec.folder], ["research", folder]);
  });

  test("a research trial in OpenCode gets an area of its own in the lane, removed with what it started when it ends", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "thermite-programs-"));
    const work = join(scratch, "work");
    mkdirSync(work);
    const f = fakeProgramRunner("opencode", []);
    const l = link(f.runner, route({ harness: "opencode" }), scratch);
    const r = await AGENT_PROGRAMS.opencode.runTrial(
      {
        mode: "research",
        spec: { trialId: "t-o", run: "r-1", lane: "lane-1", brief: "b" },
        folder: { root: scratch, work },
      },
      l.link,
    );
    assert.equal(r.stopped, "finished");
    const area = f.handed[0]?.dir ?? "";
    assert.equal(f.handed[0]?.role, "lane-1");
    assert.ok(area.startsWith(join(scratch, "lanes", "lane-1")));
    assert.equal(f.programRuns()[0]?.cwd, work);
    assert.equal(f.programRuns()[0]?.env?.HOME, join(area, "opencode-home"));
    assert.deepEqual(f.killed, ["lane-1"]);
    assert.deepEqual(f.removed, [area]);
    assert.deepEqual(l.usage, [], "its usage is read from its output, not handed over");
  });

  test("a code trial in a command-line program records its compactions under the program's name", async () => {
    const a = mkdtempSync(join(tmpdir(), "thermite-programs-"));
    mkdirSync(join(a, "repo"));
    // Codex's note after its own compaction, in its first run.
    const f = fakeProgramRunner("codex", (n) => (n > 1 ? [] : compactedOnce));
    const l = link(f.runner, route({ api: "chatgpt", harness: "codex" }), a);
    const spec = {
      trialId: "t-c",
      run: "r-1",
      lane: "lane-1" as const,
      workspace: join(a, "repo"),
      workspaceRoot: a,
      parentCommit: "c".repeat(40),
      editablePaths: ["src/**"],
      brief: "b",
    };
    const r = await AGENT_PROGRAMS.codex.runTrial({ mode: "code", spec }, l.link);
    assert.equal(r.compactions, 1);
    assert.deepEqual(
      l.compacted.map((x) => x.harness),
      ["codex"],
    );
    // Without a route, a trial runs in Pi: a command-line program is never given one.
    await assert.rejects(
      AGENT_PROGRAMS.codex.runTrial({ mode: "code", spec }, link(f.runner, undefined, a).link),
      /^Error: Codex runs only on a model route$/,
    );
  });
});

/** Codex's output when it has compacted its thread once. */
const compactedOnce = [
  JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "i1",
      type: "error",
      message:
        "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.",
    },
  }),
];

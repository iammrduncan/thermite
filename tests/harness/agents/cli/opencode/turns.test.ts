import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runOpencodeTrial } from "../../../../../src/harness/agents/cli/opencode.ts";
import type { TrialSpec } from "../../../../../src/harness/agents/worker/index.ts";
import type { Runner, RunOutcome, RunRequest } from "../../../../../src/harness/broker/runner.ts";

const model = {
  baseUrl: "https://p.example/v1",
  model: "m-1",
  apiKey: "k",
  contextWindow: 0,
  maxTokens: 8192,
};
const step = JSON.stringify({
  type: "step_finish",
  sessionID: "ses_1",
  part: { tokens: { input: 1, output: 1 } },
});

test("an OpenCode code trial ends at Turns per trial, as the other programs' do (goal 163)", async () => {
  const area = mkdtempSync(join(tmpdir(), "thermite-oc-turns-"));
  const workspace = join(area, "repo");
  mkdirSync(workspace);
  let killed = 0;
  let release: () => void = () => undefined;
  const runner = {
    run: async (req: RunRequest): Promise<RunOutcome> => {
      if (req.argv.includes("run")) {
        // Three turns, then the agent would go on and on: only the cap can end it.
        appendFileSync(
          String(req.env?.THERMITE_OPENCODE_EVENTS),
          `${[step, step, step].join("\n")}\n`,
        );
        await new Promise<void>((r) => (release = r));
      }
      return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
    },
    killRole: async () => {
      killed++;
      release();
      return 1;
    },
  } as unknown as Runner;
  const spec: TrialSpec = {
    trialId: "t-1",
    token: "tok",
    run: "r-1",
    lane: "lane-1",
    workspace,
    workspaceRoot: area,
    parentCommit: "c".repeat(40),
    editablePaths: ["src/**"],
    brief: "Make it faster.",
    wallMs: 60_000,
    maxTurns: 2,
  };
  const r = await runOpencodeTrial(spec, {
    runner,
    model,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    submitted: () => undefined,
    pollMs: 5,
  });
  assert.equal(r.stopped, "turns");
  assert.ok(killed >= 1, "OpenCode stopped at the cap");
});

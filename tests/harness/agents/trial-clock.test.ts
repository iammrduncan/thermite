import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { trialBudget } from "../../../src/agents/roles/index.ts";
import { TrialClock } from "../../../src/harness/agents/trial-clock.ts";
import { runTrial } from "../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

const MIN = 60_000;
/** A clock whose time the test moves. */
const clockAt = (wallMs: number | undefined) => {
  let t = Date.UTC(2026, 9, 25, 18, 38, 0);
  const clock = new TrialClock(wallMs, () => t);
  const move = (ms: number) => {
    t += ms;
  };
  return { clock, move };
};
const said = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("\n");
const tool = (name: string, run: () => Promise<string>): AgentTool => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: await run() }], details: {} }),
});

describe("a trial's clock (goal 144)", () => {
  test("the brief gives the trial's end in UTC beside its length, and only what was set", () => {
    const end = Date.UTC(2026, 9, 25, 20, 38, 0);
    assert.equal(
      trialBudget(120, undefined, "", end),
      "This trial lasts 120 minutes, to 20:38 UTC. Submit before it ends.",
    );
    assert.equal(
      trialBudget(120, 50, "each model reply is one", end),
      "This trial lasts 120 minutes, to 20:38 UTC, and at most 50 turns (each model reply is one). Submit before it ends.",
    );
    // As before goal 144, where no end is given; an endless deadline is none.
    assert.equal(
      trialBudget(10, undefined, ""),
      "This trial lasts 10 minutes. Submit before it ends.",
    );
    assert.equal(
      trialBudget(10, undefined, "", Number.POSITIVE_INFINITY),
      "This trial lasts 10 minutes. Submit before it ends.",
    );
    assert.equal(
      trialBudget(undefined, 5, "one"),
      "This trial lasts at most 5 turns (one). Submit before it ends.",
    );
    assert.equal(trialBudget(undefined, undefined, ""), "Submit once your change works.");
  });

  test("a command ends 3 minutes before its trial does; nearer the end it gets a minute at most", () => {
    const { clock, move } = clockAt(120 * MIN);
    // Far from the end: the command's own limit, or the campaign's.
    assert.deepEqual(clock.commandTime(600, 3600), { timeoutMs: 600_000, cut: false });
    assert.deepEqual(clock.commandTime(undefined, 3600), { timeoutMs: 3_600_000, cut: false });
    // No limit asked or set: the trial's end, less the margin.
    assert.deepEqual(clock.commandTime(undefined), { timeoutMs: 117 * MIN, cut: true });
    // 10 minutes left: a build asked for 30 minutes gets 7.
    move(110 * MIN);
    assert.deepEqual(clock.commandTime(1800), { timeoutMs: 7 * MIN, cut: true });
    assert.deepEqual(clock.commandTime(60), { timeoutMs: MIN, cut: false });
    // 75 seconds left, as the dev run at 18:33 had: a minute at most, and never past the end.
    move(8 * MIN + 45_000);
    assert.deepEqual(clock.commandTime(600), { timeoutMs: MIN, cut: true });
    move(45_000);
    assert.deepEqual(clock.commandTime(600), { timeoutMs: 30_000, cut: true });
    move(60_000);
    assert.deepEqual(clock.commandTime(600), { timeoutMs: 1000, cut: true });
    // A command the clock stopped says so; one its own limit stopped, or that ended, doesn't.
    assert.match(
      clock.stoppedWords("timeout", { timeoutMs: 1000, cut: true }),
      /stopped by the trial's clock: a command ends 3 minutes before the trial does, so that you can submit\. About 1 minute is left in this trial\./,
    );
    assert.equal(clock.stoppedWords("timeout", { timeoutMs: 1000, cut: false }), "");
    assert.equal(clock.stoppedWords(null, { timeoutMs: 1000, cut: true }), "");
    // A trial with no length has no clock: the limits are as before.
    const none = clockAt(undefined).clock;
    assert.deepEqual(none.commandTime(600, 3600), { timeoutMs: 600_000, cut: false });
    assert.deepEqual(none.commandTime(undefined), { cut: false });
    assert.equal(none.late(), false);
  });

  test("from 75% of the trial, each tool result ends with the time left", async () => {
    const { clock, move } = clockAt(120 * MIN);
    const [ls] = clock.wrap([tool("run", async () => "exit 0")]);
    const call = () => (ls as AgentTool).execute("c", {}, new AbortController().signal);
    assert.equal(said(await call()), "exit 0");
    move(89 * MIN);
    assert.equal(said(await call()), "exit 0");
    move(MIN);
    assert.equal(said(await call()), "exit 0\nAbout 30 minutes are left in this trial.");
    move(29 * MIN);
    assert.equal(said(await call()), "exit 0\nAbout 1 minute is left in this trial.");
  });

  test("the trial's end stops a tool still running at once; a submission is waited for", async () => {
    const { clock } = clockAt(120 * MIN);
    let finish: (s: string) => void = () => undefined;
    const slow = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });
    const [run, submit] = clock.wrap([tool("dev_run", slow), tool("submit", slow)]) as AgentTool[];
    const end = new AbortController();
    const waiting = (run as AgentTool).execute("c", {}, end.signal);
    end.abort();
    assert.equal(said(await waiting), "The trial ended while this ran: the harness stops it.");
    // Already over before the call: the same answer, at once.
    assert.match(said(await (run as AgentTool).execute("c", {}, end.signal)), /trial ended/);
    const submitting = (submit as AgentTool).execute("c", {}, end.signal);
    let settled = false;
    void submitting.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, false, "a submission is not given up");
    finish("submitted a-1");
    assert.equal(said(await submitting), "submitted a-1");
  });

  test("a trial whose dev run never comes back ends at its length, with its result, not killed with none", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.champions.current("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    const fake = await startFakeModel(({ messages }) =>
      messages.some((m) => m.role === "tool")
        ? { text: "waiting" }
        : { toolCalls: [{ name: "dev_run", args: { command: "./bench", timeout_s: 600 } }] },
    );
    const asked: unknown[] = [];
    const t0 = Date.now();
    const r = await runTrial(
      {
        trialId: "t-clock",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 1500,
      },
      {
        runner,
        laneTool: [
          process.execPath,
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          fileURLToPath(new URL("../../../src/harness/agents/lanetool.ts", import.meta.url)),
        ],
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        // A dev run that waits for the device past the trial's end, as one may.
        devRun: (req) => {
          asked.push(req);
          return new Promise(() => undefined);
        },
      },
    );
    await fake.close();
    assert.equal(r.stopped, "wall", JSON.stringify(r));
    assert.match(r.error ?? "", /the trial reached its 0-minute limit before a submission/);
    assert.ok(Date.now() - t0 < 10_000, "it ends in seconds");
    // The dev run asked for 600 s; the clock gave it the time to the trial's end at most.
    assert.ok(((asked[0] as { timeoutS?: number }).timeoutS ?? 0) <= 2, JSON.stringify(asked[0]));
  });
});

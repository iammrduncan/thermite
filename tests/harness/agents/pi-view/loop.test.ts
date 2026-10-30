import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { laneLimits } from "../../../../src/core/contract.ts";
import type { McpToolInfo } from "../../../../src/core/mcp.ts";
import { PiConsole, PiView, ViewInputs } from "../../../../src/harness/agents/pi-view/index.ts";
import { runResearchTrial } from "../../../../src/harness/agents/research/index.ts";
import { type McpForAgent, runTrial } from "../../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { laneTool } from "../worker/setup.ts";

/**
 * The Pi view's console in a code trial's own loop (goal 169): the owner's inputs, given through
 * the harness's side of the view as the worker's routes give them, each one call in the loop. The
 * owner's words steer the agent before its next model call, or wait until it would stop; Esc
 * stops its reply, which is not the agent's own stop and counts no nudge; /compact compacts at
 * its next call; /mcp reconnect gives it the servers' new tools from its next turn; after its
 * submission nothing more goes in. What the model was sent shows each.
 */

const tool = (name: string): McpToolInfo => ({
  server: "docs",
  name,
  description: `the ${name} tool`,
  input_schema: { type: "object", properties: {} },
  reads: true,
});
const mcpOf = (names: string[]): McpForAgent => ({
  tools: names.map(tool),
  call: async () => ({ content: [{ type: "text", text: "found" }] }),
});

describe("the Pi view's console in a trial's loop", () => {
  test("each input is one call: steer, follow-up, interrupt, /compact, /mcp reconnect, /status; none after the submission", async () => {
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
    const piConsole = new PiConsole();
    const inputs: Promise<unknown>[] = [];
    const owner = (i: Parameters<PiConsole["ownerInput"]>[0]) => {
      inputs.push(piConsole.ownerInput(i));
    };
    let drawn = "";
    const view = new PiView({
      out: (d) => {
        drawn += d;
      },
      cols: 120,
      rows: 40,
      heading: "Thermite's view of a worker in Pi · trial t-view",
    });
    view.start();
    const console = new ViewInputs({
      view,
      ask: (ms) => piConsole.next(ms),
      answer: async (id, outcome, why) => piConsole.done(id, outcome, why),
      servers: ["docs"],
      relist: async () => mcpOf(["search", "fetch"]),
    });
    const seen: { step: string; text: string; tools: string[] }[] = [];
    let step = "brief";
    const model = await startFakeModel(({ messages, tools }) => {
      const text = JSON.stringify(messages);
      const names = tools.map((t) => t.function.name);
      // The compaction's summary: a call with no tools.
      if (!names.length) return { text: "SUMMARY-OF-THE-TRIAL" };
      seen.push({ step, text, tools: names });
      switch (step) {
        case "brief":
          step = "steered";
          owner({ text: "STEER-ONE: read the kernel first" });
          owner({ text: "/status" });
          return { toolCalls: [{ name: "list_files", args: {} }], delayMs: 300 };
        case "steered":
          step = "followed";
          owner({ text: "FOLLOW-ONE: then write it", follow_up: true });
          // A reply with no tool call: the agent would stop, and the follow-up goes in instead.
          return { text: "I stop here.", delayMs: 300 };
        case "followed":
          step = "interrupted";
          owner({ keys: ["esc"] });
          return { text: "a reply the owner stops", delayMs: 5_000 };
        case "interrupted":
          step = "reconnected";
          owner({ text: "/compact" });
          owner({ text: "/mcp reconnect" });
          return { toolCalls: [{ name: "list_files", args: {} }], delayMs: 300 };
        case "reconnected":
          step = "submitting";
          return {
            toolCalls: [
              { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            ],
          };
        case "submitting":
          step = "after";
          // Words sent while the submission runs never go in after it.
          owner({ text: "STEER-LATE" });
          return {
            toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
            delayMs: 300,
          };
        default:
          return { text: "done" };
      }
    });
    const r = await runTrial(
      {
        trialId: "t-view",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 120_000,
        // No nudge at all: a stop of the agent's own would end the trial.
        limits: { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), nudges: 0 },
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: model.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        mcp: mcpOf(["search"]),
        view: console,
      },
    );
    console.close();
    await piConsole.end();
    view.stop();
    await model.close();
    const at = (s: string) => seen.find((x) => x.step === s);

    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    // Steered: in the next call, as the owner's turn.
    assert.match(at("steered")?.text ?? "", /A message from the campaign's owner[^"]*STEER-ONE/);
    // The follow-up: given when the agent would stop, so the trial went on with it.
    assert.match(at("followed")?.text ?? "", /FOLLOW-ONE/);
    assert.doesNotMatch(at("steered")?.text ?? "", /FOLLOW-ONE/);
    // The interrupt stopped the reply; with no words waiting, the trial went on with its nudge,
    // though the campaign allows none: the owner's stop is not the agent's.
    assert.match(at("interrupted")?.text ?? "", /You have not called submit yet/);
    // /compact: compacted before the next call; /mcp reconnect: the new tool from the next turn.
    assert.equal(r.compactions, 1);
    assert.match(at("reconnected")?.text ?? "", /SUMMARY-OF-THE-TRIAL/);
    assert.ok(!at("interrupted")?.tools.includes("mcp__docs__fetch"));
    assert.ok(at("reconnected")?.tools.includes("mcp__docs__fetch"), "the new tool");
    // Nothing went in after the submission.
    assert.ok(!seen.some((x) => x.text.includes("STEER-LATE")));
    assert.equal(seen.at(-1)?.step, "submitting", "no call after the submission");
    // Every input was made as one call, and said so; the screen shows what each did.
    await Promise.all(inputs);
    assert.match(drawn, /\/status: model test/);
    assert.match(drawn, /interrupt: the agent's reply stops/);
    assert.match(drawn, /the MCP tools of this trial:/);
    assert.match(drawn, /the owner's words that waited do not go in/);
  });

  test("in a research trial, the owner's interrupt is not its end: it goes on, told to continue", async () => {
    const piConsole = new PiConsole();
    const view = new PiView({ out: () => undefined, cols: 100, rows: 30, heading: "research" });
    const console = new ViewInputs({
      view,
      ask: (ms) => piConsole.next(ms),
      answer: async (id, outcome, why) => piConsole.done(id, outcome, why),
      servers: [],
      relist: async () => mcpOf([]),
    });
    const sent: string[] = [];
    let interrupted: Promise<unknown> | undefined;
    const model = await startFakeModel(({ messages }) => {
      sent.push(JSON.stringify(messages));
      if (sent.length === 1) {
        interrupted = piConsole.ownerInput({ keys: ["esc"] });
        return { text: "a long reply the owner stops", delayMs: 5_000 };
      }
      return { text: "I have recorded what I found." };
    });
    const r = await runResearchTrial(
      { trialId: "t-research", run: "r-1", lane: "lane-1", brief: "Find out.", wallMs: 60_000 },
      {
        model: {
          baseUrl: model.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32_000,
          maxTokens: 2000,
        },
        call: async () => ({}),
        view: console,
      },
    );
    console.close();
    await piConsole.end();
    view.stop();
    await model.close();
    await interrupted;
    assert.equal(r.stopped, "finished", JSON.stringify(r));
    assert.equal(sent.length, 2, "it went on after the interrupt, once");
    assert.match(sent[1] ?? "", /Continue your research\./);
  });
});

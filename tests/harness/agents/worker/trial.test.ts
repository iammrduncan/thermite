/**
 * A worker's trial: a scripted agent that submits once, earlier replies' thinking never sent back,
 * and the live view with the owner's message.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runTrial } from "../../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { laneTool } from "./setup.ts";

describe("worker trial", () => {
  test("a scripted agent reads, edits, tests and submits once; the judge takes it from there", async () => {
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
    // The model: list, read, rewrite the kernel, run a quick check, submit.
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").length;
      const steps = [
        { name: "list_files", args: {} },
        { name: "read_file", args: { path: "src/kernel/work.mjs" } },
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
        {
          name: "run",
          args: {
            command:
              "node -e \"import('./src/kernel/work.mjs').then(m => console.log(m.work(14)))\"",
          },
        },
        { name: "submit", args: { hypothesis: "remove the wasted inner loop", known_flaws: [] } },
      ];
      const next = steps[done];
      return next ? { toolCalls: [next] } : { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t1",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(r.toolCalls, 5);
    assert.ok(r.tokensIn > 0);
    const a = env.ledger.attempts.get(r.submitted?.attempt ?? "");
    assert.equal(String(a?.lane), "lane-1");
    assert.equal(String(a?.lifecycle), "queued");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(String(a?.id))?.verdict, "win_confirmed");
  });

  test("earlier replies' thinking is never sent back to the model", async () => {
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
    const sent: string[] = [];
    const thinker = await startFakeModel(({ messages }) => {
      sent.push(JSON.stringify(messages));
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          thinking: "SECRET-REASONING-1 the inner loop is waste",
          toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }],
        };
      if (done === 1)
        return {
          thinking: "SECRET-REASONING-2 drop it",
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      return {
        toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
      };
    });
    const r = await runTrial(
      {
        trialId: "t-think",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: thinker.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await thinker.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(sent.length, 3);
    // The replies' tool calls went back; their reasoning never did.
    assert.match(sent[2] ?? "", /write_file/);
    assert.ok(
      sent.every((m) => !m.includes("SECRET-REASONING")),
      sent.join("\n"),
    );
  });

  test("the live view: a worker's turns stream out, and the owner's message arrives as a user turn, read once the agent takes it", async () => {
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
    let sawOwner = false;
    const fake = await startFakeModel(({ messages }) => {
      sawOwner ||= messages.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("use the fast kernel"),
      );
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          text: "Reading first.",
          toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }],
        };
      if (!sawOwner) return { text: "Still thinking." };
      if (done === 1)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      return {
        toolCalls: [{ name: "submit", args: { hypothesis: "as the owner said", known_flaws: [] } }],
      };
    });
    const lines: { kind: string; text: string }[] = [];
    // Waiting until confirmed, as the harness keeps it: the worker must not take it twice.
    let pending = [{ id: 7, text: "use the fast kernel" }];
    const reads: number[][] = [];
    const r = await runTrial(
      {
        trialId: "t-live",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        link: {
          live: async (entries) => {
            lines.push(...entries);
          },
          messages: async () => pending,
          read: async (ids) => {
            reads.push(ids);
            pending = pending.filter((m) => !ids.includes(m.id));
          },
        },
      },
    );
    await fake.close();
    assert.ok(sawOwner, "the model saw the owner's message");
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.deepEqual(reads, [[7]], "confirmed once, when the agent took it");
    const kinds = new Set(lines.map((l) => l.kind));
    for (const k of ["text", "tool", "result"]) assert.ok(kinds.has(k), `a ${k} line`);
    assert.ok(lines.some((l) => l.kind === "tool" && l.text.startsWith("read_file")));
  });
});

/**
 * A worker's tools: calls run one at a time and none after a submission; the idea tool and the note
 * tool leave its trial going on.
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
  test("tool calls run one at a time, and nothing runs after a submission in the same turn", async () => {
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
    // Turn 1 writes and checks in one batch; turn 2 submits and then tries to write again.
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0) {
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            { name: "run", args: { command: "grep -c . src/kernel/work.mjs" } },
          ],
        };
      }
      if (done === 2) {
        return {
          toolCalls: [
            { name: "submit", args: { hypothesis: "faster" } },
            { name: "submit", args: { hypothesis: "again" } },
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: "late" } },
          ],
        };
      }
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t2",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "b",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "t",
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
    const n = env.ledger.db.prepare("select count(*) as n from attempt").get();
    assert.equal(Number(n?.n), 1, "one submission");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(`${ws.repo}/src/kernel/work.mjs`, "utf8"), FAST_KERNEL);
  });

  test("a worker proposes an idea for the run's queue with its idea tool, and its trial goes on", async () => {
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
    const replies: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const tools = messages.filter((m) => m.role === "tool");
      if (tools.length) replies[tools.length - 1] = JSON.stringify(tools.at(-1)?.content);
      if (tools.length === 0)
        return {
          toolCalls: [
            {
              name: "idea",
              args: { title: "unroll the tail", why: "the profile", family: "unroll" },
            },
          ],
        };
      if (tools.length === 1) return { toolCalls: [{ name: "idea", args: { title: "  " } }] };
      if (tools.length === 2)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (tools.length === 3) return { toolCalls: [{ name: "submit", args: { hypothesis: "h" } }] };
      return { text: "done" };
    });
    const ideas: unknown[] = [];
    const r = await runTrial(
      {
        trialId: "t3",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "b",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "t",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        idea: async (req) => {
          ideas.push(req);
          return { experiment: "x-0123456789ab" };
        },
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", "the idea did not end the trial");
    assert.equal(r.toolCalls, 4);
    assert.deepEqual(ideas, [
      { title: "unroll the tail", why: "the profile", family: "unroll", details: undefined },
    ]);
    assert.match(
      String(replies[0]),
      /proposed x-0123456789ab: it waits until the planner or the campaign.s owner queues it/,
    );
    assert.match(String(replies[1]), /an idea needs a title/);
  });

  test("a worker keeps field notes with its note tool, and its trial goes on", async () => {
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
    const replies: string[] = [];
    let system = "";
    const fake = await startFakeModel(({ messages }) => {
      system ||= JSON.stringify(
        messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "",
      );
      const tools = messages.filter((m) => m.role === "tool");
      if (tools.length) replies[tools.length - 1] = JSON.stringify(tools.at(-1)?.content);
      const steps = [
        {
          name: "note",
          args: {
            kind: "Observation",
            text: " the loop is memory bound ",
            about: { type: "trial", id: "t4" },
          },
        },
        { name: "note", args: { kind: "lesson", text: "  " } },
        { name: "note", args: { kind: "rumour", text: "refused by the harness" } },
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
        { name: "submit", args: { hypothesis: "h" } },
      ];
      const step = steps[tools.length];
      return step ? { toolCalls: [step] } : { text: "done" };
    });
    const notes: unknown[] = [];
    const r = await runTrial(
      {
        trialId: "t4",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "b",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "t",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        note: async (req) => {
          if (req.kind === "rumour") throw new Error("400: kind: invalid option");
          notes.push(req);
          return { note: notes.length };
        },
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", "notes did not end the trial");
    assert.deepEqual(notes, [
      { kind: "observation", text: "the loop is memory bound", about: { type: "trial", id: "t4" } },
    ]);
    assert.match(String(replies[0]), /noted \(#1\)\. Your trial goes on/);
    assert.match(String(replies[1]), /a note needs its text/);
    assert.match(String(replies[2]), /the note was not recorded: 400: kind/);
    assert.match(system, /keep field notes with the note tool/);
    assert.match(system, /Never note what you tried and its result/);
  });
});

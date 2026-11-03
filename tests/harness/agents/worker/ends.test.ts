/**
 * When a worker's trial ends: a model that stops early is told to go on, a configured turn cap ends
 * it and none does by default, and a cut-off reply or a failed call never ends it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { laneLimits } from "../../../../src/core/contract.ts";
import { runTrial } from "../../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { laneTool } from "./setup.ts";

describe("worker trial", () => {
  test("a model that stops early is told to go on while it works; a nudge it answers without work ends it; why it stopped is recorded (goal 079)", async () => {
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
    const trial = (url: string, nudges?: number) =>
      runTrial(
        {
          trialId: "t-nudge",
          run: "js-1",
          lane: "lane-1",
          workspace: ws.repo,
          parentCommit: champion.commit_sha,
          editablePaths: ["src/kernel/**"],
          brief: "Make work() faster without changing its result.",
          wallMs: 60_000,
          maxTurns: 40,
          ...(nudges !== undefined
            ? { limits: { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), nudges } }
            : {}),
        },
        {
          runner,
          laneTool,
          model: {
            baseUrl: url,
            model: "test",
            apiKey: "k",
            contextWindow: 32000,
            maxTokens: 2000,
          },
          submit: (req) =>
            env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
          status: async (id) => env.service.attemptStatus(id),
        },
      );
    // Thinks aloud first; after the nudge it writes the change and submits.
    const late = await startFakeModel(({ messages }) => {
      const nudged = messages.some(
        (m) => m.role === "user" && String(JSON.stringify(m.content)).includes("not called submit"),
      );
      if (!nudged) return { text: "I would start by reading the kernel." };
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 1)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await trial(late.url);
    await late.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    // Never uses a tool: one nudge, answered without any work, then no submission, with the
    // reason. Its own choice: no number of nudges ends it.
    let requests = 0;
    const idle = await startFakeModel(() => {
      requests++;
      return { text: "Nothing to do." };
    });
    const r2 = await trial(idle.url);
    await idle.close();
    assert.equal(r2.stopped, "no_submission");
    assert.equal(requests, 2);
    assert.match(String(r2.error), /the model stopped \(stop\)/);
    // Works after each nudge (a tool call), then stops again: told to go on past two nudges, as
    // long as it works, and its fifth stop ends in a submission.
    const worker = () =>
      startFakeModel(({ messages }) => {
        const nudged = messages.filter(
          (m) =>
            m.role === "user" && String(JSON.stringify(m.content)).includes("not called submit"),
        ).length;
        const last = messages.at(-1);
        if (nudged >= 4)
          return messages.filter((m) => m.role === "tool").length > 4
            ? { toolCalls: [{ name: "submit", args: { hypothesis: "h", known_flaws: [] } }] }
            : {
                toolCalls: [
                  {
                    name: "write_file",
                    args: { path: "src/kernel/work.mjs", content: FAST_KERNEL },
                  },
                ],
              };
        return last?.role === "tool"
          ? { text: "I stop here." }
          : { toolCalls: [{ name: "list_files", args: {} }] };
      });
    const busy = await worker();
    const r3 = await trial(busy.url);
    await busy.close();
    assert.equal(r3.stopped, "submitted", JSON.stringify(r3));
    // With the campaign's nudges of 2, the third stop ends it.
    const capped = await worker();
    const r4 = await trial(capped.url, 2);
    await capped.close();
    assert.equal(r4.stopped, "no_submission");
  });

  test("a configured turn cap is stated, warned of once, and reported as a limit, not a model error", async () => {
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
    const seen: string[] = [];
    // Reads a file every turn and never submits.
    const busy = await startFakeModel(({ messages }) => {
      seen.push(JSON.stringify(messages.filter((m) => m.role === "user").map((m) => m.content)));
      return { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] };
    });
    const r = await runTrial(
      {
        trialId: "t-budget",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
        maxTurns: 14,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: busy.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: async () => {
          throw new Error("not expected");
        },
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await busy.close();
    assert.equal(r.stopped, "turns");
    // The call the limit aborted ends as one more turn.
    assert.ok(r.turns >= 14 && r.turns <= 15, String(r.turns));
    assert.equal(r.error, "the trial reached its limit of 14 turns before a submission");
    assert.match(seen[0] ?? "", /lasts 10 minutes, to \d\d:\d\d UTC, and at most 14 turns/);
    const warnedAt = seen.findIndex((u) => u.includes("turns are left in this trial"));
    assert.equal(warnedAt, 4, "warned once, after turn 4 (10 turns before the limit)");
    assert.equal(seen.at(-1)?.split("turns are left").length, 2, "only once");
    // A trial that measures is told to record its numbers before the end.
    assert.match(seen[warnedAt] ?? "", /record what you measured now as notes, with the numbers/);
  });

  test("without a configured cap a trial is not cut off by its number of turns", async () => {
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
    let first = "";
    // 70 turns of reading (past the old default of 60), then the change and a submission.
    const long = await startFakeModel(({ messages }) => {
      first ||= JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "");
      const done = messages.filter((m) => m.role === "tool").length;
      if (done < 70) return { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] };
      if (done === 70)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 71)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t-long",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: long.url,
          model: "test",
          apiKey: "k",
          contextWindow: 200000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await long.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.ok(r.turns > 70, String(r.turns));
    assert.match(first, /This trial lasts 10 minutes, to \d\d:\d\d UTC\. Submit before it ends/);
    assert.doesNotMatch(first, /turns/);
  });

  test("a reply cut off at the output limit or a failed call never ends a trial", async () => {
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
    let calls = 0;
    const said: string[] = [];
    const lines: { kind: string; text: string }[] = [];
    const progress: { turns: number; tool_calls: number; tokens_in: number; tokens_out: number }[] =
      [];
    // Four replies cut off while thinking, then two failed calls, then the change and a submission.
    const flaky = await startFakeModel(({ messages }) => {
      calls++;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      said.push(JSON.stringify(lastUser?.content ?? ""));
      if (calls <= 4)
        return {
          text: "Let me think about the loop structure in depth",
          cutOff: true,
          usage: { prompt: 3000, completion: 2000 },
        };
      if (calls <= 6) return { fail: 503 };
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 1)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t-flaky",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: flaky.url,
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
          progress: async (p) => {
            progress.push(p);
          },
        },
      },
    );
    await flaky.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    // After each turn the session reports its counters, which grow (the harness keeps the last).
    assert.ok(progress.length >= 2, JSON.stringify(progress));
    const last = progress.at(-1);
    assert.ok(last && last.turns === progress.length && last.tool_calls >= 1);
    assert.ok((last?.tokens_in ?? 0) >= 4 * 3000, JSON.stringify(last));
    assert.ok(
      said.some((u) => u.includes("cut off at the output limit")),
      said.join("\n"),
    );
    assert.ok(
      said.some((u) => u.includes("The model call failed")),
      said.join("\n"),
    );
    // The live view says how each abnormal reply ended.
    assert.ok(
      lines.some((l) => l.text.startsWith("(reply ended: length; 3000 tokens in, 2000 out")),
      JSON.stringify(lines),
    );
    assert.ok(
      lines.some((l) => l.text.startsWith("(reply ended: error")),
      JSON.stringify(lines),
    );
  });
});

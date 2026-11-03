/**
 * A worker's knowledge-base tools in Pi (goal 175): its trial holds kb_search, kb_read and
 * kb_write, run for the trial's own slot; a write lands in worker-<lane>, and one that names a slot
 * is refused; a search waits for the supervisor's channel and comes back with control's answer;
 * each call counts in the trial, and none runs after its submission. A role the campaign lets write
 * nothing gets kb_search and kb_read alone.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runTrial } from "../../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { laneTool } from "./setup.ts";

const RUN = "js-1";

/** A judge's run with lane-1's workspace on its champion. */
async function setup() {
  const env = makeJudgeEnv();
  await env.service.applyCommand(env.assign);
  const runner = new LocalRunner(env.paths.scratchDir);
  const champion = env.ledger.champions.current(RUN);
  const ws = await prepareWorkspace({
    runner,
    scratchDir: env.paths.scratchDir,
    mirror: env.service.mirrorFor("proj"),
    commit: champion.commit_sha,
    lane: "lane-1",
  });
  const spec = (kbWrites: string[]) => ({
    trialId: "t-kb",
    run: RUN,
    lane: "lane-1",
    workspace: ws.repo,
    parentCommit: champion.commit_sha,
    editablePaths: ["src/kernel/**"],
    brief: "b",
    wallMs: 60_000,
    maxTurns: 20,
    kbWrites,
  });
  const deps = (url: string) => ({
    runner,
    laneTool,
    model: { baseUrl: url, model: "t", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
    submit: (req: Parameters<typeof env.service.submitAttempt>[0]) =>
      env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
    status: async (id: string) => env.service.attemptStatus(id),
    // As the harness wires a trial's tools: its slot is the trial's lane's, never the agent's word.
    kb: env.service.kbTools.callFor({ run: RUN, slot: "worker-1" }),
  });
  return { env, spec, deps };
}

describe("a worker's knowledge-base tools in Pi", () => {
  test("kb_search reaches control through the supervisor's channel, kb_write keeps an item in the trial's own slot, a write naming a slot is refused, and nothing runs after the submission", async () => {
    const { env, spec, deps } = await setup();
    // The supervisor's side of the channel: each search waits for it, and gets control's answer.
    const asked: unknown[] = [];
    let relaying = true;
    const relay = (async () => {
      while (relaying)
        for (const a of await env.service.kbAsks.take(100)) {
          asked.push(a.ask);
          env.service.kbAsks.answer(a.id, {
            matched: 1,
            hits: [{ address: "js-sum/js-0/worker-2/finding:1", title: "Unrolling gave nothing" }],
          } as never);
        }
    })();
    const replies: string[] = [];
    const offered: string[][] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      offered.push(tools.map((t) => t.function.name));
      const results = messages.filter((m) => m.role === "tool");
      results.forEach((m, i) => {
        replies[i] = JSON.stringify(m.content);
      });
      const steps = [
        [{ name: "kb_search", args: { query: "unrolling" } }],
        [
          {
            name: "kb_write",
            args: { kind: "finding", title: "Tiling helps", text: "Blocks of 32 made it faster." },
          },
        ],
        [{ name: "kb_write", args: { kind: "note", title: "x", text: "y", slot: "planner" } }],
        [{ name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } }],
        [
          { name: "submit", args: { hypothesis: "tiling" } },
          { name: "kb_write", args: { kind: "note", title: "Late", text: "after it" } },
        ],
      ];
      const step = steps[results.length];
      return step ? { toolCalls: step } : { text: "done" };
    });
    try {
      const r = await runTrial(spec(env.service.kbTools.writes(RUN, "worker-1")), deps(fake.url));
      assert.equal(r.stopped, "submitted", JSON.stringify(r));
      // Five calls before the submission, the submission, and the late write: each counted.
      assert.equal(r.toolCalls, 6);
    } finally {
      relaying = false;
      await relay;
      await fake.close();
    }
    for (const name of ["kb_search", "kb_read", "kb_write"])
      assert.ok(offered[0]?.includes(name), `${name} offered: ${offered[0]?.join(", ")}`);
    assert.deepEqual(asked, [{ run: RUN, q: "unrolling" }]);
    assert.match(String(replies[0]), /js-sum\/js-0\/worker-2\/finding:1/);
    assert.match(String(replies[1]), /kept: js-sum\/js-1\/worker-1\/finding:1, item 1, version 1/);
    assert.match(String(replies[2]), /kb_write takes no slot: you write only in your own slot/);
    assert.match(String(replies[5]), /the trial ended with your submission/);
    // One item, in the trial's own slot, written by it: the refused and the late ones are not.
    const written = env.service.ledger.events.list("kb_item", { subject: RUN });
    assert.deepEqual(
      written.map((e) => [e.actor, e.body.slot, e.body.kind, e.body.title]),
      [["worker-1", "worker-1", "finding", "Tiling helps"]],
    );
  });

  test("a role the campaign lets write nothing gets kb_search and kb_read, and no kb_write", async () => {
    const { spec, deps } = await setup();
    let offered: string[] = [];
    const fake = await startFakeModel(({ tools }) => {
      offered = tools.map((t) => t.function.name);
      return { text: "nothing to do" };
    });
    try {
      await runTrial(spec([]), deps(fake.url));
    } finally {
      await fake.close();
    }
    assert.ok(offered.includes("kb_search") && offered.includes("kb_read"), offered.join(", "));
    assert.ok(!offered.includes("kb_write"), offered.join(", "));
  });
});

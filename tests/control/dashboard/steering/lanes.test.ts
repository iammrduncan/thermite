import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { ModelSource } from "../../../../src/harness/agents/model/source.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { form, recipients } from "./page.ts";
import { stack } from "./stack.ts";

/**
 * Live's lanes: a lane works while the ledger has its trial at work, and the box says when
 * each harness's workers read a message.
 */

describe("Live's lanes", () => {
  test("a lane works while the ledger has its trial at work; Restart the lanes in Live's header, or a restart of the harness, ends it", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    const s = await stack(env);
    await env.start();
    await s.sync();
    // Trials that work until they are stopped: each says so in its first line.
    const trials: string[] = [];
    let begun = () => {};
    let began = new Promise<void>((r) => {
      begun = r;
    });
    const model = {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "steering-ui-test",
      plannerOn: () => false,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      runTrial: (spec, signal) =>
        new Promise((resolve) => {
          trials.push(spec.trialId);
          env.service.trialReport(
            { id: spec.trialId, run: spec.run, lane: spec.lane },
            { entries: [{ kind: "text", text: "Working on it." }] },
          );
          signal.addEventListener("abort", () =>
            resolve({ stopped: "error", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          );
          begun();
        }),
    });
    const LIVE = "/ui/campaigns/js-sum/runs/js-1/live";
    /** Whether Live's lane-1 filter marks the lane as working. */
    const working = (html: string) =>
      /data-w="lane-1"[^>]*>(<span class="dot ok"><\/span>)?lane-1</.exec(html)?.[1] !== undefined;
    /** Each trial on the rig's own live view: working or ended. */
    const onRig = async () =>
      Object.fromEntries(
        [
          ...(await s.get("/ui/rigs/rig-a/live")).matchAll(
            /live\?source=trial%3A(t-[0-9a-f]+)"[\s\S]*?<span class="right">(?:<span class="muted xs">(ended)<\/span>|<span class="label info xs"><span class="dot info pulse"><\/span>(working)<\/span>)/g,
          ),
        ].map((m) => [m[1], m[2] ?? m[3]]),
      );
    assert.ok(await scheduler.tick(), "lane-1's trial started");
    await began;
    await s.sync();
    const [first] = trials;
    assert.deepEqual(await onRig(), { [String(first)]: "working" });
    let live = await s.get(LIVE);
    assert.ok(working(live), "lane-1 is at work");

    // ⋯ › Restart the lanes, in Live's header: the command goes, and the page comes back.
    const restart = form(live, "Restart the lanes", '<div class="lhead">');
    assert.deepEqual(
      [restart.fields.kind, restart.fields.run, restart.fields.back],
      ["reset_workers", "js-1", "/ui/campaigns/js-sum/runs/js-1/live"],
    );
    assert.ok(
      (await s.submit(restart)).startsWith(
        "/ui/campaigns/js-sum/runs/js-1/live?sent=Sent to rig-a at ",
      ),
    );
    began = new Promise<void>((r) => {
      begun = r;
    });
    await s.sync(); // the command reaches the harness
    // The lane's trial ends as interrupted, and the next round starts with a new one.
    assert.ok(await scheduler.tick(), "round 2 started");
    await began;
    await s.sync();
    const second = String(trials[1]);
    assert.deepEqual(await onRig(), { [String(first)]: "ended", [second]: "working" });
    live = await s.get(LIVE);
    assert.equal(live.match(/<b>lane-1<\/b> · trial ended/g)?.length, 1);
    assert.match(
      await s.get("/ui/campaigns/js-sum/runs/js-1/history"),
      /You restarted the lanes: their trials ended, and every lane starts again from the champion\./,
    );

    // The harness restarts while the second trial works: that trial never writes that it
    // ended. The restarted harness closes it as interrupted, and the lane no longer works.
    new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "restarted",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await s.sync();
    assert.deepEqual(await onRig(), { [String(first)]: "ended", [second]: "ended" });
    live = await s.get(LIVE);
    assert.ok(!working(live), "lane-1 is no longer at work");
    assert.equal(
      live.match(/<b>lane-1<\/b> · trial ended/g)?.length,
      1,
      "no line says the second trial ended",
    );
  });

  test("the box says when each program's workers read a message: Pi at its next step, OpenCode, Claude Code and Codex when their run ends", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    const s = await stack(env);
    await env.start();
    env.service.trialReport(
      { id: "t-1111111111111111", run: "js-1", lane: "lane-1" },
      { entries: [{ kind: "text", text: "Working on it." }] },
    );
    const dir = mkdtempSync(join(tmpdir(), "thermite-route-"));
    /** The rig's agents in `harness`, as its next report says: the box's two hints. */
    const hints = async (harness: NonNullable<ModelConfig["harness"]>) => {
      env.service.models = new ModelSource(join(dir, `${harness}.json`), {
        harness,
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 32000,
        maxTokens: 2000,
      });
      await s.sync();
      const to = recipients(await s.get("/ui/campaigns/js-sum/runs/js-1/live"));
      return [to.find((o) => o.to === "all")?.hint, to.find((o) => o.to === "lane-1")?.hint];
    };
    assert.deepEqual(await hints("pi"), [
      "Each agent reads it at its next step; the planner at its next plan",
      "lane-1 reads it at its next step",
    ]);
    const atRunEnd = [
      "Each agent reads it when its current run ends; the planner at its next plan",
      "lane-1 reads it when its current run ends, or in its next trial",
    ];
    assert.deepEqual(await hints("opencode"), atRunEnd);
    assert.deepEqual(await hints("claude-code"), atRunEnd);
    assert.deepEqual(await hints("codex"), atRunEnd);
  });
});

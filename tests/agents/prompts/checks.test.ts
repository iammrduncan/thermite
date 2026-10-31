import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { checkModel } from "../../../src/harness/agents/model/check.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import { runTrial } from "../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";
import { golden, laneTool, PLAN, recorder } from "./capture.ts";

/**
 * The prompts the harness sends on the agents' behalf: the compaction summary and the model check
 * (goal 166).
 */
describe("every role's whole prompt for a sample run (goal 166)", () => {
  test("the compaction summary, in Pi, of a worker's conversation past its compaction point", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    // The worker's first call reports a conversation near its window: the harness then asks the
    // same model for a summary before the next call.
    const { sent, script } = recorder(({ tools, messages }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) return PLAN;
      if (!tools.length) return { text: "The worker listed the files and read nothing yet." };
      if (!messages.some((m) => m.role === "tool"))
        return {
          toolCalls: [{ name: "list_files", args: {} }],
          usage: { prompt: 31_000, completion: 20 },
        };
      return { text: "done" };
    });
    const fake = await startFakeModel(script);
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "prompts-test",
      runTrial: (spec) =>
        runTrial(spec, {
          runner,
          laneTool,
          model,
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
        }),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    golden("compaction.pi", sent.get("compaction"), paths);
  });

  test("the model check, in Pi", async () => {
    const { sent, script } = recorder(() => ({
      toolCalls: [{ name: "echo", args: { text: "ok" } }],
    }));
    const fake = await startFakeModel(script);
    await checkModel({
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    });
    await fake.close();
    // Its texts are too short to name it by: the one request sent is the model check's. Its word
    // is new each time.
    assert.equal(sent.size, 1);
    const [check] = [...sent.values()];
    assert.ok(check);
    const word = (t: string) => t.replace(/thermite-[a-z0-9]+/g, "thermite-<word>");
    golden("model-check.pi", { ...check, first: word(check.first) }, [tmpdir()]);
  });
});

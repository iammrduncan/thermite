import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, type TestContext, test } from "node:test";
import { type CommandKind, signEnvelope } from "../../../src/core/commands.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { briefText } from "../../helpers/brief-text.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

type Env = ReturnType<typeof makeJudgeEnv>;

async function command(env: Env, kind: CommandKind, payload: unknown) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
}

/** What differs from one test run to the next: paths, commits, ids and times. */
function steady(text: string, root: string): string {
  return text
    .split(root)
    .join("<root>")
    .replace(/\b[0-9a-f]{40}\b/g, "<commit>")
    .replace(/\b[0-9a-f]{12}\b/g, "<commit12>")
    .replace(/\b([atxp])-[0-9a-f]{12,16}\b/g, "<$1-id>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
    .replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, "<time>");
}

/**
 * A hill-climb trial's brief, whole (goal 166): the worker's first message, as the scheduler
 * puts it together from the contract, the queue, the planner's hand-out, the judge, field notes
 * and the owner's messages. Held byte for byte against golden/worker.brief.txt, so that moving
 * how it is built changes nothing; UPDATE_GOLDEN=1 rewrites the file.
 */
async function briefOfOneTrial(t: TestContext): Promise<string> {
  const env = makeJudgeEnv({
    lanes: { count: 1, trials_per_epoch: 1 },
    contract: {
      notes: "The kernel sums a list. Earlier work found the loop bound by memory reads.",
      ideas: ["unroll the loop"],
      links: ["https://example.com/sum"],
    },
  });
  await env.start();
  const added = env.service.advisorQueue({
    run: "js-1",
    role: "teacher",
    add: [
      {
        title: "Unroll the inner loop by 4",
        details: "Keep the remainder loop for lengths that are not a multiple of 4.",
        why: "The loop's overhead is a large share of each step.",
      },
    ],
    move: [],
  });
  const experiment = added.added[0];
  assert.ok(experiment, JSON.stringify(added));
  await command(env, "message_agent", {
    run: "js-1",
    to: "lane-1",
    text: "Keep each change small.",
    keep: true,
  });
  await command(env, "message_agent", { run: "js-1", to: "all", text: "Measure twice." });
  const fake = await startFakeModel(({ tools }) => {
    if (!tools.some((x) => x.function.name === "submit_plan")) return { text: "done" };
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_families: [{ id: "speed", description: "make the sum faster" }],
            assignments: [
              {
                lane: "lane-1",
                experiment,
                family: "speed",
                parent: "champion",
                why: "the teacher's idea fits the loop's cost",
              },
            ],
            journal: [{ kind: "decision", text: "Start with the teacher's idea." }],
          },
        },
      ],
    };
  });
  t.after(() => fake.close());
  const briefs: string[] = [];
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
    owner: "scheduler-test",
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial: async (spec) => {
      briefs.push(briefText(spec.brief));
      return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    },
  });
  assert.ok(await scheduler.tick(), "a trial started");
  await scheduler.idle();
  const brief = briefs[0];
  assert.ok(brief, "the trial got a brief");
  return steady(brief, env.root);
}

describe("the worker's brief (goal 166)", () => {
  test("a hill-climb trial's whole brief is unchanged", async (t) => {
    const brief = await briefOfOneTrial(t);
    const golden = new URL("../golden/worker.brief.txt", import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, brief);
    assert.equal(brief, readFileSync(golden, "utf8"));
  });
});

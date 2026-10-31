/** Goal runs and research runs use the queue too. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../../../../src/core/contract.ts";
import { Scheduler } from "../../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../../src/harness/broker/runner.ts";
import { Research } from "../../../../../src/harness/research/research/index.ts";
import { briefText } from "../../../../helpers/brief-text.ts";
import { startFakeModel } from "../../../../helpers/fake-model.ts";
import { researchFixture } from "../../../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../../../helpers/harness-env.ts";
import { makeJudgeEnv } from "../../../../helpers/judge-env.ts";
import { body, command, events, RUN } from "./setup.ts";

describe("goal runs use the queue", () => {
  test("a goal run's planner reads the queue and gives out its experiments; without the planner, lanes take them in order", async (t) => {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 90e6 },
      contract: { lanes: { count: 1, trials_per_epoch: 1 } },
    });
    await env.start();
    let planner = true;
    const ids: string[] = [];
    const prompts: string[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      if (!tools.some((x) => x.function.name === "submit_plan")) return { text: "done" };
      prompts.push(JSON.stringify(messages));
      return {
        toolCalls: [
          {
            name: "submit_plan",
            args: { assignments: [{ lane: "lane-1", experiment: ids[1], why: "the fast goal" }] },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "scheduler-test",
      plannerOn: () => planner,
      goalReportWaitMs: 0,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      runTrial: async () => ({
        stopped: "no_submission",
        turns: 1,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    for (const title of ["keep it correct", "unroll for the fast goal"])
      ids.push(String((await command(env, "queue_add", { run: RUN, title })).experiment));
    const round = async () => {
      assert.ok(await scheduler.tick());
      await scheduler.idle();
      await scheduler.tick();
    };
    await round();
    // The planner was given the queue, and its pick is what lane-1 worked on.
    assert.match(String(prompts[0]), /\\"up_next\\":\[\{\\"by\\":\\"owner\\",\\"id\\":\\"x-/);
    planner = false;
    await round();
    const given = events(env, "experiment_assigned").map((e) => [body(e).lane, body(e).id]);
    assert.deepEqual(given, [
      ["lane-1", ids[1]],
      ["lane-1", ids[0]],
    ]);
    assert.deepEqual(
      events(env, "experiment_finished").map((e) => body(e).id),
      [ids[1], ids[0]],
    );
    assert.equal(events(env, "planner_handout").length, 2);
  });
});

describe("research runs use the queue", () => {
  test("the research plan's task goes to the question its gaps weigh for (with no cards, the first), whatever else waits in the queue", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({
      ...researchFixture,
      questions: ["First?", "Second?", "Third?"],
      lanes: { count: 2, trials_per_epoch: 1 },
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    // A task of the owner's waits: before, it shifted the plan one question on, past question 0.
    await env.service.applyCommand(
      env.sign("queue_add", { run: "r-1", title: "Read the vendor's notes", family: "primary" }),
    );
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "research-test",
      research: new Research(env.service.ledger, env.service.paths.stateDir, {
        allowPrivate: true,
      }),
      maxConcurrent: 2,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async () => ({
        stopped: "finished",
        turns: 1,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    const planned = env.service.queue.all("r-1").filter((x) => x.added_by === "planner");
    assert.deepEqual(
      planned.map((x) => x.title.split(":")[0]),
      ["Question 1 (index 0)"],
    );
  });

  test("the research plan fills the queue with tasks; rounds take them in order", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({ ...researchFixture, lanes: { count: 2, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    // The owner's own task goes first.
    await env.service.applyCommand(
      env.sign("queue_add", {
        run: "r-1",
        title: "Check the vendor's own benchmark",
        family: "primary",
        details: "Question 0",
      }),
    );
    // An old rule in words, as a harness from before rules named directions could take it for a
    // research run too: the research plan has no planner's model to convert it, and code can't
    // keep it, so it stays in force as it is, for the owner to remove.
    const [words] = env.service.ledger.directives.addSet(
      "r-1",
      "control:owner:ui",
      [{ kind: "avoid", match: "anything from blogs", rationale: "old", citations: [] }],
      false,
    );
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "research-test",
      research,
      maxConcurrent: 2,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async (spec) => {
        briefs.push(briefText(spec.brief));
        return { stopped: "finished", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    const q = env.service.queue;
    const tasks = q.all("r-1");
    assert.equal(tasks.length, 2, "the plan added one task: the owner's was there");
    const planned = tasks.find((x) => x.added_by === "planner");
    assert.ok(planned);
    assert.ok(["explore", "primary", "contradict", "consolidate"].includes(planned.family));
    // Its details name the gap it closes (goal 117), then its question.
    assert.match(
      planned.details,
      /^Evidence gap to close: No answer card yet: [^\n]+\nQuestion 1 \(index 0\): /,
    );
    // The plan's task keeps its question (goal 117), in its row and its event.
    assert.equal(planned.question, 0);
    assert.equal(
      events(env, "experiment_added")
        .map(body)
        .find((b) => b.id === planned.id)?.question,
      0,
    );
    assert.deepEqual(
      events(env, "experiment_assigned").map((e) => body(e).lane),
      ["lane-1", "lane-2"],
    );
    assert.equal(body(events(env, "experiment_assigned")[0]).id, tasks[0]?.id, "the owner's first");
    assert.match(String(briefs[0]), /Your focus: Check the vendor's own benchmark\nQuestion 0/);
    assert.deepEqual(
      events(env, "experiment_finished").map((e) => body(e).result),
      ["finished", "finished"],
    );
    // Each research trial's yield is kept with its task (goal 117): these added nothing.
    const none = {
      verified_claims: 0,
      by_question: [],
      new_domains: 0,
      domains: [],
      findings: 0,
      card_changes: 0,
    };
    assert.deepEqual(
      events(env, "experiment_finished").map((e) => body(e).yield),
      [none, none],
    );
    assert.deepEqual(JSON.parse(String(q.get(planned.id)?.yield)), none);
    assert.deepEqual(
      q.brief("r-1").tried.map((x) => x.yield),
      [none, none],
    );
    const h = body(events(env, "planner_handout")[0]);
    assert.equal((h.assignments as unknown[]).length, 2);
    assert.deepEqual(
      env.service.ledger.directives.active("r-1").map((d) => d.id),
      [words],
    );
    assert.equal(events(env, "directive_converted").length, 0);
  });
});

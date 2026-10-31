import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, type TestContext, test } from "node:test";
import { type CommandKind, signEnvelope } from "../../../../src/core/commands.ts";
import { parseContract } from "../../../../src/core/contract.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { Research } from "../../../../src/harness/research/research/index.ts";
import { briefText } from "../../../helpers/brief-text.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { researchFixture } from "../../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../../helpers/harness-env.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

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

const reads = (env: { service: { ledger: Env["ledger"] } }) =>
  env.service.ledger
    .eventsAfter(0, 5000)
    .events.filter((e) => e.kind === "agent_message_read")
    .map((e) => {
      const b = e.body as { message: number; by: string };
      return `${b.message}:${b.by}`;
    });

/** A hill climb with one lane, a planner that records its prompt and trials that record their brief. */
async function setup(
  t: TestContext,
  o: {
    plannerOn?: () => boolean;
    turns?: (trial: number) => number;
    /** True: the planner's answer gives no lane an experiment, so the plan is refused. */
    refuse?: () => boolean;
  } = {},
) {
  const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
  await env.start();
  const planned: string[] = [];
  const fake = await startFakeModel(({ messages, tools }) => {
    if (!tools.some((t) => t.function.name === "submit_plan")) return { text: "done" };
    planned.push(JSON.stringify(messages));
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_families: [{ id: "speed", description: "make the sum faster" }],
            assignments: o.refuse?.()
              ? []
              : [{ lane: "lane-1", family: "speed", focus: "go faster", parent: "champion" }],
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
    plannerOn: o.plannerOn,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial: async (spec) => {
      briefs.push(briefText(spec.brief));
      const turns = o.turns?.(briefs.length) ?? 1;
      return {
        stopped: turns ? "no_submission" : "error",
        turns,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      };
    },
  });
  /** One epoch: planned, its one trial run to the end. */
  const epoch = async () => {
    assert.ok(await scheduler.tick(), "a trial started");
    await scheduler.idle();
    await scheduler.tick(); // the epoch ends
  };
  return { env, planned, briefs, epoch };
}

describe("the owner's messages in plans and briefs", () => {
  test("the planner reads everyone-working and planner messages once; a brief carries messages in force every time and the rest once", async (t) => {
    const { env, planned, briefs, epoch } = await setup(t);
    await command(env, "message_agent", {
      run: "js-1",
      to: "all",
      text: "keep every change small",
      keep: true,
    });
    await command(env, "message_agent", { run: "js-1", to: "lane-1", text: "try unrolling" });
    await command(env, "message_agent", { run: "js-1", to: "planner", text: "spread wider" });
    await epoch();
    assert.match(
      String(planned[0]),
      /\\"owner_messages\\":\[\{\\"directions\\":\[\],\\"id\\":1,\\"text\\":\\"keep every change small\\"\},\{\\"directions\\":\[\],\\"id\\":3,\\"text\\":\\"spread wider\\"\}\]/,
    );
    assert.doesNotMatch(
      String(planned[0]),
      /try unrolling/,
      "a lane's message is not the planner's",
    );
    assert.match(
      String(briefs[0]),
      /# Messages from the campaign's owner, in force\n- keep every change small\n\n# Messages from the campaign's owner\n- try unrolling$/,
    );
    await epoch();
    assert.doesNotMatch(String(planned[1]), /\\"owner_messages\\":/, "each read once");
    assert.match(
      String(briefs[1]),
      /# Messages from the campaign's owner, in force\n- keep every change small$/,
    );
    await command(env, "unkeep_message", { run: "js-1", message: 1 });
    await epoch();
    assert.doesNotMatch(String(briefs[2]), /Messages from the campaign's owner/);
    // The first read by each reader is an event; later in-force briefs are not.
    assert.deepEqual(reads(env), ["1:planner", "3:planner", "1:lane-1", "2:lane-1"]);
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from agent_message_read where message = 1").get()
        ?.n,
      3,
      "the planner, then lane-1's first and second trials",
    );
  });

  test("a trial that fails before its agent works leaves its brief's messages for the next one", async (t) => {
    const { env, briefs, epoch } = await setup(t, { turns: (n) => (n === 1 ? 0 : 1) });
    await command(env, "message_agent", { run: "js-1", to: "lane-1", text: "try unrolling" });
    await epoch();
    assert.match(String(briefs[0]), /- try unrolling$/);
    assert.deepEqual(reads(env), [], "not read: the first trial's agent never worked");
    await epoch();
    assert.match(String(briefs[1]), /- try unrolling$/, "the next trial gets it");
    assert.deepEqual(reads(env), ["1:lane-1"]);
  });

  test("with the planner off, everyone-working messages wait for it", async (t) => {
    let on = true;
    const { env, planned, epoch } = await setup(t, { plannerOn: () => on });
    await command(env, "message_agent", { run: "js-1", to: "all", text: "careful now" });
    on = false;
    await epoch();
    assert.equal(planned.length, 0, "the fixed plan");
    assert.deepEqual(reads(env), ["1:lane-1"]);
    assert.deepEqual(
      env.service.messages.waitingForPlanner("js-1").map((m) => m.id),
      [1],
    );
  });

  test("a plan refused on both tries leaves the planner's messages for the next plan", async (t) => {
    let refuse = true;
    const { env, planned, epoch } = await setup(t, { refuse: () => refuse });
    await command(env, "message_agent", { run: "js-1", to: "planner", text: "spread wider" });
    await epoch();
    assert.equal(planned.length, 2, "two tries, both refused: the fixed rules planned the round");
    assert.deepEqual(reads(env), [], "not read: the model's plan was not used");
    assert.deepEqual(
      env.service.messages.waitingForPlanner("js-1").map((m) => m.id),
      [1],
    );
    refuse = false;
    await epoch();
    assert.match(String(planned[2]), /spread wider/, "the next plan gets it");
    assert.deepEqual(reads(env), ["1:planner"]);
    assert.deepEqual(env.service.messages.waitingForPlanner("js-1"), []);
  });
});

describe("a research run's rounds", () => {
  test("with no model to reach, its round is the gap-driven plan's and the planner reads nothing; its trials read everyone-working messages", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({
      ...researchFixture,
      lanes: { count: 1, trials_per_epoch: 1 },
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
    await env.service.applyCommand(
      env.sign("message_agent", { run: "r-1", to: "all", text: "prefer primary sources" }),
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
    const started = env.service.ledger
      .eventsAfter(0, 5000)
      .events.find((e) => e.kind === "epoch_started")?.body as Record<string, unknown>;
    // The planner is on: its model could not be reached, so the round fell back, and says why.
    assert.equal(started.plan, undefined);
    assert.equal(started.notes, "the gap-driven plan: Question 1 (index 0): no card");
    assert.equal(started.source, "fallback");
    assert.equal(started.planner_tries, 2);
    assert.deepEqual(
      (started.causes as { cause: string }[]).map((c) => c.cause),
      ["provider_error", "provider_error"],
    );
    assert.match(
      String(briefs[0]),
      /# Messages from the campaign's owner\n- prefer primary sources$/,
    );
    assert.deepEqual(reads(env), ["1:lane-1"]);
  });
});

/**
 * The planner's call to its model: a refused plan tried again, then the fallback; each try's cause;
 * the limits in the tool's schema and the prompt; the plan as JSON through another harness; and
 * reasoning effort.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildModel,
  type ModelConfig,
  modelConfigFromEnv,
} from "../../../../src/agents/model/index.ts";
import { plan, validatePlan } from "../../../../src/harness/agents/planner/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { base, model } from "./setup.ts";

describe("planner", () => {
  test("a valid model plan is used; an invalid one is retried, then the fallback takes over", async () => {
    let call = 0;
    const good = {
      assignments: [
        { lane: "lane-1", family: "unroll", focus: "unroll by 4", parent: "champion" },
        { lane: "lane-2", family: "simd", focus: "use vectors", parent: "champion" },
      ],
      new_families: [{ id: "simd", description: "vector instructions" }],
    };
    const wrong = {
      // Within the tool's schema (goal 079), refused by the checks.
      assignments: [{ lane: "lane-1", family: "nonexistent", focus: "guess", parent: "lane_best" }],
    };
    const fake = await startFakeModel(() => {
      call++;
      return { toolCalls: [{ name: "submit_plan", args: call === 1 ? wrong : good }] };
    });
    const p = await plan(base, model(fake.url));
    assert.equal(p.source, "planner");
    assert.equal(p.tries, 2);
    assert.ok(p.rawViolations.length > 0);
    assert.deepEqual(
      p.newFamilies.map((f) => f.id),
      ["simd"],
    );
    await fake.close();

    const never = await startFakeModel(() => ({ text: "I would rather not plan." }));
    const q = await plan(base, model(never.url));
    assert.equal(q.source, "fallback");
    assert.equal(q.valid, false);
    assert.equal(q.assignments.length, 2);
    await never.close();
  });

  test("each try that gives no plan is recorded with its real cause (goal 079)", async () => {
    // Text only: it answered without calling submit_plan.
    const talk = await startFakeModel(() => ({ text: "I would rather not plan." }));
    const t = await plan(base, model(talk.url));
    await talk.close();
    assert.deepEqual(
      t.causes?.map((c) => c.cause),
      ["text_only", "text_only"],
    );
    assert.match(String(t.rawViolations[0]), /answered in text without a plan/);
    // Refused by a rule: invalid, with which rule.
    const wrong = await startFakeModel(() => ({
      toolCalls: [
        {
          name: "submit_plan",
          args: { assignments: [{ lane: "lane-1", experiment: "x-none", parent: "champion" }] },
        },
      ],
    }));
    const w = await plan(base, model(wrong.url));
    await wrong.close();
    assert.equal(w.causes?.[0]?.cause, "invalid");
    assert.match(String(w.causes?.[0]?.detail), /assign each of lane-1, lane-2 exactly once/);
    // Refused by the tool's schema, and sent again unchanged: the call ends, invalid, and does
    // not go on asking (with no time limit, it would never stop).
    let asks = 0;
    const same = await startFakeModel(() => {
      asks++;
      return {
        toolCalls: [
          {
            name: "submit_plan",
            args: {
              assignments: [{ lane: "lane-1", family: "f", focus: "y".repeat(5000) }],
            },
          },
        ],
      };
    });
    const r = await plan(base, model(same.url));
    await same.close();
    assert.deepEqual(
      r.causes?.map((c) => c.cause),
      ["invalid", "invalid"],
    );
    assert.match(String(r.causes?.[0]?.detail), /same refused plan again/);
    assert.equal(asks, 4, "two model calls for each of the two tries");
    // The provider's error: provider_error, with the provider's kind and words.
    const down = await startFakeModel(() => ({ fail: 402, failMessage: "insufficient credits" }));
    const d = await plan(base, model(down.url));
    await down.close();
    assert.equal(d.causes?.[0]?.cause, "provider_error");
    assert.match(String(d.causes?.[0]?.detail), /no credits left at the provider/);
    // Through another harness: an answer that is not a JSON plan is text only; a harness that
    // gave no answer in its time is a timeout; any other failure is the provider's.
    const asked = async (o: { answer?: string; fail?: string }) =>
      plan(base, model("http://unused"), undefined, async () => {
        if (o.fail) throw new Error(o.fail);
        return o.answer ?? "";
      });
    assert.equal((await asked({ answer: "no plan today" })).causes?.[0]?.cause, "text_only");
    assert.equal((await asked({ fail: "no answer in 300 s" })).causes?.[0]?.cause, "timeout");
    assert.equal(
      (await asked({ fail: "OpenCode: 503 upstream" })).causes?.[0]?.cause,
      "provider_error",
    );
  });

  test("every limit the plan is held to is in the tool's schema and in the prompt (goal 079)", async () => {
    const { PLAN_LIMITS, PLAN_LIMITS_TEXT } = await import(
      "../../../../src/agents/roles/planner.ts"
    );
    let tool: Record<string, unknown> | undefined;
    let system = "";
    const fake = await startFakeModel(({ messages, tools }) => {
      system = JSON.stringify(messages[0]);
      tool = (
        tools.find((x) => x.function.name === "submit_plan")?.function as
          | { parameters?: Record<string, unknown> }
          | undefined
      )?.parameters;
      return { text: "no" };
    });
    await plan(base, model(fake.url));
    await fake.close();
    const props = (tool?.properties ?? {}) as Record<string, { items?: { properties?: unknown } }>;
    const a = (props.assignments?.items?.properties ?? {}) as Record<
      string,
      { maxLength?: number }
    >;
    assert.equal(a.focus?.maxLength, PLAN_LIMITS.focus);
    assert.equal(a.title?.maxLength, PLAN_LIMITS.title);
    // No count on added experiments (goal 081): the queue's target drives them.
    assert.equal((props.add as { maxItems?: number }).maxItems, undefined);
    assert.equal((props.move as { maxItems?: number }).maxItems, PLAN_LIMITS.changes);
    assert.ok(system.includes(PLAN_LIMITS_TEXT.slice(0, 60)), "the prompt states the limits");
    // A focus of 3,000 characters is a plan now: past its title, it goes in details.
    const long = "x".repeat(3000);
    const ok = validatePlan(
      {
        assignments: [
          { lane: "lane-1", focus: long, family: "unroll" },
          { lane: "lane-2", focus: "tile by 32", family: "tiling" },
        ],
      },
      base,
    );
    assert.deepEqual(ok.errors, []);
  });

  test("through OpenCode, the planner is asked for the plan as JSON, never for its Pi tool", async () => {
    const prompts: string[] = [];
    const good = {
      assignments: [
        { lane: "lane-1", family: "unroll", focus: "unroll by 4", parent: "champion" },
        { lane: "lane-2", family: "tiling", focus: "tile by 32", parent: "champion" },
      ],
      new_families: [],
    };
    const p = await plan(base, model("http://unused"), undefined, async (prompt) => {
      prompts.push(prompt);
      return `Here is the plan:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    });
    assert.equal(p.source, "planner");
    assert.equal(p.tries, 1);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Answer with only the plan, as one JSON object/);
    assert.doesNotMatch(prompts[0] ?? "", /submit_plan/);
    assert.match(prompts[0] ?? "", /The campaign, as JSON:\n\{/);
  });

  test("reasoning effort is sent only when configured; off sends none", async () => {
    const seen: (string | undefined)[] = [];
    const fake = await startFakeModel(({ reasoning_effort }) => {
      seen.push(reasoning_effort);
      return { text: "no plan" };
    });
    const env = {
      THERMITE_MODEL_BASE_URL: fake.url,
      THERMITE_MODEL: "m",
      THERMITE_MODEL_API_KEY: "k",
    };
    for (const effort of [undefined, "none", "high"]) {
      const cfg = modelConfigFromEnv({ ...env, THERMITE_MODEL_REASONING_EFFORT: effort });
      assert.ok(cfg);
      seen.length = 0;
      await plan(base, cfg);
      assert.ok(seen.length > 0);
      assert.deepEqual(new Set(seen), new Set([effort]));
    }
    assert.throws(
      () => modelConfigFromEnv({ ...env, THERMITE_MODEL_REASONING_EFFORT: "max" }),
      /must be/,
    );
    // Only the THERMITE_ names make a route: the names of Thermite's first deployment are gone.
    const old = { QWEN_BASE_URL: fake.url, QWEN_MODEL: "old", QWEN_API_KEY: "k" };
    assert.equal(modelConfigFromEnv(old), undefined);
    const both = modelConfigFromEnv({ ...old, ...env, QWEN_CONTEXT_WINDOW: "262144" });
    assert.equal(both?.model, "m");
    assert.equal(both?.contextWindow, 0);
    // An OpenAI-compatible route registers under a provider id named for what it is.
    assert.equal(buildModel(both as ModelConfig).model.provider, "thermite-openai");
    await fake.close();
  });
});

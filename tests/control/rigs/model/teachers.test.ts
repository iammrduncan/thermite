import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentModelsOf } from "../../../../src/control/rigs/model.ts";
import { stack } from "./stack.ts";

/** The teachers over REST: one or two models and a merged by model, all checked before any is set. */

describe("each agent's model over REST and MCP", () => {
  test("REST: the teachers take one or two models and a merged by model, all checked first", async () => {
    const s = await stack();
    const teachers = () =>
      agentModelsOf(s.store, "rig-a").teachers as {
        models: { provider: string; model: string; harness: string; context_cap: number | null }[];
        merged_by: { model: string; compact_at: number | null } | null;
      };
    // Two teachers on two providers, merged by a third model, in one call: each model with its
    // own harness, cap and point.
    const both = await s.give({
      agent: "teachers",
      provider: "claude-sub",
      model: "opus-5.5",
      second_model: { provider: "sub", model: "gpt-sol", harness: "codex", context_window: 65_536 },
      merged_by: { provider: "lab", model: "strong-model", compact_at: 70 },
    });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.model, "opus-5.5");
    assert.equal(both.body.context_window, 200_000, "the first teacher's window");
    assert.equal(
      both.body.said,
      "Control sent a model for the teachers, a model for a second teacher and a merged by model for the teachers to rig-a. The rig takes the change in less than one minute. The second teacher's context window: 65,536 tokens (capped; the provider allows 272,000). The merged by model's conversations are compacted at 70% of the window.",
    );
    assert.deepEqual(
      teachers().models.map((m) => [m.provider, m.model, m.harness, m.context_cap]),
      [
        ["claude-sub", "opus-5.5", "claude-code", null],
        ["sub", "gpt-sol", "codex", 65_536],
      ],
    );
    assert.equal(teachers().merged_by?.compact_at, 70);
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    assert.deepEqual(
      (adv.teacher_models as { type: string; harness: string }[]).map((t) => [t.type, t.harness]),
      [
        ["claude", "claude-code"],
        ["chatgpt", "codex"],
      ],
    );
    assert.equal((adv.merged_by as { model: string } | null)?.model, "strong-model");

    // A refusal of any model in the call changes nothing, the others included.
    const refused = await s.give({
      agent: "teachers",
      provider: "lab",
      model: "wide-model",
      merged_by: { provider: "zen", model: "big-pickle", harness: "pi" },
    });
    assert.equal(refused.status, 400);
    assert.equal(
      refused.body.error,
      "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the teachers' merged by model, or another model.",
    );
    assert.equal(teachers().models[0]?.model, "opus-5.5", "the first teacher kept");
    const badSecond = await s.give({
      agent: "teachers",
      second_model: { provider: "lab", model: "no-such" },
    });
    assert.equal(badSecond.body.error, "That provider does not list that model (second teacher).");

    // One teacher only: the second model goes, the merged by model stays (for the advisors file's
    // two teachers, or the next second one).
    const one = await s.give({ agent: "teachers", second_model: null });
    assert.equal(one.status, 200);
    assert.match(
      String(one.body.said),
      /^Control sent the teachers back to one teacher to rig-a\./,
    );
    assert.deepEqual(
      teachers().models.map((m) => m.model),
      ["opus-5.5"],
    );
    assert.equal(teachers().merged_by?.model, "strong-model");
    const oneRoute = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    assert.equal((oneRoute.teacher_models as unknown[]).length, 1);

    // Clearing the teachers clears all three; a second teacher then needs a first.
    const cleared = await s.give({ agent: "teachers", clear: true });
    assert.equal(
      cleared.body.said,
      "Control sent the teachers back to the rig's advisors file to rig-a. The rig takes the change in less than one minute.",
    );
    assert.deepEqual(teachers(), { models: [], merged_by: null });
    const noFirst = await s.give({
      agent: "teachers",
      second_model: { provider: "lab", model: "wide-model" },
    });
    assert.equal(noFirst.status, 400);
    assert.equal(
      noFirst.body.error,
      "The teachers have no model of their own yet: give a provider and a model for the first teacher too.",
    );
    const empty = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    assert.deepEqual([empty.teacher_models, empty.merged_by, empty.review_panel], [[], null, null]);

    // The shape: second_model and merged_by only for the teachers, and never with clear.
    for (const [body, error] of [
      [
        { agent: "auditor", provider: "lab", model: "wide-model", merged_by: null },
        "second_model and merged_by are for the teachers only: give agent teachers.",
      ],
      [
        { agent: "teachers", clear: true, merged_by: null },
        "Give clear alone, or a provider and a model.",
      ],
      [
        { agent: "teachers" },
        "Give a provider and a model, second_model or merged_by, or clear: true.",
      ],
      [
        {
          agent: "teachers",
          effort: "high",
          second_model: { provider: "lab", model: "wide-model" },
        },
        "Give a provider and a model, second_model or merged_by, or clear: true.",
      ],
      [
        { agent: "teachers", merged_by: { provider: "lab", model: "wide-model", compact_at: 99 } },
        "The compaction point is a whole percent of the context window, from 50 to 95.",
      ],
    ] as const) {
      const r = await s.give(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    const unknownField = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "wide-model", role: "x" },
    });
    assert.equal(unknownField.status, 400);
    assert.match(String(unknownField.body.error), /^bad request: merged_by/);
  });
});

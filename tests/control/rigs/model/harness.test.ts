import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentModelsOf } from "../../../../src/control/rigs/model.ts";
import { stack } from "./stack.ts";

/** Each agent runs in the harness it is given, and is refused in words where its model can't run. */

describe("each agent's model over REST and MCP", () => {
  test("each agent runs in the harness it is given, refused in words where its model can't run", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model" });
    const given = [
      // [agent, provider, model, harness asked, harness kept]
      ["planner", "lab", "strong-model", "opencode", "opencode"],
      ["teachers", "sub", "gpt-sol", "codex", "codex"],
      ["auditor", "zen", "big-pickle", undefined, "opencode"],
      ["review_panel", "claude-sub", "opus-5.5", undefined, "claude-code"],
    ] as const;
    for (const [agent, provider, model, harness, kept] of given) {
      const r = await s.give({ agent, provider, model, ...(harness ? { harness } : {}) });
      assert.equal(r.status, 200, `${agent}: ${JSON.stringify(r.body)}`);
      const agents = r.body.agents as Record<string, { harness: string } | null> & {
        teachers: { models: { harness: string }[] };
      };
      assert.equal(
        agent === "teachers" ? agents.teachers.models[0]?.harness : agents[agent]?.harness,
        kept,
        agent,
      );
    }
    // The teachers' merged by model in its own harness.
    const merged = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "strong-model", harness: "codex" },
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const audit = s.store.auditLog.list(10, { action: "agent_model_given" });
    assert.deepEqual(
      audit.slice(0, 2).map((e) => {
        const b = e.body as { role?: string; harness?: string };
        return [b.role, b.harness];
      }),
      [
        ["merged_by", "codex"],
        ["review_panel", "claude-code"],
      ],
    );
    // The rig's routes carry each agent's harness: the planner's in its model route, the
    // advisors' in their advisor routes. OpenCode's own models go with no key.
    const mr = await s.asRig("/v1/rigs/rig-a/model-route");
    assert.equal(mr.planner?.harness, "opencode");
    assert.equal(mr.planner?.type, "openai");
    const adv = await s.asRig("/v1/rigs/rig-a/advisor-routes");
    const [first] = adv.teacher_models as unknown as Record<string, unknown>[];
    assert.deepEqual(
      [first?.harness, first?.type],
      ["codex", "chatgpt"],
      "a ChatGPT sign-in in Codex",
    );
    assert.deepEqual([adv.merged_by?.harness, adv.merged_by?.type], ["codex", "openai"]);
    assert.deepEqual(
      [adv.auditor?.harness, adv.auditor?.type, adv.auditor?.api_key],
      ["opencode", "opencode", ""],
    );
    assert.deepEqual(
      [adv.review_panel?.harness, adv.review_panel?.type],
      ["claude-code", "claude"],
    );

    // Refused in words, for every kind of agent, and nothing changes.
    const refusals = [
      [
        { agent: "auditor", provider: "claude-sub", model: "opus-5.5", harness: "pi" },
        "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model.",
      ],
      [
        { agent: "planner", provider: "zen", model: "big-pickle", harness: "codex" },
        "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.",
      ],
      [
        { agent: "teachers", provider: "zen", model: "big-pickle", harness: "pi" },
        "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the teachers, or another model.",
      ],
      [
        {
          agent: "teachers",
          merged_by: { provider: "sub", model: "gpt-sol", harness: "claude-code" },
        },
        "Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider.",
      ],
      [
        {
          agent: "teachers",
          second_model: { provider: "claude-sub", model: "opus-5.5", harness: "opencode" },
        },
        "A Claude subscription runs only in Claude Code: choose Claude Code for the second teacher, or another model.",
      ],
      [
        { provider: "claude-sub", model: "opus-5.5", harness: "codex" },
        "A Claude subscription runs only in Claude Code: choose Claude Code for the workers, or another model.",
      ],
      [
        { provider: "zen", model: "big-pickle", harness: "pi" },
        "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the workers, or another model.",
      ],
    ] as const;
    for (const [body, error] of refusals) {
      const r = await s.give(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    const after = agentModelsOf(s.store, "rig-a");
    assert.deepEqual(
      [
        after.workers?.harness,
        after.planner?.harness,
        after.teachers.models[0]?.harness,
        after.teachers.merged_by?.harness,
        after.auditor?.harness,
      ],
      ["pi", "opencode", "codex", "codex", "opencode"],
    );
    // Without a harness, the same model again goes back to what it needs: MCP and REST set what
    // they are asked.
    const back = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "strong-model" },
    });
    assert.equal(
      (back.body.agents as { teachers: { merged_by: { harness: string } } }).teachers.merged_by
        .harness,
      "pi",
    );
    // A Claude subscription named with claude-code for the workers runs there.
    const w = await s.give({ provider: "claude-sub", model: "opus-5.5", harness: "claude-code" });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "claude-code");
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advisorRoutesOf } from "../../../../src/control/rigs/model-routes.ts";
import { AdvisorRoutesValue, CONFIG_VALUES } from "../../../../src/core/link/config.ts";
import { mcpClient } from "../../../helpers/control-stack.ts";
import { stack, TOKENS, text } from "./stack.ts";

/**
 * The synthesizer's and the final writer's own models (goal 166): set and cleared over REST and
 * MCP as any agent's, read with the others, and carried to the rig in its advisor routes, over
 * HTTP and in its config on the message bus. With none, each uses the first teacher's model.
 */

describe("the synthesizer's and the final writer's models", () => {
  test("REST: each is set with its harness, effort and context, and cleared to the first teacher's", async () => {
    const s = await stack();
    const synth = await s.give({
      agent: "synthesizer",
      provider: "lab",
      model: "strong-model",
      effort: "high",
      context_window: 131_072,
      compact_at: 70,
    });
    assert.equal(synth.status, 200, JSON.stringify(synth.body));
    assert.equal(synth.body.agent, "synthesizer");
    assert.equal(synth.body.context_window, 131_072);
    assert.equal(synth.body.compact_at, 70);
    assert.match(
      String(synth.body.said),
      /^Control sent a model for the synthesizer to rig-a\. The rig takes the change in less than one minute\./,
    );
    const writer = await s.give({
      agent: "final_writer",
      provider: "claude-sub",
      model: "opus-5.5",
      effort: "max",
    });
    assert.equal(writer.status, 200, JSON.stringify(writer.body));
    assert.match(String(writer.body.said), /^Control sent a model for the final writer to rig-a\./);
    const agents = writer.body.agents as Record<string, Record<string, unknown> | null>;
    assert.deepEqual(agents.synthesizer, {
      provider: "lab",
      model: "strong-model",
      effort: "high",
      harness: "pi",
      context_cap: 131_072,
      compact_at: 70,
    });
    // A Claude subscription runs in Claude Code, as for any agent.
    assert.equal(agents.final_writer?.harness, "claude-code");
    assert.equal(agents.teachers && (agents.teachers as { models: unknown[] }).models.length, 0);
    // The audit log names the role.
    const audit = s.store.auditLog.list(5, { action: "agent_model_given" });
    assert.deepEqual(
      audit.slice(0, 2).map((a) => (a.body as { role?: string }).role),
      ["final_writer", "synthesizer"],
    );

    // A harness that can't run the model is refused in the same words as for any agent.
    const refused = await s.give({
      agent: "final_writer",
      provider: "lab",
      model: "wide-model",
      harness: "claude-code",
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /Claude Code runs only with a Claude subscription/);

    // Cleared: back to the first teacher's model, in Edit rig's words.
    const cleared = await s.give({ agent: "synthesizer", clear: true });
    assert.equal(cleared.status, 200);
    assert.match(
      String(cleared.body.said),
      /^Control sent the synthesizer back to the first teacher's model to rig-a\./,
    );
    assert.equal((cleared.body.agents as Record<string, unknown>).synthesizer, null);
    assert.equal(s.store.agentModels.byRole("rig-a").synthesizer, undefined);
    // The other agents keep theirs.
    assert.equal(s.store.agentModels.byRole("rig-a").final_writer?.model, "opus-5.5");
  });

  test("the advisor routes carry each under its own key, over HTTP and on the bus; none is null", async () => {
    const s = await stack();
    let adv = await s.asRig("/v1/rigs/rig-a/advisor-routes");
    assert.equal(adv.synthesizer, null);
    assert.equal(adv.final_writer, null);
    await s.give({ agent: "teachers", provider: "sub", model: "gpt-sol" });
    await s.give({
      agent: "final_writer",
      provider: "lab",
      model: "wide-model",
      harness: "opencode",
      context_window: 65_536,
    });
    adv = await s.asRig("/v1/rigs/rig-a/advisor-routes");
    assert.equal(adv.synthesizer, null, "with none, the supervisor uses the first teacher's");
    assert.deepEqual(
      [
        adv.final_writer?.model,
        adv.final_writer?.harness,
        adv.final_writer?.context_window,
        adv.final_writer?.api_key,
      ],
      ["wide-model", "opencode", 65_536, "lab-key-for-tests"],
    );
    // The answer and the bus's value read alike: one schema, with the two keys.
    const parsed = AdvisorRoutesValue.parse(adv);
    assert.equal(parsed.final_writer?.model, "wide-model");
    assert.equal(CONFIG_VALUES["advisor-routes"].parse(adv).final_writer?.harness, "opencode");
    // What control writes to the rig's config on the bus is the same value.
    const parts = { store: s.store } as Parameters<typeof advisorRoutesOf>[0];
    const onBus = await advisorRoutesOf(
      {
        ...parts,
        secrets: { open: () => "lab-key-for-tests" } as never,
        chatgpt: { access: async () => "chatgpt-access-for-tests" } as never,
      },
      "rig-a",
    );
    assert.deepEqual([onBus.synthesizer, onBus.final_writer?.model], [null, "wide-model"]);
  });

  test("MCP: an operator sets them; rig_models reads them", async () => {
    const s = await stack();
    const operator = await mcpClient(s.api, TOKENS.operator);
    const set = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", agent: "synthesizer", provider: "sub", model: "gpt-sol" },
      }),
    );
    assert.equal(set.agent, "synthesizer");
    assert.equal(set.context_window, 272_000);
    const read = text(await operator.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    const agents = read.agents as Record<string, { model: string } | null>;
    assert.equal(agents.synthesizer?.model, "gpt-sol");
    assert.equal(agents.final_writer, null);
    // A name that is no agent is refused by the tool's schema.
    const bad = await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", agent: "writer", provider: "sub", model: "gpt-sol" },
    });
    assert.equal((bad as { isError?: boolean }).isError, true);
  });
});

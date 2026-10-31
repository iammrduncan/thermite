import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpClient } from "../../../helpers/control-stack.ts";
import { stack, TOKENS, text } from "./stack.ts";

/** Each agent's model over MCP: an operator sets and clears an advisor's; a reader only reads them. */

describe("each agent's model over REST and MCP", () => {
  test("MCP: an operator sets and clears an advisor's model; a reader reads them only", async () => {
    const s = await stack();
    const operator = await mcpClient(s.api, TOKENS.operator);
    await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", provider: "lab", model: "wide-model" },
    });
    const teachers = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", agent: "teachers", provider: "sub", model: "gpt-sol" },
      }),
    );
    assert.equal(teachers.agent, "teachers");
    assert.equal(teachers.context_window, 272_000);
    assert.match(String(teachers.said), /^Control sent a model for the teachers to rig-a\./);
    const agents = teachers.agents as Record<string, { model: string } | null> & {
      teachers: { models: { model: string }[] };
    };
    assert.equal(agents.teachers.models[0]?.model, "gpt-sol");
    assert.equal(agents.workers?.model, "wide-model", "the workers keep theirs");
    assert.equal(agents.planner, null);
    const audit = s.store.auditLog.list(5, { action: "agent_model_given" })[0];
    assert.equal(audit?.actor, "owner:operator");

    // An advisor's own cap and point (goal 070); one above the provider's window is refused.
    const capped = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: {
          rig: "rig-a",
          agent: "teachers",
          provider: "lab",
          model: "strong-model",
          context_window: 65_536,
          compact_at: 75,
        },
      }),
    );
    assert.equal(capped.context_window, 65_536);
    assert.equal(capped.compact_at, 75);
    assert.match(
      String(capped.said),
      /Its context window: 65,536 tokens \(capped; the provider allows 400,000\)\. Its conversations are compacted at 75% of the window\./,
    );
    const over = await operator.callTool({
      name: "set_rig_model",
      arguments: {
        rig: "rig-a",
        agent: "teachers",
        second_model: { provider: "lab", model: "strong-model", context_window: 500_000 },
      },
    });
    assert.equal(over.isError, true);
    assert.match(JSON.stringify(over), /strong-model takes at most 400,000 tokens\./);
    const unknown = await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", agent: "judge", provider: "lab", model: "wide-model" },
    });
    assert.equal(unknown.isError, true);
    assert.equal(
      s.store.agentModels.byRole("rig-a").teachers?.contextCap,
      65_536,
      "kept, not refused",
    );
    assert.equal(s.store.agentModels.byRole("rig-a").second_teacher, undefined);
    // Two teachers and a merged by model over MCP, as over REST.
    const two = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: {
          rig: "rig-a",
          agent: "teachers",
          second_model: { provider: "sub", model: "gpt-sol" },
          merged_by: { provider: "lab", model: "wide-model" },
        },
      }),
    );
    const twoAgents = two.agents as {
      teachers: { models: { model: string }[]; merged_by: { model: string } | null };
    };
    assert.deepEqual(
      twoAgents.teachers.models.map((m) => m.model),
      ["strong-model", "gpt-sol"],
    );
    assert.equal(twoAgents.teachers.merged_by?.model, "wide-model");

    const cleared = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", agent: "teachers", clear: true },
      }),
    );
    assert.equal(cleared.model, null);
    assert.match(String(cleared.said), /the teachers back to the rig's advisors file/);
    const read = text(await operator.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.deepEqual((read.agents as Record<string, unknown>).teachers, {
      models: [],
      merged_by: null,
    });
    assert.equal((read.agents as Record<string, { model: string }>).workers?.model, "wide-model");
    await operator.close();

    const reader = await mcpClient(s.api, TOKENS.read);
    const tools = (await reader.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("rig_models"));
    assert.ok(!tools.includes("set_rig_model"));
    const seen = text(await reader.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.equal((seen.agents as Record<string, { model: string }>).workers?.model, "wide-model");
    const none = await reader.callTool({ name: "rig_models", arguments: { rig: "rig-z" } });
    assert.equal(none.isError, true);
    assert.match(JSON.stringify(none), /no rig rig-z/);
    await reader.close();
  });
});
